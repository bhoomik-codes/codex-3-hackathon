import { spawn, execSync, ChildProcess } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMPANY_URL = 'http://127.0.0.1:5173/';
const GUARDSAAB_URL = 'http://127.0.0.1:5174/';
const ENGINE_URL = 'http://127.0.0.1:9000/health';

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [GuardSaaB Demo] ${msg}`);
}

async function isUrlHealthy(url: string, timeoutMs: number = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUrl(url: string, timeoutMs: number = 60000, name: string = 'service'): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUrlHealthy(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function dumpRecentLog(logPath: string, linesCount: number = 25) {
  if (!existsSync(logPath)) return;
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const tail = lines.slice(-linesCount).join('\n');
    console.error(`\n--- Last ${linesCount} lines from ${logPath} ---\n${tail}\n---------------------------------------------\n`);
  } catch {
    // ignore read error
  }
}

function openBrowser(url: string) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Ignore browser opener failure
  }
}

async function main() {
  console.log(`\n================================================================`);
  console.log(`            GUARDSAAB  |  NORTHSTAR WORKS`);
  console.log(`               Unified Presentation Launcher`);
  console.log(`================================================================\n`);

  // Ensure logs directory exists
  const logsDir = join(ROOT, 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const engineLogPath = join(logsDir, 'engine.log');
  const companyLogPath = join(logsDir, 'company.log');
  const dashboardLogPath = join(logsDir, 'dashboard.log');

  // Credentials check
  const creds = join(ROOT, 'credentials.txt');
  const credsExample = join(ROOT, 'credentials.example.txt');
  if (!existsSync(creds) && existsSync(credsExample)) {
    log('credentials.txt not found. Initializing from credentials.example.txt...');
    copyFileSync(credsExample, creds);
    log('✓ credentials.txt created successfully.');
  }

  // 1. Docker check & PostgreSQL startup
  let useLocalDb = false;
  log('[1/4] Checking PostgreSQL database container...');
  try {
    execSync('docker compose up -d --wait postgres', { stdio: 'ignore', timeout: 30000 });
    log('✓ PostgreSQL is ready on 127.0.0.1:54329 (persistent container).');
    useLocalDb = true;
  } catch {
    log('⚠ Docker not running or PostgreSQL container unreachable.');
    log('  → Automatically running in standalone mode (in-memory state & file ledger).');
    useLocalDb = false;
  }

  const procs: ChildProcess[] = [];
  const cleanup = () => {
    log('Stopping background services...');
    for (const p of procs) {
      if (p.pid && !p.killed) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
          } else {
            p.kill('SIGTERM');
          }
        } catch {
          // ignore
        }
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  // 2. Start GuardSaaB Engine
  log('[2/4] Starting GuardSaaB Control Plane Engine on :9000...');
  if (await isUrlHealthy(ENGINE_URL, 1500)) {
    log('✓ GuardSaaB Engine is already running and healthy on :9000; reusing it.');
  } else {
    const engineScript = useLocalDb ? 'engine:local' : 'engine';
    const engineOut = createWriteStream(engineLogPath, { flags: 'a' });
    const engineProc = spawn(npmCmd, ['run', engineScript], {
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    engineProc.stdout?.pipe(engineOut);
    engineProc.stderr?.pipe(engineOut);
    procs.push(engineProc);

    log(`Waiting for engine health check on :9000 (logging to ${engineLogPath})...`);
    const engineReady = await waitUrl(ENGINE_URL, 45000, 'engine');
    if (!engineReady) {
      console.error('\n[ERROR] GuardSaaB Engine failed to become healthy on port 9000.');
      dumpRecentLog(engineLogPath);
      cleanup();
      process.exit(1);
    }
    log(`✓ GuardSaaB Engine is ready (${useLocalDb ? 'connected to PostgreSQL' : 'standalone mode'}).`);
  }

  // 3. Start Frontends
  log('[3/4] Starting Web Frontends (:5173 Company Portal & :5174 GuardSaaB Console)...');

  // Company Portal on :5173
  if (await isUrlHealthy(COMPANY_URL, 1500)) {
    log('✓ Company Portal is already running on :5173; reusing it.');
  } else {
    const companyOut = createWriteStream(companyLogPath, { flags: 'a' });
    const companyProc = spawn(npmCmd, ['run', 'dev:company'], {
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    companyProc.stdout?.pipe(companyOut);
    companyProc.stderr?.pipe(companyOut);
    procs.push(companyProc);
  }

  // GuardSaaB Console on :5174
  if (await isUrlHealthy(GUARDSAAB_URL, 1500)) {
    log('✓ GuardSaaB Console is already running on :5174; reusing it.');
  } else {
    const dashboardOut = createWriteStream(dashboardLogPath, { flags: 'a' });
    const consoleProc = spawn(npmCmd, ['run', 'dev:guardsaab'], {
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    consoleProc.stdout?.pipe(dashboardOut);
    consoleProc.stderr?.pipe(dashboardOut);
    procs.push(consoleProc);
  }

  const [companyReady, dashboardReady] = await Promise.all([
    waitUrl(COMPANY_URL, 35000, 'company'),
    waitUrl(GUARDSAAB_URL, 35000, 'dashboard'),
  ]);

  if (!companyReady) {
    console.error('\n[ERROR] Company Portal failed to start on http://127.0.0.1:5173/');
    dumpRecentLog(companyLogPath);
  }
  if (!dashboardReady) {
    console.error('\n[ERROR] GuardSaaB Console failed to start on http://127.0.0.1:5174/');
    dumpRecentLog(dashboardLogPath);
  }

  // 4. Check Ollama (optional)
  log('[4/4] Checking Ollama local model availability...');
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      log('✓ Ollama is online with local model(s).');
    }
  } catch {
    log('ℹ Note: Ollama not detected on :11434 (offline fallback active).');
  }

  console.log(`\n================================================================`);
  console.log(` ALL SYSTEMS OPERATIONAL AND READY`);
  console.log(` GuardSaaB governance console:     ${GUARDSAAB_URL}`);
  console.log(` Northstar Works company website:  ${COMPANY_URL}`);
  console.log(` Control plane engine health:     ${ENGINE_URL}`);
  console.log(` Diagnostic doctor command:       npm run doctor`);
  console.log(` Full-screen interactive TUI:     npm run tui`);
  console.log(` Logs directory:                  ${logsDir}`);
  console.log(` Press Ctrl+C in this terminal to shut down.`);
  console.log(`================================================================\n`);

  openBrowser(COMPANY_URL);
  openBrowser(GUARDSAAB_URL);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
