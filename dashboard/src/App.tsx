import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { SessionsView } from './SessionsView';
import { EVENT_META, ago, describe } from './format';
import type { AuditEntry, SecurityViolation } from './contract';
import { useEngine } from './useEngine';
import { CompanyWorkspace } from './CompanyWorkspace';
import { COMPANY_DEMO_KEY, readCompanyAudit, readCompanyDemo } from './companyAudit';
import type { CompanyAuditEvent, CompanyDemoRecord } from './companyAudit';
import { ScenarioLab } from './ScenarioLab';
import { useTheme, ThemeToggle } from './theme';

type Role = 'HR' | 'CEO';
type GuardSaaBUser = { username: string; displayName: string; role: Role };
type Page = 'overview' | 'simulator' | 'agents' | 'approvals' | 'activity' | 'sessions';
type AuditChainStatus = { enabled: boolean; verified: boolean; count: number; headHash: string | null; checkpointSeq: number; checkedAt: string; error?: string };
type AuditChainEntry = { seq: number; id: string; recordedAt: string; stream: 'gateway' | 'company' | 'auth'; payload: unknown; previousHash: string; hash: string };
type AuthEvent = { action: string; username?: string; displayName?: string; role?: string; site?: string; time: number };

const AGENTS = [
  { name: 'Finance Agent', dept: 'Finance', id: 'AG-001', status: 'Active', detail: 'Company fund requests and account credits' },
  { name: 'HR Agent', dept: 'Human Resources', id: 'AG-002', status: 'Active', detail: 'Attendance, leave, and scoped employee records' },
  { name: 'Zeo · Company Agent', dept: 'People Operations', id: 'AG-003', status: 'Active', detail: 'Employee lookups and guided fund requests' },
  { name: 'IT Operations Agent', dept: 'IT Operations', id: 'AG-004', status: 'Guarded', detail: 'Command inspection and deployment workflows' },
];


function SecurityApproval({ violation, now, onDecide }: { violation: SecurityViolation; now: number; onDecide: (id: string, action: 'ALLOW' | 'BLOCK') => void }) {
  const { title, body } = describe(violation.toolCall);
  const left = Math.max(0, Math.ceil((violation.createdAt + violation.ttlMs - now) / 1000));
  const rawEmployee = (violation.toolCall.input?.['employee'] ?? violation.toolCall.input?.['requestedBy'] ?? violation.toolCall.input?.['user'] ?? violation.toolCall.sessionId) as string | undefined;
  const employeeName = rawEmployee && rawEmployee.startsWith('emp-') ? rawEmployee.slice(4) : (rawEmployee ?? 'Maya Iyer (NW-104)');

  return (
    <article className="ops-approval-card">
      <div className="ops-approval-head">
        <span className="ops-pill">{violation.category} · {violation.signal ?? 'POLICY REVIEW'}</span>
        <time>{left}s left</time>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 8px 0', fontSize: '12px', color: '#94a3b8' }}>
        <span style={{ padding: '2px 8px', borderRadius: '4px', background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', fontWeight: 600 }}>
          👤 Employee: {employeeName}
        </span>
        <span>· IT Operations Agent</span>
      </div>
      <h3>{title}</h3>
      {body && <pre>{body}</pre>}
      <p>{violation.reason}</p>
      <div className="ops-approval-actions">
        <button className="ops-approve" onClick={() => onDecide(violation.id, 'ALLOW')}>Allow action</button>
        <button className="ops-reject" onClick={() => onDecide(violation.id, 'BLOCK')}>Block action</button>
      </div>
    </article>
  );
}

function CompanyApproval({ request, employeeName, role, onDecide, busy, duplicateOf }: { request: CompanyDemoRecord['requests'][number]; employeeName: string; role: Role; onDecide: (id: string, approve: boolean) => void; busy: boolean; duplicateOf?: string }) {
  const quotaIncrease = request.kind === 'QUOTA_INCREASE';
  return <article className="ops-approval-card"><div className="ops-approval-head"><span className="ops-pill is-review">{request.status === 'PENDING_CEO' ? 'CEO REVIEW' : 'HR REVIEW'} · {quotaIncrease ? 'QUOTA INCREASE' : 'FUND TRANSFER'}</span><span className="ops-request-id">{request.id}</span></div><h3>{employeeName} <b>· ₹{request.amount.toLocaleString('en-IN')}</b></h3><p className="ops-purpose">{request.purpose}</p><p>{quotaIncrease ? 'Approval adds this amount to the employee’s available company fund quota. No account credit is made by a quota change.' : 'The agent attempted an account credit. Company policy held it before the ledger changed.'}</p>{duplicateOf&&<p className="ops-chain-error" role="status">Possible duplicate: an identical transfer was already approved as {duplicateOf}. This request cannot be credited again.</p>}<div className="ops-approval-actions"><button className="ops-approve" disabled={busy||Boolean(duplicateOf)} onClick={() => onDecide(request.id, true)}>{busy ? 'Saving decision…' : duplicateOf ? 'Duplicate blocked' : `${role} approve ${quotaIncrease ? 'quota increase' : '& credit'}`}</button><button className="ops-reject" disabled={busy} onClick={() => onDecide(request.id, false)}>Reject request</button></div></article>;
}

export default function App() {
  const { connected, pending, audit, decide } = useEngine();
  const { theme, toggleTheme } = useTheme('guardsaab');
  const [user, setUser] = useState<GuardSaaBUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [page, setPage] = useState<Page>(() => new URLSearchParams(window.location.search).has('session') ? 'sessions' : 'overview');
  const [companyEvents, setCompanyEvents] = useState<CompanyAuditEvent[]>(readCompanyAudit);
  const [companyDemo, setCompanyDemo] = useState<CompanyDemoRecord | null>(readCompanyDemo);
  const [companyDecisionBusy, setCompanyDecisionBusy] = useState<string | null>(null);
  const [companyDecisionFeedback, setCompanyDecisionFeedback] = useState('');
  const [now, setNow] = useState(Date.now);
  const [chainStatus, setChainStatus] = useState<AuditChainStatus | null>(null);
  const [chainEntries, setChainEntries] = useState<AuditChainEntry[]>([]);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [verifySuccessFlash, setVerifySuccessFlash] = useState(false);
  const [chainVerifyNotice, setChainVerifyNotice] = useState<{ type: 'success' | 'error'; message: string; timestamp: number } | null>(null);
  const [activityFilter, setActivityFilter] = useState<'all' | 'blocked' | 'approved' | 'pending' | 'info'>('all');
  const [activitySort, setActivitySort] = useState<'time-desc' | 'time-asc' | 'decision-blocked' | 'decision-approved' | 'decision-pending' | 'actor-asc' | 'actor-desc'>('time-desc');
  const [activitySearch, setActivitySearch] = useState('');

  const isGuardSaaBSite = window.location.port === '5174' || (window.location.port !== '5173' && window.location.pathname === '/guardsaab');
  const role = user?.role ?? null;

  useEffect(() => {
    let active = true;
    void fetch('/auth/session?site=guardsaab').then((response) => response.json()).then((payload: { user?: GuardSaaBUser | null }) => { if (active) setUser(payload.user ?? null); }).catch(() => undefined).finally(() => { if (active) setAuthLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isGuardSaaBSite || !role) return;
    let active = true;
    const syncRole = async () => {
      try {
        const response = await fetch('/auth/session?site=guardsaab', { signal: AbortSignal.timeout(2500) });
        const payload = await response.json() as { user?: GuardSaaBUser | null };
        if (active) setUser(payload.user ?? null);
      } catch { /* keep the current view during a brief gateway restart */ }
    };
    window.addEventListener('focus', syncRole);
    const timer = window.setInterval(syncRole, 10000);
    return () => { active = false; window.removeEventListener('focus', syncRole); window.clearInterval(timer); };
  }, [isGuardSaaBSite, role]);

  useEffect(() => {
    const company = !isGuardSaaBSite;
    const title = company ? 'Northstar Works — People & Finance' : role ? 'GuardSaaB — Agent Governance Console' : 'GuardSaaB — Sign in';
    const description = company
      ? 'Northstar Works employee services for attendance, leave, pay, company funds, and people operations.'
      : 'Review company agent activity, approvals, policy decisions, and security events in the GuardSaaB governance console.';
    const siteName = company ? 'Northstar Works' : 'GuardSaaB';
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[name="application-name"]')?.setAttribute('content', siteName);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', `${window.location.origin}${company ? '/' : '/guardsaab'}`);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', company ? (document.documentElement.classList.contains('light') ? '#f8fafc' : '#101211') : (theme === 'light' ? '#f8fafc' : '#071014'));
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
    icon.href = company ? '/northstar-icon.svg' : '/guardsaab-icon.svg';
    icon.type = company ? 'image/svg+xml' : 'image/png';
  }, [role, isGuardSaaBSite]);

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (page !== 'activity' || !isGuardSaaBSite || !role) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/audit-chain', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('Audit chain service is unavailable.');
        const data = await response.json() as { status: AuditChainStatus; entries: AuditChainEntry[] };
        if (active) { setChainStatus(data.status); setChainEntries(data.entries ?? []); }
      } catch { if (active) setChainStatus({ enabled: false, verified: false, count: 0, headHash: null, checkpointSeq: 0, checkedAt: new Date().toISOString() }); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [page, isGuardSaaBSite, role]);
  useEffect(() => {
    if (!role || !isGuardSaaBSite) return;
    const refresh = async () => {
      try {
        const response = await fetch('/company-demo-state?site=guardsaab', { signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          const payload = await response.json() as { state?: CompanyDemoRecord | null };
          if (payload.state) {
            localStorage.setItem(COMPANY_DEMO_KEY, JSON.stringify(payload.state));
            setCompanyDemo(payload.state);
            setCompanyEvents(payload.state.events);
            return;
          }
        }
      } catch { /* show the last authorized local view if the gateway is restarting */ }
      setCompanyEvents(readCompanyAudit()); setCompanyDemo(readCompanyDemo());
    };
    void refresh();
    const timer = window.setInterval(refresh, 1200);
    const onStorage = () => { void refresh(); };
    window.addEventListener('storage', onStorage);
    return () => { window.clearInterval(timer); window.removeEventListener('storage', onStorage); };
  }, [role, isGuardSaaBSite]);

  const allowedEmployeeIds = useMemo(() => new Set((companyDemo?.employees ?? [])
    .filter((employee) => role === 'CEO' || employee.manager === 'Nikhil Rao')
    .map((employee) => employee.id)), [companyDemo, role]);
  const chainedCompanyEvents = chainEntries.flatMap((entry) => entry.stream === 'company' && entry.payload && typeof entry.payload === 'object' && typeof (entry.payload as CompanyAuditEvent).time === 'number' ? [{ ...(entry.payload as CompanyAuditEvent), id: String((entry.payload as CompanyAuditEvent).id ?? entry.id) }] : []);
  const historicalCompanyEvents = [...chainedCompanyEvents, ...companyEvents].filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index);
  const authEvents = chainEntries.flatMap((entry) => {
    if (entry.stream !== 'auth' || !entry.payload || typeof entry.payload !== 'object') return [];
    const payload = entry.payload as AuthEvent;
    if (typeof payload.time !== 'number') return [];
    return [{ id: entry.id, time: payload.time, actor: payload.displayName ?? payload.username ?? 'Account', action: payload.action, detail: `${payload.site ?? 'workspace'}${payload.role ? ` · ${payload.role}` : ''}${payload.username ? ` · ${payload.username}` : ''}`, outcome: payload.action === 'sign-in denied' ? 'BLOCKED' : payload.action === 'sign-in' ? 'SIGNED IN' : 'SIGNED OUT' } satisfies CompanyAuditEvent];
  });
  const visibleCompanyEvents = historicalCompanyEvents.filter((event) => {
    if (role === 'CEO') return true;
    if (event.requestId) {
      const request = companyDemo?.requests.find((item) => item.id === event.requestId);
      return Boolean(request && allowedEmployeeIds.has(request.employeeId));
    }
    const namedEmployee = companyDemo?.employees.find((employee) => event.detail.includes(employee.name));
    return !namedEmployee || allowedEmployeeIds.has(namedEmployee.id);
  });
  const companyApprovals = (companyDemo?.requests ?? []).filter((request) => request.status.startsWith('PENDING')
    && (request.status !== 'PENDING_CEO' || role === 'CEO')
    && allowedEmployeeIds.has(request.employeeId));
  const totalApprovals = companyApprovals.length + pending.length;
  const blockedCompanyEvents = visibleCompanyEvents.filter((event) => /BLOCK|REJECT|HELD/i.test(event.outcome)).length;
  const chainedGatewayAudit = chainEntries.flatMap((entry) => {
    const payload = entry.payload as AuditEntry | null;
    return entry.stream === 'gateway' && payload && typeof payload.ts === 'number' && typeof payload.event === 'string' ? [payload] : [];
  });
  const allGatewayAudit = [...audit, ...chainedGatewayAudit].filter((entry, index, all) => all.findIndex((candidate) => candidate.ts === entry.ts && candidate.event === entry.event && candidate.requestId === entry.requestId && candidate.sessionId === entry.sessionId) === index).sort((a, b) => b.ts - a.ts);
  const blockedGatewayEvents = allGatewayAudit.filter((event) => event.action === 'BLOCK').length;
  const highRiskEvents = audit.filter((event) => event.event === 'injection-detected' || (event.risk?.score ?? 0) >= 70).length;

  type ActivityLogItem = {
    key: string;
    timestamp: number;
    actor: string;
    decision: 'BLOCK' | 'ALLOW' | 'PENDING' | 'INFO';
    rawOutcome: string;
    action: string;
    detail: string;
    source: 'gateway' | 'company' | 'auth';
  };

  const unifiedActivityList = useMemo<ActivityLogItem[]>(() => {
    const list: ActivityLogItem[] = [];

    allGatewayAudit.forEach((entry, idx) => {
      const meta = EVENT_META[entry.event];
      const isBlocked = entry.action === 'BLOCK';
      const isAllowed = entry.action === 'ALLOW';
      const isPending = (entry.action as string) === 'ASK' || entry.event === 'hitl-opened' || Boolean(entry.viaHitl);
      const decision: ActivityLogItem['decision'] = isBlocked ? 'BLOCK' : isAllowed ? 'ALLOW' : isPending ? 'PENDING' : 'INFO';

      list.push({
        key: `gw-${entry.ts}-${entry.requestId ?? entry.sessionId ?? idx}-${idx}`,
        timestamp: entry.ts,
        actor: meta?.label ?? 'Gateway event',
        decision,
        rawOutcome: entry.action ?? (entry.viaHitl ? 'REVIEW' : '—'),
        action: entry.tool ?? meta?.label ?? 'Tool call',
        detail: entry.ruleId ? `${entry.ruleId}${entry.reason ? ` · ${entry.reason}` : ''}` : (entry.reason ?? 'Policy evaluated'),
        source: 'gateway',
      });
    });

    visibleCompanyEvents.forEach((event, idx) => {
      const status = event.outcome.toUpperCase();
      const isBlocked = status.includes('BLOCK') || status.includes('REJECT');
      const isAllowed = status.includes('ALLOW') || status.includes('COMPLETE') || status.includes('APPROV');
      const isPending = status.includes('PENDING') || status.includes('HELD') || status.includes('REVIEW');
      const decision: ActivityLogItem['decision'] = isBlocked ? 'BLOCK' : isAllowed ? 'ALLOW' : isPending ? 'PENDING' : 'INFO';

      list.push({
        key: `co-${event.id}-${event.time}-${idx}`,
        timestamp: event.time,
        actor: event.actor,
        decision,
        rawOutcome: event.outcome,
        action: `${event.action}${event.requestId ? ` · ${event.requestId}` : ''}`,
        detail: event.detail,
        source: 'company',
      });
    });

    authEvents.forEach((event, idx) => {
      const isBlocked = event.outcome === 'BLOCKED';
      const isAllowed = event.outcome === 'SIGNED IN';
      const decision: ActivityLogItem['decision'] = isBlocked ? 'BLOCK' : isAllowed ? 'ALLOW' : 'INFO';

      list.push({
        key: `au-${event.id}-${event.time}-${idx}`,
        timestamp: event.time,
        actor: event.actor,
        decision,
        rawOutcome: event.outcome,
        action: event.action,
        detail: event.detail,
        source: 'auth',
      });
    });

    return list;
  }, [allGatewayAudit, visibleCompanyEvents, authEvents]);

  const activityCounts = useMemo(() => {
    let blocked = 0;
    let approved = 0;
    let pending = 0;
    let info = 0;
    for (const item of unifiedActivityList) {
      if (item.decision === 'BLOCK') blocked++;
      else if (item.decision === 'ALLOW') approved++;
      else if (item.decision === 'PENDING') pending++;
      else info++;
    }
    return { all: unifiedActivityList.length, blocked, approved, pending, info };
  }, [unifiedActivityList]);

  const filteredActivityList = useMemo<ActivityLogItem[]>(() => {
    let result = unifiedActivityList;

    if (activityFilter === 'blocked') result = result.filter((i) => i.decision === 'BLOCK');
    else if (activityFilter === 'approved') result = result.filter((i) => i.decision === 'ALLOW');
    else if (activityFilter === 'pending') result = result.filter((i) => i.decision === 'PENDING');
    else if (activityFilter === 'info') result = result.filter((i) => i.decision === 'INFO');

    if (activitySearch.trim()) {
      const q = activitySearch.toLowerCase();
      result = result.filter((i) =>
        i.actor.toLowerCase().includes(q) ||
        i.action.toLowerCase().includes(q) ||
        i.detail.toLowerCase().includes(q) ||
        i.rawOutcome.toLowerCase().includes(q)
      );
    }

    const priorityMap: Record<string, Record<string, number>> = {
      'decision-blocked': { BLOCK: 0, PENDING: 1, ALLOW: 2, INFO: 3 },
      'decision-approved': { ALLOW: 0, PENDING: 1, BLOCK: 2, INFO: 3 },
      'decision-pending': { PENDING: 0, BLOCK: 1, ALLOW: 2, INFO: 3 },
    };

    return [...result].sort((a, b) => {
      if (activitySort === 'time-desc') return b.timestamp - a.timestamp;
      if (activitySort === 'time-asc') return a.timestamp - b.timestamp;
      if (activitySort === 'actor-asc') return a.actor.localeCompare(b.actor);
      if (activitySort === 'actor-desc') return b.actor.localeCompare(a.actor);

      const map = priorityMap[activitySort];
      if (map) {
        const diff = (map[a.decision] ?? 4) - (map[b.decision] ?? 4);
        if (diff !== 0) return diff;
      }
      return b.timestamp - a.timestamp;
    });
  }, [unifiedActivityList, activityFilter, activitySearch, activitySort]);
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoginError(''); setLoggingIn(true);
    try {
      const response = await fetch('/auth/login?site=guardsaab', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const payload = await response.json() as { user?: GuardSaaBUser; error?: string };
      if (!response.ok || !payload.user) { setLoginError(payload.error ?? 'Unable to sign in.'); return; }
      setUser(payload.user); setPassword(''); setPage('overview');
    } catch { setLoginError('GuardSaaB cannot reach the account service. Try again shortly.'); }
    finally { setLoggingIn(false); }
  };
  const signOut = () => { void fetch('/auth/logout?site=guardsaab', { method: 'POST' }); setUser(null); setPassword(''); setPage('overview'); };
  const decideCompany = async (requestId: string, approve: boolean) => {
    if (!role || companyDecisionBusy) return;
    setCompanyDecisionBusy(requestId);
    setCompanyDecisionFeedback('');
    try {
      const request = companyDemo?.requests.find((item) => item.id === requestId);
      if (!request) throw new Error('This request is no longer available in the current view. Refresh the queue and try again.');
      const response = await fetch('/company-demo-state/decision?site=guardsaab', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, decision: approve ? 'approve' : 'reject' }) });
      const payload = await response.json() as { state?: CompanyDemoRecord; error?: string; alreadyDecided?: boolean; duplicateBlocked?: boolean };
      if (!response.ok || !payload.state) throw new Error(payload.error ?? `The decision could not be saved (HTTP ${response.status}).`);
      const confirmed = payload.state;
      localStorage.setItem(COMPANY_DEMO_KEY, JSON.stringify(confirmed));
      setCompanyDemo(confirmed);
      setCompanyEvents(confirmed.events ?? []);
      const result = confirmed.requests.find((item) => item.id === requestId);
      if (payload.duplicateBlocked) {
        setCompanyDecisionFeedback(`Blocked as a duplicate: this transfer was already approved under ${result?.duplicateOf ?? 'an earlier request'}. No additional funds were credited.`);
      } else if (approve && result?.status !== 'APPROVED') {
        const employee = confirmed.employees.find((item) => item.id === request.employeeId);
        setCompanyDecisionFeedback(result?.status === 'REJECTED' && request.kind !== 'QUOTA_INCREASE'
          ? `Approval was declined by policy: ₹${request.amount.toLocaleString('en-IN')} was requested, but only ₹${Number(employee?.fundsRemaining ?? 0).toLocaleString('en-IN')} remains in the employee’s available quota. Request additional quota first, or reject this request.`
          : 'The server did not record this decision. The request remains in the review queue; check your role and try again.');
      } else if (payload.alreadyDecided) {
        setCompanyDecisionFeedback(`This decision was already recorded for ${requestId}. No second credit was created.`);
      } else if (approve && Number(result?.quotaAdjustment ?? 0) > 0) {
        setCompanyDecisionFeedback(`Approved and credited ₹${request.amount.toLocaleString('en-IN')}. CEO authorization increased the available quota by ₹${Number(result?.quotaAdjustment).toLocaleString('en-IN')}.`);
      } else if (result?.status !== (approve ? 'APPROVED' : 'REJECTED')) {
        setCompanyDecisionFeedback('The server did not record this decision. The request remains in the review queue; refresh and try again.');
      } else {
        setCompanyDecisionFeedback(approve
          ? request.kind === 'QUOTA_INCREASE' ? 'Approval saved and the employee’s available quota increased. No funds were credited by this quota change.' : 'Approval saved and funds credited to the employee account.'
          : 'Request rejection saved.');
      }
    } catch (error) {
      try {
        const sessionResponse = await fetch('/auth/session?site=guardsaab', { signal: AbortSignal.timeout(2000) });
        const session = await sessionResponse.json() as { user?: GuardSaaBUser | null };
        setUser(session.user ?? null);
        const stateResponse = await fetch('/company-demo-state?site=guardsaab', { signal: AbortSignal.timeout(2000) });
        if (stateResponse.ok) {
          const latest = await stateResponse.json() as { state?: CompanyDemoRecord | null };
          if (latest.state) { setCompanyDemo(latest.state); setCompanyEvents(latest.state.events ?? []); }
        }
      } catch { /* keep the explicit server error below */ }
      setCompanyDecisionFeedback(error instanceof Error ? error.message : 'The decision could not be saved. The request remains pending.');
    } finally {
      setCompanyDecisionBusy(null);
    }
  };
  const verifyChain = async () => {
    if (verifyingChain) return;
    setVerifyingChain(true);
    setChainVerifyNotice(null);
    try {
      const response = await fetch('/audit-chain/verify', { method: 'POST' });
      const data = await response.json() as { status?: AuditChainStatus; error?: string };
      if (response.ok && data.status) {
        setChainStatus(data.status);
        setVerifySuccessFlash(true);
        setTimeout(() => setVerifySuccessFlash(false), 4000);
        setChainVerifyNotice({
          type: data.status.verified ? 'success' : 'error',
          message: data.status.verified
            ? `Cryptographic audit chain verified: ${data.status.count} chained records re-computed from genesis against SHA-256 HMAC checkpoint. Zero tampering detected at ${new Date().toLocaleTimeString('en-IN')}.`
            : `Integrity check failed: ${data.status.error ?? 'Hash mismatch detected in audit chain sequence.'}`,
          timestamp: Date.now(),
        });
        const entriesRes = await fetch('/audit-chain', { signal: AbortSignal.timeout(4000) });
        if (entriesRes.ok) {
          const entriesData = await entriesRes.json() as { status: AuditChainStatus; entries: AuditChainEntry[] };
          if (entriesData.entries) setChainEntries(entriesData.entries);
        }
      } else {
        const errorMsg = data.error ?? (response.status === 401 ? 'GuardSaaB sign-in required to verify audit chain.' : 'Verification failed.');
        setChainStatus((status) => status ? { ...status, verified: false, error: errorMsg } : null);
        setChainVerifyNotice({
          type: 'error',
          message: errorMsg,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Could not reach the local audit store.';
      setChainStatus((status) => status ? { ...status, verified: false, error: errorMsg } : null);
      setChainVerifyNotice({
        type: 'error',
        message: `Connection error: ${errorMsg}`,
        timestamp: Date.now(),
      });
    } finally {
      setVerifyingChain(false);
    }
  };
  const exportAudit = async () => {
    try {
      const response = await fetch('/audit-chain/export');
      if (!response.ok) throw new Error('Audit export is unavailable.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'guardsaab-audit-sanitized.json'; anchor.click(); URL.revokeObjectURL(url);
    } catch { setChainStatus((status) => status ? { ...status, error: 'Could not create the sanitized export. Check GuardSaaB sign-in and local PostgreSQL.' } : null); }
  };

  const guardsaabLogoSrc = theme === 'light' ? '/guardsaab-logo-light.svg' : '/guardsaab-logo.svg';

  if (!isGuardSaaBSite) return <CompanyWorkspace />;
  if (authLoading) return <main className="guardsaab-login">
    <div className="guardsaab-login-glow" />
    <div className="guardsaab-login-card">
      <div className="guardsaab-login-header">
        <img src={guardsaabLogoSrc} alt="GuardSaaB" className="guardsaab-login-logo"/>
        <ThemeToggle portal="guardsaab" theme={theme} onToggle={toggleTheme} className="guardsaab-login-theme-toggle" />
      </div>
      <div className="guardsaab-loading-state">
        <div className="guardsaab-spinner" />
        <p>Connecting to GuardSaaB gateway service…</p>
      </div>
    </div>
  </main>;

  if (!user || !role) return <main className="guardsaab-login">
    <div className="guardsaab-login-glow" />
    <div className="guardsaab-login-card">
      <div className="guardsaab-login-header">
        <img src={guardsaabLogoSrc} alt="GuardSaaB" className="guardsaab-login-logo"/>
        <div className="guardsaab-login-header-actions">
          <div className="guardsaab-status-badge">
            <i className={connected ? 'connected' : ''} />
            <span>{connected ? 'GATEWAY CONNECTED · 127.0.0.1:9000' : 'LOCAL GATEWAY OFFLINE'}</span>
          </div>
          <ThemeToggle portal="guardsaab" theme={theme} onToggle={toggleTheme} className="guardsaab-login-theme-toggle" />
        </div>
      </div>
      <div className="page-kicker">GUARDSAAB AI AGENT GOVERNANCE · CONTROL PLANE</div>
      <h1>Sentinel Console<br/><em>authorized sign in.</em></h1>
      <p>Secure local governance portal for tool-call interception, real-time approvals, and forensic session replay.</p>

      <form className="guardsaab-login-form" onSubmit={signIn}>
        <div className="form-group">
          <label htmlFor="guardsaab-username">Authorized Username</label>
          <div className="input-wrap">
            <input id="guardsaab-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="e.g. nikhil.rao" required/>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="guardsaab-password">Passphrase / Key</label>
          <div className="input-wrap">
            <input id="guardsaab-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter password" required/>
          </div>
        </div>
        {loginError && <div className="guardsaab-login-error" role="alert"><span className="err-icon">⚠</span>{loginError}</div>}
        <button className="guardsaab-submit-btn" disabled={loggingIn}>
          {loggingIn ? (
            <span className="btn-loading"><i className="spinner"/>Authenticating…</span>
          ) : (
            <span>Authorize &amp; Enter Console →</span>
          )}
        </button>
      </form>
      <div className="guardsaab-login-footer">
        <span>Restricted access: HR and CEO accounts only</span>
        <span>HMAC SHA-256 Audit Chain · Local-First Security</span>
      </div>
    </div>
  </main>;

  const nav: { id: Page; label: string; mark: string }[] = [
    { id: 'overview', label: 'Overview', mark: '◫' },
    { id: 'simulator', label: 'Scenario Lab', mark: '⚡' },
    { id: 'agents', label: 'Agents', mark: '⌘' },
    { id: 'approvals', label: 'Approvals', mark: '◷' },
    { id: 'activity', label: 'Activity logs', mark: '≡' },
    { id: 'sessions', label: 'Sessions', mark: '◉' },
  ];
  const pageLabel = nav.find((item) => item.id === page)?.label ?? 'Overview';
  const allEvents = [
    ...visibleCompanyEvents.map((event) => ({ time: event.time, kind: 'Company activity', actor: event.actor, action: event.action, detail: `${event.detail}${event.requestId ? ` · ${event.requestId}` : ''}`, outcome: event.outcome })),
    ...authEvents.map((event) => ({ time: event.time, kind: 'Account activity', actor: event.actor, action: event.action, detail: event.detail, outcome: event.outcome })),
    ...audit.map((event) => ({ time: event.ts, kind: EVENT_META[event.event].label, actor: event.tool ?? event.sessionId ?? 'Agent session', action: event.action ?? '—', detail: `${event.tool ?? ''}${event.ruleId ? ` · ${event.ruleId}` : ''}${event.reason ? ` · ${event.reason}` : ''}`, outcome: event.action ?? (event.viaHitl ? 'REVIEW' : 'INFO') })),
  ].sort((a, b) => b.time - a.time);
  const recentCount = 8;

  return <div className="guardsaab-app dashboard-app">
    <aside className="ops-sidebar">
      <a className="ops-logo" href="/guardsaab" aria-label="GuardSaaB console"><img src={guardsaabLogoSrc} alt="GuardSaaB"/></a>
      <div className="ops-workspace"><span className="ops-workspace-mark">N</span><span><b>Northstar Works</b><small>Governance console</small></span><i>⌄</i></div>
      <span className="ops-nav-label">WORKSPACE</span>
      <nav className="ops-nav">
        {nav.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><span className="ops-nav-mark">{item.mark}</span>{item.label}{item.id === 'approvals' && totalApprovals > 0 && <i>{totalApprovals}</i>}</button>)}
        <a href="/architecture.html" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '11px', height: '36px', padding: '0 11px', color: '#93a8ac', textDecoration: 'none', fontSize: '10px', marginTop: '6px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <span className="ops-nav-mark" style={{ color: '#F59E0B' }}>🏛</span>
          <span style={{ color: '#F1F5F9', fontWeight: 600 }}>Architecture Spec ↗</span>
        </a>
      </nav>
      <div className="ops-sidebar-bottom"><span className="ops-nav-label">SIGNED IN</span><div className="ops-user"><span>{role.slice(0, 1)}</span><div><b>{user.displayName}</b><small>{role} · {user.username}</small></div></div><button className="ops-signout" onClick={signOut}>Sign out</button></div>
    </aside>
    <div className="ops-main-shell">
      <header className="ops-topbar"><div className="ops-breadcrumb"><span>Northstar Works</span><b>/</b><strong>{pageLabel}</strong></div><div className="ops-top-actions"><span className={`ops-connection ${connected ? 'connected' : ''}`}><i/>{connected ? 'Gateway connected' : 'Gateway offline'}</span><ThemeToggle portal="guardsaab" theme={theme} onToggle={toggleTheme} className="ops-theme-toggle" /><button aria-label="Notifications" className="ops-icon-button">♧{totalApprovals > 0 && <i/>}</button><button className="ops-profile" onClick={signOut}><span>{role.slice(0,1)}</span>{role}<b>⌄</b></button></div></header>
      <main className="ops-content">
        {page === 'overview' && <>
          <div className="ops-page-heading"><div><span className="ops-eyebrow">MONDAY, {new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}).toUpperCase()}</span><h1>Governance overview</h1><p>Monitor agent activity, review requests, and follow company policy decisions.</p></div><span className="ops-live-badge"><i/>LIVE WORKSPACE</span></div>
          <section className="ops-metrics"><article><span>Registered agents</span><strong>{String(AGENTS.length).padStart(2,'0')}</strong><small>Across departments</small></article><article><span>Pending approvals</span><strong>{String(totalApprovals).padStart(2,'0')}</strong><small>{totalApprovals ? 'Needs your review' : 'Review queue clear'}</small></article><article><span>Blocked actions</span><strong>{String(blockedCompanyEvents + blockedGatewayEvents).padStart(2,'0')}</strong><small>Stopped by policy</small></article><article><span>High-risk events</span><strong>{String(highRiskEvents).padStart(2,'0')}</strong><small>{highRiskEvents ? 'Requires attention' : 'No critical alerts'}</small></article></section>
          <section className="ops-overview-grid"><div className="ops-panel ops-recent-panel"><div className="ops-panel-heading"><div><span>GOVERNANCE FEED</span><h2>Recent activity</h2></div><button onClick={() => setPage('activity')}>View all logs <b>→</b></button></div>{allEvents.length ? allEvents.slice(0,recentCount).map((event,index)=><div className="ops-feed-row" key={`${event.time}-${index}`}><i className={`ops-feed-dot ${/BLOCK|REJECT/i.test(event.outcome)?'blocked':/REVIEW|HELD|PENDING/i.test(event.outcome)?'review':''}`}/><div><b>{event.actor} <span>· {event.action}</span></b><p>{event.detail}</p></div><time>{ago(event.time,now)}</time><em className={/BLOCK|REJECT/i.test(event.outcome)?'blocked':/REVIEW|HELD|PENDING/i.test(event.outcome)?'review':''}>{event.outcome}</em></div>):<div className="ops-empty">Agent and company events will appear here.</div>}</div>
            <div className="ops-side-stack"><div className="ops-panel ops-agent-summary"><div className="ops-panel-heading"><div><span>FLEET STATUS</span><h2>Agent registry</h2></div><button onClick={() => setPage('agents')}>All agents →</button></div>{AGENTS.map((agent)=><div className="ops-mini-agent" key={agent.id}><span className="ops-agent-glyph">{agent.name.slice(0,1)}</span><div><b>{agent.name}</b><small>{agent.dept}</small></div><i className={agent.status === 'Guarded'?'guarded':''}>{agent.status}</i></div>)}</div><div className="ops-policy-callout"><span>POLICY MONITOR</span><b>Funds stay held<br/>until review.</b><p>Over ₹50,000 goes to HR. Requests above ₹1,00,000 escalate to CEO.</p><button onClick={() => setPage('approvals')}>Open approvals <b>→</b></button></div><div className="ops-policy-callout lab-callout"><span>THREAT SIMULATOR</span><b>Test Agent Security<br/>Live On Screen.</b><p>Fire prompt injections, malicious packages, or HITL holds.</p><button onClick={() => setPage('simulator')}>Open Scenario Lab ⚡ <b>→</b></button></div></div></section>
        </>}
        {page === 'simulator' && (
          <ScenarioLab
            connected={connected}
            onNavigateToApprovals={() => setPage('approvals')}
            onNavigateToActivity={() => setPage('activity')}
            pendingCount={totalApprovals}
            role={role}
          />
        )}
        {page === 'agents' && <><div className="ops-page-heading"><div><span className="ops-eyebrow">WORKSPACE DIRECTORY</span><h1>Agent registry</h1><p>Registered assistants and their current governance status.</p></div><span className="ops-count-pill">{AGENTS.length} agents</span></div><section className="ops-panel"><div className="ops-table-head"><span>AGENT</span><span>DEPARTMENT</span><span>AGENT ID</span><span>STATUS</span></div>{AGENTS.map((agent)=><div className="ops-agent-row" key={agent.id}><div className="ops-agent-name"><span className="ops-agent-glyph">{agent.name.slice(0,1)}</span><span><b>{agent.name}</b><small>{agent.detail}</small></span></div><span>{agent.dept}</span><code>{agent.id}</code><span className={`ops-status ${agent.status === 'Guarded'?'guarded':''}`}><i/>{agent.status}</span></div>)}</section></>}
        {page === 'approvals' && <><div className="ops-page-heading"><div><span className="ops-eyebrow">HUMAN REVIEW QUEUE</span><h1>Approvals</h1><p>Review company fund requests and sensitive agent actions before execution.</p></div><span className="ops-count-pill">{totalApprovals} pending</span></div>{companyDecisionFeedback && <p className="ops-chain-error" role="status">{companyDecisionFeedback}</p>}{companyApprovals.length + pending.length === 0 ? <section className="ops-empty-panel"><span>✓</span><h2>Nothing needs review</h2><p>Requests above the automatic policy limits will appear in this queue.</p></section> : <div className="ops-approval-grid">{companyApprovals.map((request)=>{const duplicateOf=request.kind==='QUOTA_INCREASE'?undefined:companyDemo?.requests.find((candidate)=>candidate.id!==request.id&&candidate.employeeId===request.employeeId&&candidate.kind!=='QUOTA_INCREASE'&&candidate.status==='APPROVED'&&candidate.amount===request.amount&&candidate.purpose.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()===request.purpose.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim())?.id;return <CompanyApproval key={request.id} request={request} employeeName={companyDemo?.employees.find((employee)=>employee.id===request.employeeId)?.name ?? request.employeeId} role={role} onDecide={decideCompany} busy={companyDecisionBusy===request.id} duplicateOf={request.duplicateOf??duplicateOf}/>})}{pending.map((violation)=><SecurityApproval key={violation.id} violation={violation} now={now} onDecide={decide}/>)}</div>}</>}
        {page === 'activity' && <><div className="ops-page-heading"><div><span className="ops-eyebrow">AUDIT &amp; POLICY EVENTS</span><h1>Activity logs</h1><p>Company workflows, account access, and every event received by the local agent gateway.</p></div><span className="ops-live-badge"><i/>{connected ? 'STREAMING' : 'OFFLINE'}</span></div>
          <section className={`ops-panel ops-chain-panel ${chainStatus?.enabled ? (chainStatus.verified ? 'is-verified' : 'is-invalid') : 'is-disabled'}`}>
            <div className="ops-chain-summary">
              <div>
                <span className="ops-eyebrow">LOCAL POSTGRESQL · HMAC SHA-256</span>
                <h2>{chainStatus?.enabled ? chainStatus.verified ? 'Audit chain verified' : 'Integrity check failed' : 'Audit chain unavailable'}</h2>
                <p>{chainStatus?.enabled ? `${chainStatus.count.toLocaleString()} chained events · local checkpoint ${chainStatus.checkpointSeq.toLocaleString()}` : 'Start the local PostgreSQL service and run the engine with npm run engine:local to persist and verify logs.'}</p>
                {chainStatus?.error && <p className="ops-chain-error">{chainStatus.error}</p>}
              </div>
              <div className="ops-chain-actions">
                <button
                  type="button"
                  className={verifySuccessFlash ? 'is-verified' : ''}
                  disabled={!chainStatus?.enabled || verifyingChain}
                  onClick={() => void verifyChain()}
                >
                  {verifyingChain ? 'Verifying…' : verifySuccessFlash ? '✓ Chain Verified' : 'Verify chain'}
                </button>
                <button type="button" disabled={!chainStatus?.enabled} onClick={() => void exportAudit()}>
                  Export sanitized log
                </button>
              </div>
            </div>
            {chainVerifyNotice && (
              <div className={`ops-chain-notice ${chainVerifyNotice.type}`} role="status">
                <span className="notice-icon">{chainVerifyNotice.type === 'success' ? '🛡' : '⚠'}</span>
                <span>{chainVerifyNotice.message}</span>
              </div>
            )}
            {chainStatus?.enabled && <div className="ops-chain-meta"><span>HEAD HASH</span><code title={chainStatus.headHash ?? ''}>{chainStatus.headHash ?? 'No records yet'}</code><span>LAST CHECKED</span><time>{new Date(chainStatus.checkedAt).toLocaleString('en-IN')}</time></div>}
            {chainStatus?.enabled && <div className="ops-chain-entries">{chainEntries.slice(0,5).map((entry)=><div key={entry.id}><b>#{entry.seq} · {entry.stream === 'gateway' ? 'Gateway event' : entry.stream === 'auth' ? 'Account activity' : 'Company workflow'}</b><code>{entry.hash.slice(0,22)}…</code><time>{new Date(entry.recordedAt).toLocaleString('en-IN')}</time></div>)}</div>}
          </section>

          <div className="ops-activity-toolbar">
            <div className="ops-filter-pills" role="tablist" aria-label="Filter activity records">
              <button
                type="button"
                className={`ops-pill-btn ${activityFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActivityFilter('all')}
              >
                All records <i>{activityCounts.all}</i>
              </button>
              <button
                type="button"
                className={`ops-pill-btn blocked ${activityFilter === 'blocked' ? 'active' : ''}`}
                onClick={() => setActivityFilter('blocked')}
              >
                <span className="dot blocked" /> Blocked <i>{activityCounts.blocked}</i>
              </button>
              <button
                type="button"
                className={`ops-pill-btn approved ${activityFilter === 'approved' ? 'active' : ''}`}
                onClick={() => setActivityFilter('approved')}
              >
                <span className="dot approved" /> Approved / Allowed <i>{activityCounts.approved}</i>
              </button>
              <button
                type="button"
                className={`ops-pill-btn pending ${activityFilter === 'pending' ? 'active' : ''}`}
                onClick={() => setActivityFilter('pending')}
              >
                <span className="dot pending" /> Pending / Review <i>{activityCounts.pending}</i>
              </button>
            </div>

            <div className="ops-activity-controls">
              <div className="ops-search-box">
                <input
                  type="text"
                  placeholder="Filter actor, tool, detail…"
                  value={activitySearch}
                  onChange={(e) => setActivitySearch(e.target.value)}
                  aria-label="Filter activity records"
                />
                {activitySearch && (
                  <button type="button" onClick={() => setActivitySearch('')} title="Clear filter">×</button>
                )}
              </div>

              <div className="ops-sort-select-wrap">
                <label htmlFor="activity-sort-select">Sort:</label>
                <select
                  id="activity-sort-select"
                  value={activitySort}
                  onChange={(e) => setActivitySort(e.target.value as any)}
                >
                  <option value="time-desc">Most recent</option>
                  <option value="time-asc">Oldest first</option>
                  <option value="decision-blocked">Blocked first</option>
                  <option value="decision-approved">Approved first</option>
                  <option value="decision-pending">Pending first</option>
                  <option value="actor-asc">Actor (A → Z)</option>
                  <option value="actor-desc">Actor (Z → A)</option>
                </select>
              </div>
            </div>
          </div>

          <section className="ops-panel ops-activity-panel">
            <div className="ops-activity-head">
              <button
                type="button"
                className="head-btn"
                onClick={() => setActivitySort((s) => s === 'actor-asc' ? 'actor-desc' : 'actor-asc')}
                title="Sort by Event or Actor"
              >
                EVENT / ACTOR {activitySort === 'actor-asc' ? '▲' : activitySort === 'actor-desc' ? '▼' : '⇅'}
              </button>
              <button
                type="button"
                className="head-btn"
                onClick={() => setActivitySort((s) => s === 'decision-blocked' ? 'decision-approved' : s === 'decision-approved' ? 'decision-pending' : 'decision-blocked')}
                title="Sort by Decision"
              >
                DECISION {activitySort === 'decision-blocked' ? '▲ Blocked' : activitySort === 'decision-approved' ? '▲ Approved' : activitySort === 'decision-pending' ? '▲ Pending' : '⇅'}
              </button>
              <span>ACTION</span>
              <span>DETAIL</span>
              <button
                type="button"
                className="head-btn"
                onClick={() => setActivitySort((s) => s === 'time-desc' ? 'time-asc' : 'time-desc')}
                title="Sort by Timestamp"
              >
                WHEN {activitySort === 'time-desc' ? '▼' : activitySort === 'time-asc' ? '▲' : '⇅'}
              </button>
            </div>

            {filteredActivityList.map((item) => (
              <div className="ops-log-row" key={item.key}>
                <span className="ops-event-type">{item.actor}</span>
                <span className={`ops-decision ${item.decision === 'BLOCK' ? 'is-blocked' : item.decision === 'ALLOW' ? 'is-allowed' : item.decision === 'PENDING' ? 'is-review' : ''}`}>
                  {item.rawOutcome}
                </span>
                <span className="ops-tool">{item.action}</span>
                <span className="ops-detail">{item.detail}</span>
                <time>{ago(item.timestamp, now)}</time>
              </div>
            ))}

            {filteredActivityList.length === 0 && (
              <div className="ops-empty">
                No activity records found matching the current criteria ({activityFilter !== 'all' ? `filter: ${activityFilter}` : ''}{activitySearch ? ` query: "${activitySearch}"` : ''}).
                <button
                  type="button"
                  className="ops-reset-filter-btn"
                  onClick={() => { setActivityFilter('all'); setActivitySearch(''); }}
                >
                  Reset filters
                </button>
              </div>
            )}
          </section></>}
        {page === 'sessions' && <><div className="ops-page-heading"><div><span className="ops-eyebrow">INVESTIGATION</span><h1>Agent sessions</h1><p>Follow an agent run from its first tool call to its final decision.</p></div></div><SessionsView audit={audit} now={now} initialSession={new URLSearchParams(window.location.search).get('session') ?? undefined}/></>}
      </main>
      <footer className="ops-footer"><span>GUARDSAAB GOVERNANCE · NORTHSTAR WORKS</span><span>{connected ? 'LOCAL GATEWAY CONNECTED' : 'LOCAL GATEWAY DISCONNECTED'}</span></footer>
    </div>
  </div>;
}
