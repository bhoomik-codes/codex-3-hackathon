/**
 * GuardSaaB Engine — the long-running process.
 *
 * Responsibilities:
 *   • POST /intercept — the dumb hook posts a tool call and HOLDS the socket open.
 *                       ALLOW/BLOCK return immediately; HITL holds until a human
 *                       decides, the TTL fires, or the socket closes.
 *   • WebSocket /ws   — streams pending violations to the dashboard and receives
 *                       Approve/Deny decisions back.
 *   • GET  /health, GET /pending, POST /decision — REST surface (health, hydration,
 *                       and a dashboard-less fallback used by the smoke test).
 *
 * The open HTTP socket itself is the synchronous hold. No polling, no Redis.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { JsonLogicPolicyEngine, type PolicyEngine } from '../policy/engine.js';
import { InMemoryPendingStore } from '../policy/store.js';
import { InMemoryBehavioralMonitor, type AnomalyConfig, type BehavioralMonitor } from '../signals/behavioral.js';
import {
  InMemoryContaminationMonitor,
  type ContaminationMonitor,
  type ContentConfig,
} from '../signals/content.js';
import {
  DisabledInjectionClassifier,
  loadInjectionClassifier,
  type InjectionClassifier,
  type InjectionConfig,
} from '../signals/injection.js';
import { WeightedRiskEngine, type RiskEngine } from '../risk/engine.js';
import { IocStore, hostOf } from '../signals/ioc.js';
import { AuditLog } from '../audit/index.js';
import { sanitizeAuditPayload, sanitizedAuditExport } from '../audit/sanitize.js';
import { AuditStore, type AuthAccount, type AuthenticatedUser } from '../db/audit-store.js';
import { projectTimeline, summarizeSessions } from '../audit/projector.js';
import { classify } from '../taxonomy/index.js';
import type {
  AuditEntry,
  DashboardToServer,
  FinalAction,
  HitlResolution,
  InspectRequest,
  MCPToolCall,
  RiskBand,
  SecurityViolation,
  ServerToDashboard,
  SessionEvent,
} from '../contract/types.js';

export interface EngineOptions {
  port: number;
  rulesPath: string;
  auditFile: string;
  ttlMs: number;
  behavioral: AnomalyConfig;
  content: ContentConfig;
  injection: InjectionConfig;
  weightsPath: string;
  /** If set, serve the built dashboard (static files) from this dir at `/` (D20). */
  staticDir?: string;
  /**
   * Where a held (HITL) call is approved (M4-C). 'terminal' (default) ⇒ return ASK so Claude Code
   * prompts the user natively in the terminal — no socket hold. 'dashboard' ⇒ hold the socket and
   * resolve via the dashboard / `guardsaab approve`.
   */
  approvalSurface?: 'terminal' | 'dashboard';
  /** Auto-open the investigation UI on severe verdicts (M4-C, D39). 'block' ⇒ on BLOCK/EXFIL; 'off' ⇒ never. */
  autoOpen?: 'block' | 'off';
  /** Opener injection seam (tests pass a spy); defaults to the platform browser-opener. */
  opener?: (url: string) => void;
  /** Optional PostgreSQL backing store for the local company demo and GuardSaaB audit chain. */
  databaseUrl?: string;
  stateDir?: string;
  authAccounts?: AuthAccount[];
}

const AUTO_OPEN_WINDOW_MS = 30_000; // don't reopen the same session's tab more than once per window

export class Engine {
  private readonly startedAt = Date.now();
  private readonly policy: PolicyEngine;
  private readonly behavioral: BehavioralMonitor;
  private readonly contamination: ContaminationMonitor;
  private readonly risk: RiskEngine;
  private injection: InjectionClassifier = new DisabledInjectionClassifier();
  private readonly store = new InMemoryPendingStore();
  private readonly lastOpened = new Map<string, number>(); // session → last auto-open ts (rate-limit)
  private readonly audit: AuditLog;
  private auditStore?: AuditStore;
  private readonly inMemoryAccounts = new Map<string, AuthAccount>();
  private readonly inMemorySessions = new Map<string, { token: string; user: AuthenticatedUser; site: 'company' | 'guardsaab'; expiresAt: number }>();
  private readonly webTokens = new Map<string, { site: 'company' | 'guardsaab'; user: AuthenticatedUser }>();
  private readonly loginFailures = new Map<string, { count: number; startedAt: number }>();
  private readonly ioc: IocStore;
  /** Shared synthetic people/fund state for the company and GuardSaaB demo clients. */
  private companyDemoState: unknown = null;
  private readonly clients = new Set<WebSocket>();
  private readonly http = createServer((req, res) => this.route(req, res));
  // verifyClient rejects the CSWSH vector: a browser on a malicious page can open a WebSocket to our
  // loopback port (WS is exempt from same-origin/CORS), and our /ws both leaks pending tool inputs and
  // accepts `decision` frames that auto-approve a held call. So we gate the handshake on Origin — see
  // originAllowed: present-and-non-loopback Origins are refused; absent Origin (non-browser clients) is fine.
  private readonly wss = new WebSocketServer({
    server: this.http,
    path: '/ws',
    verifyClient: (info: { req: IncomingMessage }) => this.verifyWebSocket(info.req),
  });

  constructor(private readonly opts: EngineOptions) {
    this.policy = new JsonLogicPolicyEngine(opts.rulesPath);
    this.behavioral = new InMemoryBehavioralMonitor(opts.behavioral);
    this.contamination = new InMemoryContaminationMonitor(opts.content);
    this.risk = new WeightedRiskEngine(opts.weightsPath);
    this.audit = new AuditLog(opts.auditFile);
    if (opts.authAccounts) {
      for (const account of opts.authAccounts) {
        this.inMemoryAccounts.set(account.username.toLowerCase(), account);
      }
    }
    if (opts.databaseUrl) this.auditStore = new AuditStore(opts.databaseUrl, opts.stateDir ?? dirname(opts.auditFile));
    this.ioc = new IocStore(join(dirname(opts.auditFile), 'ioc.json')); // L1 refreshable IOC feed (guardsaab feeds refresh)

    // fan out store lifecycle to every connected dashboard
    this.store.on('registered', (v: SecurityViolation) => this.broadcast({ type: 'violation', violation: v }));
    this.store.on('resolved', (id: string, action: FinalAction) =>
      this.broadcast({ type: 'resolved', violationId: id, action }),
    );

    this.wss.on('connection', (ws, req) => this.onDashboardConnect(ws, req));
    // ws re-emits http server errors (e.g. EADDRINUSE) on the wss; without a handler that's an
    // unhandled 'error' crash that pre-empts listen()'s clean rejection path. Swallow here — the
    // same error still rejects listen() via the http 'error' listener.
    this.wss.on('error', () => {});
  }

  async listen(): Promise<void> {
    // Resolve the injection classifier (D13): the ONNX companion package if installed, else the
    // always-on heuristic baseline, else disabled. Done here so a slow model load doesn't block import.
    this.injection = await loadInjectionClassifier(this.opts.injection);
    if (this.auditStore) {
      try {
        await this.auditStore.initialize();
        await this.auditStore.seedAccounts(this.opts.authAccounts ?? []);
        await this.auditStore.importGatewayHistory(this.audit.read());
      } catch (err) {
        await this.auditStore.close().catch(() => undefined);
        throw new Error(`PostgreSQL initialization failed; refusing to start with a different persistence backend: ${(err as Error).message}`);
      }
    }
    // Bind to loopback only — the approval surface (/decision) is unauthenticated by design for the
    // local single-user tier, so it must never be reachable from the LAN. Reject on listen errors
    // (e.g. EADDRINUSE) instead of hanging: a gateway the user *thinks* is running is worse than none.
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.opts.port, '127.0.0.1', () => {
        this.http.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** Name of the resolved injection classifier ('onnx' / 'heuristic' / 'disabled') — for the CLI banner. */
  get injectionClassifier(): string {
    return this.injection.name;
  }

  /** Version of the loaded risk-weights config — for the CLI banner + drift traceability. */
  get riskVersion(): string {
    return this.risk.version;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) client.close(1001, 'engine shutting down');
      this.wss.close();
      this.http.close(() => { void this.auditStore?.close().finally(resolve); if (!this.auditStore) resolve(); });
    });
  }

  /* ------------------------------- HTTP routing ------------------------------- */

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        let database: 'connected' | 'disabled' | 'unavailable' = this.auditStore ? 'connected' : 'disabled';
        if (this.auditStore) { try { await this.auditStore.probe(); } catch { database = 'unavailable'; } }
        return json(res, database === 'unavailable' ? 503 : 200, {
          ok: database !== 'unavailable', ready: database !== 'unavailable',
          service: 'guardsaab-engine', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
          pendingApprovals: this.store.pending().length, approvalSurface: this.opts.approvalSurface ?? 'terminal',
          auditStorage: database, policy: 'loaded', injectionClassifier: this.injection.name,
          endpoints: { host: '127.0.0.1', port: this.opts.port },
          recovery: database === 'unavailable'
            ? 'Restore PostgreSQL connectivity, preserve the audit key and checkpoint files, then restart the engine.'
            : database === 'disabled' ? 'For durable shared state, start PostgreSQL and run npm run engine:local.' : null,
        });
      }
      if (req.method === 'GET' && req.url === '/policies') {
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        const rules = this.policy.listRules();
        return json(res, 200, { default: 'HITL', count: rules.length, rules });
      }
      if (req.method === 'GET' && req.url?.startsWith('/activity')) {
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        const limit = Math.min(500, Math.max(1, Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('limit') ?? 100) || 100));
        const entries = this.audit.read().slice(-limit).reverse().map((entry) => sanitizeAuditPayload(entry));
        return json(res, 200, { entries });
      }
      if (req.url?.startsWith('/auth/')) return await this.handleAuth(req, res);
      if (req.url?.startsWith('/company-demo-state') && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST')) {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        const requestedWorkspace = new URL(req.url, 'http://127.0.0.1').searchParams.get('site');
        if (requestedWorkspace && requestedWorkspace !== 'company' && requestedWorkspace !== 'guardsaab') return json(res, 400, { error: 'Choose a valid company workspace.' });
        const preferredWorkspace: 'company' | 'guardsaab' = requestedWorkspace === 'company'
          ? 'company'
          : requestedWorkspace === 'guardsaab' ? 'guardsaab' : workspaceFromRequest(req);
        const site: 'company' | 'guardsaab' = preferredWorkspace;
        const auth = site === 'company' ? await this.getWebSession(req, 'company') : await this.getWebSession(req, 'guardsaab');
        if (!auth) return json(res, 401, { error: 'Sign in to access company records.' });
        if (req.method === 'POST' && req.url.split('?')[0] === '/company-demo-state/request') {
          if (site !== 'company' || auth.role !== 'Employee' || !auth.employeeId) return json(res, 403, { error: 'Only a signed-in employee can submit a fund request.' });
          const employeeId = auth.employeeId;
          const body = await readJson<{ amount?: unknown; purpose?: unknown; kind?: unknown }>(req);
          const amount = Number(body.amount);
          const purpose = typeof body.purpose === 'string' ? body.purpose.trim().replace(/\s+/g, ' ') : '';
          const kind = body.kind === 'QUOTA_INCREASE' ? 'QUOTA_INCREASE' : body.kind === 'FUND_TRANSFER' ? 'FUND_TRANSFER' : '';
          if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_000_000 || !purpose || purpose.length > 300 || !kind) {
            return json(res, 400, { error: 'Enter an amount from ₹1 to ₹20,00,000 and a company purpose of 300 characters or fewer.' });
          }
          let submittedRequest: Record<string, unknown> | null = null;
          let duplicate = false;
          const createRequest = (currentValue: unknown | null) => {
            const current = (currentValue ?? initialCompanyState()) as CompanyStateShape;
            const employees = (current.employees ?? []).map((employee) => ({ ...employee }));
            const employee = employees.find((item) => String(item.id) === employeeId);
            if (!employee) throw new Error('Your employee record is unavailable. No request was created.');
            const normalizePurpose = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            const requests = [...(current.requests ?? [])];
            const matching = requests.filter((item) => String(item.employeeId) === employeeId
              && item.kind === kind && Number(item.amount) === amount
              && normalizePurpose(item.purpose) === normalizePurpose(purpose));
            const existing = matching.find((item) => item.status === 'APPROVED')
              ?? matching.find((item) => item.status === 'PENDING_HR' || item.status === 'PENDING_CEO')
              ?? matching.find((item) => Date.now() - Number(item.createdAt) >= 0 && Date.now() - Number(item.createdAt) <= 10 * 60_000);
            if (existing) {
              duplicate = true;
              submittedRequest = existing;
              return current;
            }

            const now = Date.now();
            const available = Math.max(0, Number(employee.fundsRemaining ?? 0) - requests
              .filter((item) => String(item.employeeId) === employeeId && item.kind !== 'QUOTA_INCREASE'
                && (item.status === 'PENDING_HR' || item.status === 'PENDING_CEO'))
              .reduce((sum, item) => sum + Number(item.amount ?? 0), 0));
            let status: string;
            if (kind === 'QUOTA_INCREASE') status = amount > 200_000 ? 'PENDING_CEO' : 'PENDING_HR';
            else if (amount <= 50_000 && amount <= available) status = 'APPROVED';
            else if (amount <= 50_000) status = 'REJECTED';
            else if (amount > 100_000) status = 'PENDING_CEO';
            else status = 'PENDING_HR';

            const id = `FND-${new Date(now).getFullYear()}-${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
            const request: Record<string, unknown> = { id, employeeId, amount, purpose, kind, status, createdAt: now };
            const ledger = [...(current.ledger ?? [])];
            const events = [...(current.events ?? [])];
            const addEvent = (actor: string, action: string, detail: string, outcome: string) => events.unshift({ id: `evt-${randomUUID()}`, time: now, actor, action, detail, outcome, requestId: id });
            if (status === 'APPROVED') {
              const transactionId = `NSTAR-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
              request['approvalBy'] = 'Company policy';
              request['transactionId'] = transactionId;
              employee['fundsRemaining'] = available - amount;
              ledger.unshift({ id: transactionId, employeeId, amount, purpose, time: now, requestId: id });
              addEvent('Northstar Accounts', 'Company funds credited', `${amount} INR · ${transactionId}`, 'COMPLETED');
            } else if (status === 'REJECTED') {
              addEvent('Company policy', 'Transfer blocked', `Only ${available} INR remains after pending requests`, 'BLOCKED');
            } else {
              const destination = status === 'PENDING_CEO' ? 'CEO' : 'HR';
              addEvent(`Zeo · Finance Agent`, kind === 'QUOTA_INCREASE' ? 'Additional fund quota requested' : 'Account credit attempted', `${amount} INR for ${String(employee.name ?? auth.employeeId)} · ${purpose}`, `HELD · ${destination}`);
              addEvent('Company policy', kind === 'QUOTA_INCREASE' ? 'Quota increase held for human review' : 'Transfer intercepted before ledger write', 'No account balance or available quota changed before approval.', `PENDING · ${destination}`);
            }
            requests.unshift(request);
            submittedRequest = request;
            return { ...current, employees, requests, ledger, events };
          };
          if (this.auditStore) this.companyDemoState = await this.auditStore.updateCompanyState(createRequest);
          else this.companyDemoState = createRequest(this.companyDemoState);
          return json(res, 200, { state: scopeCompanyState(this.companyDemoState, auth, site), request: submittedRequest, duplicate });
        }
        if (req.method === 'POST' && req.url.split('?')[0] === '/company-demo-state/decision') {
          const body = await readJson<{ requestId?: unknown; decision?: unknown }>(req);
          const requestId = typeof body.requestId === 'string' ? body.requestId : '';
          const decision = body.decision === 'approve' ? 'APPROVED' : body.decision === 'reject' ? 'REJECTED' : '';
          if (!requestId || !decision) return json(res, 400, { error: 'A request ID and approve or reject decision are required.' });
          let alreadyDecided = false;
          let duplicateBlocked = false;
          const applyDecision = (currentValue: unknown | null) => {
            const current = (currentValue ?? initialCompanyState()) as CompanyStateShape;
            const request = (current.requests ?? []).find((item) => String(item.id) === requestId);
            if (!request) throw new Error('This request no longer exists. Refresh the approval queue.');
            if (request.status === decision) { alreadyDecided = true; return current; }
            if (request.status !== 'PENDING_HR' && request.status !== 'PENDING_CEO') throw new Error(`This request is already ${String(request.status).toLowerCase()}. Refresh the approval queue.`);
            const employeeId = String(request.employeeId ?? '');
            const allowed = scopedEmployeeIds(current, auth, site);
            if ((auth.role !== 'HR' && auth.role !== 'CEO') || !allowed.has(employeeId)) throw new Error('Your signed-in role cannot decide this request.');
            if (request.status === 'PENDING_CEO' && auth.role !== 'CEO') throw new Error(`This request requires CEO review. The server session is ${auth.role} (${auth.displayName}); refresh the page or sign in as CEO.`);
            const cap = request.kind === 'QUOTA_INCREASE' ? 200_000 : 100_000;
            if (auth.role === 'HR' && Number(request.amount) > cap) throw new Error('This request exceeds the HR approval limit and requires CEO review.');
            const normalizePurpose = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            const duplicateOf = decision === 'APPROVED' && request.kind !== 'QUOTA_INCREASE'
              ? (current.requests ?? []).find((item) => String(item.id) !== requestId
                && String(item.employeeId) === employeeId && item.kind !== 'QUOTA_INCREASE'
                && Number(item.amount) === Number(request.amount)
                && normalizePurpose(item.purpose) === normalizePurpose(request.purpose)
                && item.status === 'APPROVED')
              : undefined;
            const appliedStatus = duplicateOf ? 'REJECTED' : decision;
            const proposed = {
              ...current,
              requests: (current.requests ?? []).map((item) => String(item.id) === requestId
                ? { ...item, status: appliedStatus, approvalBy: auth.role }
                : item),
            };
            let updated = mergeScopedCompanyState(current, proposed, auth, site) as CompanyStateShape;
            if (duplicateOf) {
              duplicateBlocked = true;
              const now = Date.now();
              const event = { id: `evt-${randomUUID()}`, time: now, actor: `${auth.role} · ${auth.displayName}`, action: 'Duplicate fund request blocked', detail: `Request matches already approved ${String(duplicateOf.id)}. No additional funds were credited.`, outcome: 'BLOCKED', requestId };
              updated = {
                ...updated,
                requests: (updated.requests ?? []).map((item) => String(item.id) === requestId
                  ? { ...item, duplicateOf: String(duplicateOf.id), blockedReason: 'An identical request has already been approved.' }
                  : item),
                events: [event, ...(updated.events ?? [])],
              };
            }
            const saved = (updated.requests ?? []).find((item) => String(item.id) === requestId);
            if (saved?.status !== appliedStatus) throw new Error('The decision did not pass company policy. The request remains pending.');
            return updated;
          };
          if (this.auditStore) this.companyDemoState = await this.auditStore.updateCompanyState(applyDecision);
          else this.companyDemoState = applyDecision(this.companyDemoState);
          return json(res, 200, { state: scopeCompanyState(this.companyDemoState, auth, site), persistence: this.auditStore ? 'postgresql' : 'memory', alreadyDecided, duplicateBlocked });
        }
        if (req.method === 'POST') return json(res, 404, { error: 'Unknown company state action.' });
        if (req.method === 'PUT') {
          const nextState = await readJson<unknown>(req);
          if (this.auditStore) {
            this.companyDemoState = await this.auditStore.updateCompanyState((current) =>
              mergeScopedCompanyState(current ?? initialCompanyState(), nextState, auth, site),
            );
          } else {
            this.companyDemoState = mergeScopedCompanyState(this.companyDemoState ?? initialCompanyState(), nextState, auth, site);
          }
        } else if (this.auditStore) {
          this.companyDemoState = await this.auditStore.readCompanyState();
          if (!this.companyDemoState) {
            this.companyDemoState = await this.auditStore.updateCompanyState((current) => current ?? initialCompanyState());
          }
        } else {
          this.companyDemoState ??= initialCompanyState();
        }
        return json(res, 200, { state: scopeCompanyState(this.companyDemoState, auth, site), persistence: this.auditStore ? 'postgresql' : 'memory' });
      }
      if (req.method === 'GET' && req.url === '/audit-chain') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        if (!this.auditStore) return json(res, 200, { status: { enabled: false, verified: false, count: 0, headHash: null, checkpointSeq: 0, checkedAt: new Date().toISOString() }, entries: [] });
        const [status, entries] = await Promise.all([this.auditStore.status(), this.auditStore.recent()]);
        return json(res, 200, { status, entries: entries.map((entry) => ({ ...entry, payload: sanitizeAuditPayload(entry.payload) })) });
      }
      if (req.method === 'GET' && req.url === '/audit-chain/export') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        if (!this.auditStore) return json(res, 503, { error: 'PostgreSQL audit storage is not enabled.' });
        const exported = sanitizedAuditExport(await this.auditStore.recent());
        res.setHeader('content-disposition', 'attachment; filename="guardsaab-audit-sanitized.json"');
        return json(res, 200, exported);
      }
      if (req.method === 'POST' && req.url === '/audit-chain/verify') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        if (!this.auditStore) return json(res, 503, { error: 'PostgreSQL audit storage is not enabled.' });
        return json(res, 200, { status: await this.auditStore.verify() });
      }
      if (req.method === 'POST' && req.url === '/ollama/chat') {
        return await this.handleOllamaChat(req, res);
      }
      if (req.method === 'GET' && req.url === '/ollama/tags') {
        return await this.handleOllamaTags(req, res);
      }
      if (req.method === 'GET' && req.url === '/pending') {
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        return json(res, 200, { pending: this.store.pending() });
      }
      if (req.method === 'POST' && req.url === '/decision') {
        // Same sink as /ws (resolveContext auto-approves a held call) — gate cross-origin browsers out
        // (defense-in-depth alongside the missing-CORS-handler preflight that already blocks JSON POSTs).
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        const body = await readJson<DashboardToServer>(req);
        if (body?.type !== 'decision' || typeof body.violationId !== 'string' || !body.violationId || (body.action !== 'ALLOW' && body.action !== 'BLOCK')) return json(res, 400, { error: 'A pending request ID and ALLOW or BLOCK decision are required.' });
        await this.store.resolveContext(body.violationId, body.action);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/intercept') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        return await this.handleIntercept(req, res);
      }
      if (req.method === 'POST' && req.url === '/inspect') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        return await this.handleInspect(req, res);
      }
      if (req.method === 'POST' && req.url === '/session') {
        if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        return await this.handleSession(req, res);
      }
      // Investigation history (D25): project the replayed audit log into session rollups / a timeline.
      // O(log size) per request — fine for the local single-engine tier; the paid tier would index.
      if (req.method === 'GET' && req.url === '/sessions') {
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        return json(res, 200, { sessions: summarizeSessions(this.audit.read()) });
      }
      if (req.method === 'GET' && req.url?.startsWith('/sessions/')) {
        if (req.headers.origin && !(await this.getWebSession(req, 'guardsaab'))) return json(res, 401, { error: 'GuardSaaB sign-in required.' });
        const m = /^\/sessions\/([^/]+)\/timeline\/?$/.exec(req.url.split('?')[0] ?? '');
        if (m) return json(res, 200, projectTimeline(this.audit.read(), decodeURIComponent(m[1] as string)));
      }
      if (req.method === 'GET' && (req.url === '/architecture' || req.url === '/architecture.html')) {
        const archPath = join(process.cwd(), 'docs', 'architecture.html');
        if (existsSync(archPath)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(archPath));
          return;
        }
      }
      if (req.method === 'GET' && (req.url === '/flowchart' || req.url === '/architecture-flowchart.html')) {
        const flowPath = join(process.cwd(), 'docs', 'architecture-flowchart.html');
        if (existsSync(flowPath)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(readFileSync(flowPath));
          return;
        }
      }
      // The dashboard (static) is served LAST, so it never shadows an API route (D20).
      if (req.method === 'GET' && this.opts.staticDir) {
        return this.serveStatic(req, res);
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const requestedSite = url.searchParams.get('site');
    if (requestedSite !== 'company' && requestedSite !== 'guardsaab') return json(res, 400, { error: 'Choose a valid sign-in workspace.' });
    const site = requestedSite;
    const cookieName = site === 'company' ? 'northstar_session' : 'guardsaab_session';
    const token = cookieValue(req, cookieName);
    if (req.method === 'GET' && url.pathname === '/auth/session') {
      let user: AuthenticatedUser | null = null;
      if (this.auditStore) {
        user = await this.auditStore.session(token, site);
      } else if (token) {
        const sess = this.inMemorySessions.get(token);
        if (sess && sess.site === site && sess.expiresAt > Date.now()) user = sess.user;
      }
      if (user && token) this.webTokens.set(token, { site, user });
      return json(res, 200, { user });
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const body = await readJson<{ username?: unknown; password?: unknown }>(req);
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username.trim() || !body.password) return json(res, 400, { error: 'Enter your username and password.' });
      const key = `${req.socket.remoteAddress ?? 'local'}:${site}:${body.username.toLowerCase()}`;
      const failures = this.loginFailures.get(key);
      if (failures && failures.count >= 5 && Date.now() - failures.startedAt < 15 * 60_000) return json(res, 429, { error: 'Too many attempts. Wait 15 minutes before trying again.' });
      let result: { token: string; user: AuthenticatedUser } | null = null;
      if (this.auditStore) {
        result = await this.auditStore.login(body.username, body.password, site);
      } else {
        const account = this.inMemoryAccounts.get(body.username.trim().toLowerCase());
        if (account && account.password === body.password && !(site === 'guardsaab' && account.role === 'Employee')) {
          const sessionToken = randomUUID();
          const user: AuthenticatedUser = { username: account.username, displayName: account.displayName, role: account.role, ...(account.employeeId ? { employeeId: account.employeeId } : {}) };
          this.inMemorySessions.set(sessionToken, { token: sessionToken, user, site, expiresAt: Date.now() + 12 * 3600_000 });
          result = { token: sessionToken, user };
        }
      }
      if (!result) {
        if (!failures || Date.now() - failures.startedAt >= 15 * 60_000) this.loginFailures.set(key, { count: 1, startedAt: Date.now() });
        else failures.count++;
        await this.auditStore?.appendAuth({ action: 'sign-in denied', username: body.username.trim().toLowerCase(), site, time: Date.now() });
        return json(res, 401, { error: 'The username or password is incorrect.' });
      }
      this.loginFailures.delete(key);
      this.webTokens.set(result.token, { site, user: result.user });
      await this.auditStore?.appendAuth({ action: 'sign-in', username: result.user.username, displayName: result.user.displayName, role: result.user.role, site, time: Date.now() });
      res.setHeader('set-cookie', `${cookieName}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
      return json(res, 200, { user: result.user });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      let user: AuthenticatedUser | null = null;
      if (this.auditStore) {
        user = await this.auditStore.session(token, site);
        await this.auditStore.logout(token, site);
      } else if (token) {
        const sess = this.inMemorySessions.get(token);
        if (sess) { user = sess.user; this.inMemorySessions.delete(token); }
      }
      if (token) this.webTokens.delete(token);
      if (user) await this.auditStore?.appendAuth({ action: 'sign-out', username: user.username, displayName: user.displayName, role: user.role, site, time: Date.now() });
      res.setHeader('set-cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  }

  private async getWebSession(req: IncomingMessage, site: 'company' | 'guardsaab'): Promise<AuthenticatedUser | null> {
    const token = site === 'company'
      ? cookieValue(req, 'northstar_session')
      : cookieValue(req, 'guardsaab_session');
    let user: AuthenticatedUser | null = null;
    if (this.auditStore) {
      user = await this.auditStore.session(token, site);
    } else if (token) {
      const sess = this.inMemorySessions.get(token);
      if (sess && sess.site === site && sess.expiresAt > Date.now()) user = sess.user;
    }
    if (token && user) this.webTokens.set(token, { site, user });
    return user;
  }

  private async getAnyWebSession(req: IncomingMessage): Promise<AuthenticatedUser | null> {
    return await this.getWebSession(req, 'company') ?? await this.getWebSession(req, 'guardsaab');
  }

  /** Local-only Ollama bridge: keeps browser CORS configuration out of the demo setup. */
  private async handleOllamaChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
    if (!(await this.getWebSession(req, 'company'))) return json(res, 401, { error: 'Northstar sign-in required.' });
    const endpoint = this.localOllamaEndpoint();
    if (!endpoint) return json(res, 400, { error: 'Ollama must use a local HTTP address' });
    const body = await readJson<Record<string, unknown>>(req);
    if (typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return json(res, 400, { error: 'model and messages are required' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(new URL('/api/chat', endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: false }),
        signal: controller.signal,
      });
      const text = await response.text();
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
    } catch (error) {
      json(res, 502, { error: (error as Error).name === 'AbortError' ? 'Ollama request timed out' : 'Ollama is unavailable. Start Ollama and load the selected model.' });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleOllamaTags(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
    if (!(await this.getWebSession(req, 'company'))) return json(res, 401, { error: 'Northstar sign-in required.' });
    const endpoint = this.localOllamaEndpoint();
    if (!endpoint) return json(res, 400, { error: 'Ollama must use a local HTTP address' });
    try {
      const response = await fetch(new URL('/api/tags', endpoint), { signal: AbortSignal.timeout(5000) });
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(await response.text());
    } catch {
      json(res, 502, { error: 'Ollama is unavailable. Start Ollama and load a local model.' });
    }
  }

  private localOllamaEndpoint(): URL | null {
    try {
      const endpoint = new URL(process.env.GUARDSAAB_OLLAMA_URL ?? 'http://127.0.0.1:11434');
      const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
      return endpoint.protocol === 'http:' && localHosts.has(endpoint.hostname) ? endpoint : null;
    } catch { return null; }
  }

  /** The synchronous hold + multi-signal decision pipeline (PreToolUse). */
  private async handleIntercept(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const call = await readJson<MCPToolCall>(req);
    call.sessionId = effectiveSession(call.sessionId, call.cwd); // M4: don't bucket distinct sessionless agents together
    const requestId = randomUUID(); // one id per tool-call decision; links its lifecycle events (D24)
    const category = classify(call.tool);

    // Run all three signals (each has side effects — behavioral records the call, content records
    // path-risk), then fold them into one decision via strictest-wins (D7).
    const anomaly = this.behavioral.record(call); // Signal 1: runaway / loop
    const policy = this.policy.evaluate(call); //     Signal 2: deterministic rules
    const content = this.contamination.evaluate(call); // Signal 3: contamination / exfil
    // M3c: aggregate the three into one risk-scored decision (hard floor + weighted bands).
    const decision = this.risk.assess(policy, anomaly, content);
    let { action, reason } = decision;
    const { ruleId, signal, risk } = decision;

    // L1: refreshed IOC feed (guardsaab feeds refresh) — a destination host on a known-bad feed is blocked
    // outright; a softer/young-domain hit escalates an otherwise-ALLOW egress to human review. Works for any
    // call carrying a URL/host (native EGRESS tool OR a Bash curl/wget), not just the EGRESS category.
    if (this.ioc.loaded) {
      const iocHost = hostOf(egressTarget(call));
      const iocHit = iocHost ? this.ioc.check(iocHost) : null;
      if (iocHit === 'block' && action !== 'BLOCK') {
        action = 'BLOCK';
        reason = `Destination ${iocHost} is on a GuardSaaB IOC feed — blocked.`;
        // keep the audit record self-consistent: band, score, and a driver factor all reflect the override
        risk.band = 'BLOCK';
        risk.score = Math.max(risk.score, this.risk.blockScore);
        risk.factors.push({ source: 'policy', label: 'ioc-feed', points: this.risk.blockScore, group: 'egress' });
      } else if (iocHit === 'hitl' && action === 'ALLOW') {
        action = 'HITL';
        reason = `Destination ${iocHost} flagged by an IOC / young-domain feed — held for review.`;
        risk.band = 'HITL';
        risk.score = Math.max(risk.score, this.risk.hitlScore);
        risk.factors.push({ source: 'policy', label: 'ioc-feed', points: this.risk.hitlScore, group: 'egress' });
      }
    }

    const base = { sessionId: call.sessionId, requestId, tool: call.tool, input: call.input, category, ruleId, signal, risk };

    // Auto paths: answer immediately. (AUDIT band collapses to ALLOW for the agent — D17 — but the
    // audit record carries risk.band='AUDIT' so it surfaces as elevated-risk on the dashboard.)
    if (action === 'ALLOW' || action === 'BLOCK') {
      await this.writeAudit({ ...base, event: 'decision', action, reason, viaHitl: false });
      if (action === 'BLOCK') this.maybeAutoOpen(call.sessionId, risk.band);
      return json(res, 200, { action, ruleId, reason, band: risk.band, sessionId: call.sessionId });
    }

    // HITL — terminal/ASK surface: don't hold. Return ASK so the adapter can defer to the agent's NATIVE
    // in-tool permission prompt (M4-C/M5). The mode is chosen by the agent's adapter (approvalMode) since
    // not every agent supports a native prompt; absent ⇒ fall back to the engine's configured surface.
    const askMode = call.approvalMode ? call.approvalMode === 'ask' : (this.opts.approvalSurface ?? 'terminal') === 'terminal';
    if (askMode) {
      await this.writeAudit({ ...base, event: 'hitl-opened', reason });
      return json(res, 200, { action: 'ASK', ruleId, reason, band: risk.band, sessionId: call.sessionId });
    }

    // HITL — dashboard surface: build a violation, hold the socket, and wait for a verdict.
    const violation: SecurityViolation = {
      id: requestId,
      toolCall: call,
      category,
      ruleId,
      reason,
      createdAt: Date.now(),
      ttlMs: this.opts.ttlMs,
      signal,
      risk,
    };

    let settled = false;
    // If the agent/hook goes away mid-hold, free the held context instead of leaking it.
    // `res` 'close' fires when the connection closes; guard with `settled` so the normal
    // post-response close is a no-op.
    res.on('close', () => {
      if (!settled) void this.store.cleanup(violation.id);
    });

    await this.writeAudit({ ...base, event: 'hitl-opened', reason });
    const result = await this.store.registerContext(violation, this.opts.ttlMs);
    settled = true;

    // The store only ever resolves a hold to ALLOW/BLOCK (never ASK) — narrow for the audit/verdict.
    const resolved = result.action as FinalAction;
    await this.writeAudit({
      ...base,
      event: 'hitl-resolved',
      action: resolved,
      reason: result.reason,
      viaHitl: true,
      resolution: resolutionOf(resolved, result.reason),
      latencyMs: Date.now() - violation.createdAt,
    });
    if (resolved === 'BLOCK') this.maybeAutoOpen(call.sessionId, risk.band);
    if (!res.writableEnded) json(res, 200, { ...result, band: risk.band, sessionId: call.sessionId });
  }

  /**
   * Auto-open the investigation UI on a severe verdict (M4-C, D39). Engine-side so it can dedup/rate-
   * limit centrally — a burst of BLOCKs in one session opens at most one tab per window. Best-effort:
   * a failed opener never affects enforcement.
   */
  private maybeAutoOpen(sessionId: string | undefined, band: RiskBand): void {
    if ((this.opts.autoOpen ?? 'off') !== 'block') return;
    if (band !== 'BLOCK') return; // BLOCK band covers exfil/injection blocks (their score florors here)
    const sid = sessionId ?? 'default';
    const now = Date.now();
    const last = this.lastOpened.get(sid) ?? 0;
    if (now - last < AUTO_OPEN_WINDOW_MS) return;
    this.lastOpened.set(sid, now);
    const url = `http://127.0.0.1:${this.opts.port}/?session=${encodeURIComponent(sid)}`;
    try {
      (this.opts.opener ?? defaultOpener)(url);
    } catch {
      /* best-effort */
    }
  }

  /**
   * PostToolUse inspection (D2/D9). Observe-only: update the session's contamination state from the
   * executed tool's result, never modify the result. The hook waits only for this state-commit.
   */
  private async handleInspect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<InspectRequest>(req);
    const call: MCPToolCall = { tool: body.tool, input: body.input ?? {}, sessionId: effectiveSession(body.sessionId, body.cwd) };

    // A failed tool produced no result to scan — record the failure for the timeline and stop (D23).
    if (body.error) {
      await this.writeAudit({
        event: 'tool-failed',
        sessionId: body.sessionId,
        tool: body.tool,
        category: classify(body.tool),
        reason: body.error.slice(0, 500),
      });
      return json(res, 200, { ok: true, failed: true });
    }

    const text = body.toolResponse ?? '';
    const outcome = this.contamination.inspect(call, text);

    // Signal 3b (injection): classify the result; a positive raises the session's posture so the
    // next egress is gated (D12). Async/observe-only — never withholds or blocks the result.
    let injectionFlagged = false;
    let injectionScore = 0;
    if (this.injection.available) {
      const verdict = await this.injection.classify(text);
      injectionScore = verdict.score;
      if (verdict.score >= this.opts.injection.threshold) {
        injectionFlagged = true;
        this.contamination.flagInjection(call.sessionId ?? 'default', verdict.score, call.tool);
        await this.writeAudit({
          event: 'injection-detected',
          sessionId: call.sessionId,
          tool: call.tool,
          category: classify(call.tool),
          signal: 'content',
          injectionScore: verdict.score,
          reason: `Prompt-injection detected in ${call.tool} result (score ${verdict.score.toFixed(2)}, ${this.injection.name}). Session posture raised — outbound calls now require review.`,
        });
      }
    }

    if (outcome.tainted) {
      // Auditable security event: a secret entered the agent's context. Not a block (the read already
      // happened) — it arms the exfil gate for subsequent egress on this session.
      await this.writeAudit({
        event: 'taint-loaded',
        sessionId: call.sessionId,
        tool: call.tool,
        category: classify(call.tool),
        signal: 'content',
        secretTypes: outcome.secretTypes,
        reason: `Secret loaded into context via ${call.tool}: ${outcome.secretTypes.join(', ')}. Session tainted — outbound calls now require review.`,
      });
    }
    return json(res, 200, {
      ok: true,
      tainted: outcome.tainted,
      secretTypes: outcome.secretTypes,
      injectionFlagged,
      injectionScore,
      classifier: this.injection.name,
    });
  }

  /**
   * SessionStart / SessionEnd (D23). Observability-only — bookends the session timeline. On 'ended'
   * we also reset the per-session monitor state, which is the deterministic counterpart to the
   * idle-eviction in M2/M3 (a session that ends cleanly shouldn't wait to be swept).
   */
  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<SessionEvent>(req);
    const sessionId = effectiveSession(body.sessionId, body.cwd);
    if (body.event === 'ended') {
      this.behavioral.reset(sessionId);
      this.contamination.reset(sessionId);
    }
    await this.writeAudit({
      event: body.event === 'started' ? 'session-started' : 'session-ended',
      sessionId,
      reason:
        body.event === 'started'
          ? `Session started${body.source ? ` (${body.source})` : ''}.`
          : 'Session ended — monitor state reset.',
    });
    return json(res, 200, { ok: true });
  }

  /* ------------------------------- WebSocket -------------------------------- */

  private onDashboardConnect(ws: WebSocket, req: IncomingMessage): void {
    this.clients.add(ws);
    send(ws, { type: 'hello', pending: this.store.pending() });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as DashboardToServer;
        if (msg.type === 'decision') {
          const operator = this.webTokens.get(cookieValue(req, 'guardsaab_session') ?? '');
          if (!req.headers.origin || (operator?.site === 'guardsaab' && (operator.user.role === 'HR' || operator.user.role === 'CEO'))) void this.store.resolveContext(msg.violationId, msg.action);
        }
      } catch {
        /* ignore malformed dashboard messages */
      }
    });
    ws.on('close', () => this.clients.delete(ws));
  }

  private broadcast(msg: ServerToDashboard): void {
    for (const ws of this.clients) send(ws, msg);
  }

  private verifyWebSocket(req: IncomingMessage): boolean {
    if (!originAllowed(req.headers.origin)) return false;
    if (!req.headers.origin) return true;
    const operator = this.webTokens.get(cookieValue(req, 'guardsaab_session') ?? '');
    const company = this.webTokens.get(cookieValue(req, 'northstar_session') ?? '');
    return Boolean((operator?.site === 'guardsaab' && (operator.user.role === 'HR' || operator.user.role === 'CEO')) || company?.site === 'company');
  }

  /* ------------------------------ static dashboard ------------------------------ */

  /** Serve the built dashboard from opts.staticDir, with SPA fallback to index.html (D20). */
  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const dir = this.opts.staticDir as string;
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const rel = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');
    let file = normalize(join(dir, rel));

    // path-traversal guard: the resolved file must stay inside the static dir.
    if (file !== dir && !file.startsWith(dir + sep)) return json(res, 403, { error: 'forbidden' });
    if (!existsSync(file) || !statSync(file).isFile()) file = join(dir, 'index.html'); // SPA fallback
    if (!existsSync(file)) return json(res, 404, { error: 'dashboard not built (run `npm run build`)' });

    res.writeHead(200, { 'content-type': contentType(extname(file)) });
    res.end(readFileSync(file));
  }

  /* --------------------------------- audit ---------------------------------- */

  /**
   * Append one event to the audit log (single source of truth, D22) and stream it live to every
   * dashboard. `sessionId` is coerced to 'default' so every record is attributable (hardening, step 1);
   * a record the log rejects as malformed is NOT broadcast, so live and history stay consistent.
   */
  private async writeAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    const full = sanitizeAuditPayload({ ts: Date.now(), ...entry, sessionId: entry.sessionId ?? 'default' }) as AuditEntry;
    if (!this.audit.record(full)) return;
    await this.auditStore?.appendGateway(full);
    this.broadcast({ type: 'audit', entry: full });
  }
}

/* --------------------------------- helpers --------------------------------- */

type CompanyStateShape = { employees?: Array<Record<string, unknown>>; requests?: Array<Record<string, unknown>>; ledger?: Array<Record<string, unknown>>; events?: Array<Record<string, unknown>> };

function initialCompanyState(): CompanyStateShape {
  return { employees: [
    { id: 'NW-104', name: 'Maya Iyer', title: 'Product Designer', department: 'Product', manager: 'Nikhil Rao', salary: 118000, attendance: 96, leaveUsed: 7, leaveTotal: 24, fundQuota: 200000, fundsRemaining: 164000, account: '•••• 4812', bonus: 12000 },
    { id: 'NW-108', name: 'Arjun Mehta', title: 'Software Engineer', department: 'Engineering', manager: 'Nikhil Rao', salary: 142000, attendance: 98, leaveUsed: 4, leaveTotal: 24, fundQuota: 200000, fundsRemaining: 200000, account: '•••• 2294', bonus: 0 },
    { id: 'NW-112', name: 'Leela Das', title: 'People Operations', department: 'People', manager: 'Ananya Menon', salary: 106000, attendance: 94, leaveUsed: 9, leaveTotal: 24, fundQuota: 200000, fundsRemaining: 172000, account: '•••• 7701', bonus: 8000 },
    { id: 'NW-119', name: 'Kabir Shah', title: 'Finance Analyst', department: 'Finance', manager: 'Nikhil Rao', salary: 126000, attendance: 97, leaveUsed: 6, leaveTotal: 24, fundQuota: 200000, fundsRemaining: 200000, account: '•••• 1830', bonus: 5000 },
    { id: 'NW-123', name: 'Priya Nair', title: 'People Analyst', department: 'People', manager: 'Nikhil Rao', salary: 112000, attendance: 99, leaveUsed: 3, leaveTotal: 24, fundQuota: 200000, fundsRemaining: 200000, account: '•••• 6193', bonus: 0 },
  ], requests: [], ledger: [], events: [] };
}

function scopedEmployeeIds(state: CompanyStateShape, user: AuthenticatedUser, site: 'company' | 'guardsaab'): Set<string> {
  if (user.role === 'CEO') return new Set((state.employees ?? []).map((employee) => String(employee.id)));
  if (user.role === 'Employee') return new Set(user.employeeId ? [user.employeeId] : []);
  const hrName = site === 'guardsaab' ? 'Nikhil Rao' : user.displayName;
  return new Set((state.employees ?? []).filter((employee) => employee.manager === hrName).map((employee) => String(employee.id)));
}

function scopeCompanyState(value: unknown, user: AuthenticatedUser, site: 'company' | 'guardsaab'): unknown {
  if (!value || typeof value !== 'object') return value;
  const state = value as CompanyStateShape;
  const allowed = scopedEmployeeIds(state, user, site);
  const employees = (state.employees ?? []).filter((employee) => allowed.has(String(employee.id)));
  const names = new Set(employees.map((employee) => String(employee.name ?? '')));
  const requests = (state.requests ?? []).filter((request) => allowed.has(String(request.employeeId)));
  const requestIds = new Set(requests.map((request) => String(request.id)));
  const events = (state.events ?? []).filter((event) => {
    if (event.requestId) return requestIds.has(String(event.requestId));
    if (user.role === 'CEO' || user.role === 'HR') return true;
    const detail = String(event.detail ?? '');
    return [...names].some((name) => name && detail.includes(name));
  });
  return { ...state, employees, requests, ledger: (state.ledger ?? []).filter((entry) => allowed.has(String(entry.employeeId))), events };
}

function mergeScopedCompanyState(currentValue: unknown, nextValue: unknown, user: AuthenticatedUser, site: 'company' | 'guardsaab'): unknown {
  if (!nextValue || typeof nextValue !== 'object') throw new Error('Company records must be an object.');
  const current = (currentValue && typeof currentValue === 'object' ? currentValue : {}) as CompanyStateShape;
  const next = nextValue as CompanyStateShape;
  const allowed = scopedEmployeeIds(current, user, site);
  const employees = current.employees ?? [];
  const now = Date.now();
  const events = [...(current.events ?? [])];
  const addTrustedEvent = (actor: string, action: string, detail: string, outcome: string, requestId?: string) => {
    events.unshift({ id: `evt-${randomUUID()}`, time: now, actor, action, detail, outcome, ...(requestId ? { requestId } : {}) });
  };
  const mayManage = (employeeId: string) => user.role === 'CEO' || (user.role === 'HR' && allowed.has(employeeId));
  const employeeRows = employees.map((before) => {
    const incoming = (next.employees ?? []).find((row) => String(row.id) === String(before.id));
    // Compensation data is never accepted from employees. HR/CEO can add bonuses, but cannot
    // rewrite salary, attendance, leave, account identity, or quota through this bulk-sync API.
    if (!incoming || !mayManage(String(before.id))) return before;
    const oldBonus = Number(before.bonus ?? 0);
    const newBonus = Number(incoming.bonus ?? oldBonus);
    if (!Number.isFinite(newBonus) || newBonus < oldBonus) return before;
    if (newBonus > oldBonus) addTrustedEvent(`${user.role} · ${user.displayName}`, 'Bonus record added', `${newBonus - oldBonus} INR for ${String(before.name ?? before.id)}`, 'COMPLETED');
    return { ...before, bonus: newBonus };
  });
  const requests = [...(current.requests ?? [])];
  const ledger = [...(current.ledger ?? [])];
  for (const incoming of next.requests ?? []) {
    if (!incoming || typeof incoming !== 'object') continue;
    const id = String(incoming.id ?? '');
    const oldIndex = requests.findIndex((row) => String(row.id) === id);
    if (oldIndex < 0) {
      const employeeId = String(incoming.employeeId ?? '');
      const amount = Number(incoming.amount);
      const employee = employees.find((row) => String(row.id) === employeeId);
      const isEmployeeRequest = user.role === 'Employee' && employeeId === user.employeeId;
      const expectedStatus = incoming.kind === 'QUOTA_INCREASE'
        ? amount > 200000 ? 'PENDING_CEO' : 'PENDING_HR'
        : amount > 100000 ? 'PENDING_CEO' : 'PENDING_HR';
      const reviewRequest = incoming.status === expectedStatus;
      if (!employee || !allowed.has(employeeId) || !Number.isFinite(amount) || amount <= 0 || amount > 2_000_000 || typeof incoming.purpose !== 'string' || !incoming.purpose.trim() || (!mayManage(employeeId) && !isEmployeeRequest) || !reviewRequest) continue;
      const normalizePurpose = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (requests.some((row) => String(row.employeeId) === employeeId && row.kind === incoming.kind
        && Number(row.amount) === amount && normalizePurpose(row.purpose) === normalizePurpose(incoming.purpose)
        && (row.status === 'PENDING_HR' || row.status === 'PENDING_CEO' || row.status === 'APPROVED'))) continue;
      const row: Record<string, unknown> = { ...incoming, employeeId, amount, status: incoming.status };
      requests.push(row);
      addTrustedEvent(`${user.role} · ${user.displayName}`, incoming.kind === 'QUOTA_INCREASE' ? 'Additional fund quota requested' : 'Company fund request submitted', `${amount} INR for ${String(employee.name ?? employeeId)} · ${String(row.purpose)}`, String(row.status), id);
      continue;
    }
    const currentRequest = requests[oldIndex];
    if (!currentRequest) continue;
    if (incoming.status === 'APPROVED' || incoming.status === 'REJECTED') {
      if (currentRequest.status !== 'PENDING_HR' && currentRequest.status !== 'PENDING_CEO') continue;
      const employeeId = String(currentRequest.employeeId ?? '');
      const employee = employeeRows.find((row) => String(row.id) === employeeId);
      if (!employee || !allowed.has(employeeId)) continue;
      if (user.role !== 'HR' && user.role !== 'CEO') continue;
      if (currentRequest.status === 'PENDING_CEO' && user.role !== 'CEO') continue;
      const cap = currentRequest.kind === 'QUOTA_INCREASE' ? 200_000 : 100_000;
      if (user.role === 'HR' && Number(currentRequest.amount) > cap) continue;
      const newStatus = incoming.status;
      requests[oldIndex] = { ...currentRequest, status: newStatus, approvalBy: `${user.role} · ${user.displayName}` };
      if (newStatus === 'APPROVED') {
        const amount = Number(currentRequest.amount ?? 0);
        const empIdx = employeeRows.findIndex((row) => String(row.id) === employeeId);
        if (currentRequest.kind === 'QUOTA_INCREASE') {
          if (empIdx >= 0) {
            const emp = employeeRows[empIdx]!;
            employeeRows[empIdx] = {
              ...emp,
              fundQuota: Number(emp.fundQuota ?? 200000) + amount,
              fundsRemaining: Number(emp.fundsRemaining ?? 0) + amount,
            };
          }
          addTrustedEvent(`${user.role} · ${user.displayName}`, 'Fund quota increase approved', `${amount} INR for ${String(employee.name ?? employeeId)} · ${String(currentRequest.purpose ?? '')}`, 'APPROVED', id);
        } else {
          if (empIdx >= 0) {
            const emp = employeeRows[empIdx]!;
            employeeRows[empIdx] = {
              ...emp,
              fundsRemaining: Math.max(0, Number(emp.fundsRemaining ?? 0) - amount),
            };
          }
          const transactionId = `NSTAR-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
          ledger.unshift({ id: transactionId, employeeId, amount, purpose: currentRequest.purpose, time: now, requestId: id });
          addTrustedEvent(`${user.role} · ${user.displayName}`, 'Company funds approved', `${amount} INR for ${String(employee.name ?? employeeId)} · ${String(currentRequest.purpose ?? '')}`, 'APPROVED', id);
        }
      } else {
        addTrustedEvent(`${user.role} · ${user.displayName}`, 'Company fund request rejected', `${String(currentRequest.amount)} INR for ${String(employee.name ?? employeeId)} · ${String(currentRequest.purpose ?? '')}`, 'REJECTED', id);
      }
    }
  }
  // Browser-provided `events` are deliberately ignored. Audit facts are derived from accepted
  // server-side state transitions above so the client cannot forge actor, timestamp, or outcome.
  return { ...current, employees: employeeRows, requests, ledger, events };
}

/**
 * Is this request's Origin allowed to reach the approval surface (/ws, /decision)?
 *  - absent Origin ⇒ a non-browser client (the hook, tests, curl) — not the CSWSH vector ⇒ allow.
 *  - present Origin ⇒ allow ONLY loopback hosts (the served dashboard, or a vite-dev origin on any
 *    port); reject everything else, which is the cross-site browser page a CSWSH attack runs from.
 *  - malformed Origin ⇒ reject.
 * Loopback is matched by host (any port) so `vite dev` on :5173 → engine on :9000 still works.
 */
/** The egress URL/host a call reaches out to — the native `url` arg, or a URL inside a Bash command. */
function egressTarget(call: MCPToolCall): string {
  const u = call.input?.['url'];
  if (typeof u === 'string' && u) return u;
  const cmd = call.input?.['command'];
  if (typeof cmd === 'string') return /\bhttps?:\/\/[^\s'"`)|>]+/i.exec(cmd)?.[0] ?? '';
  return '';
}

/**
 * A stable per-session key. Prefer the agent's own sessionId; when it sends none (e.g. Cursor's
 * beforeShellExecution carries no conversation_id) fall back to a key derived from the working dir, so
 * two concurrent sessionless agents in DIFFERENT projects don't share taint/behavioral state (M4). Only
 * when neither is present do we use the shared 'default' bucket.
 */
function effectiveSession(sessionId: string | undefined, cwd: string | undefined): string {
  if (sessionId) return sessionId;
  if (cwd) return `cwd:${createHash('sha256').update(cwd).digest('hex').slice(0, 12)}`;
  return 'default';
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function workspaceFromRequest(req: IncomingMessage): 'company' | 'guardsaab' {
  // The two localhost frontends share a cookie jar. Use the calling site's port (or path when
  // served from one origin) to choose which independently authenticated session to validate.
  for (const value of [req.headers.origin, req.headers.referer]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.port === '5174' || url.pathname === '/guardsaab' || url.pathname.startsWith('/guardsaab/')) return 'guardsaab';
      if (url.port === '5173') return 'company';
    } catch { /* ignore malformed optional browser metadata */ }
  }
  if (cookieValue(req, 'guardsaab_session') && !cookieValue(req, 'northstar_session')) return 'guardsaab';
  return 'company';
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length) || null;
  }
  return null;
}

/** Open a URL in the user's default browser, cross-platform, detached (best-effort). */
function defaultOpener(url: string): void {
  // Windows: `cmd /c start "" "<url>"` — the empty "" is the window title, so a URL with `?`/`&`
  // isn't mistaken for one. macOS: `open`. Linux/BSD: `xdg-open`. No shell ⇒ no extra quoting hazards.
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  child.unref();
}

/** Classify how a held call ended, from the store's verdict — for the hitl-resolved latency event (D23). */
function resolutionOf(action: FinalAction, reason: string): HitlResolution {
  if (action === 'ALLOW') return 'approved';
  return /timed out|disconnected/i.test(reason) ? 'expired' : 'rejected';
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentType(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (c) => {
      if (oversized) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += chunk.byteLength;
      if (size > 1_000_000) { oversized = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return reject(new Error('payload too large'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(ws: WebSocket, msg: ServerToDashboard): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
