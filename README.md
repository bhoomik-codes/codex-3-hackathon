# GuardSaaB

**Software as a Blockade.** GuardSaaB is a local-first control plane for AI agent actions, with policy decisions, human approvals, activity logs, session review, and a separate Northstar Works company workspace for the live HR and finance scenario.

Both websites, the shared engine, database setup, policies, documentation, and launch scripts are tracked together in this repository.

## Tech Stack

GuardSaaB is architected as a local-first, low-latency control plane and dual-portal demonstration platform:

* **Engine & Security Gateway**:
  * **Runtime**: Node.js 20+ (ESM & TypeScript 5.7+)
  * **Networking**: Native HTTP engine + WebSocket server ([`ws`](https://github.com/websockets/ws)) on `127.0.0.1:9000`
  * **Policy Evaluation**: Deterministic [JsonLogic](https://jsonlogic.com/) engine with YAML policy definitions ([`js-yaml`](https://github.com/nodeca/js-yaml))
  * **Cryptographic Audit Chain**: SHA-256 tamper-evident Merkelized audit chain, PKCS#7 / HMAC verification, and automated secret redaction for credentials (AWS, GitHub, Bearer tokens, private keys)
* **Frontend Portals** (Dashboard):
  * **Framework**: React 18 / 19 with TypeScript, powered by [Vite 6](https://vitejs.dev/)
  * **Styling**: Curated responsive design system with CSS custom properties, dark-mode cockpit styling, and live status visualizers
  * **Northstar Works (`127.0.0.1:5173`)**: Corporate intranet simulating employee self-service, manager reviews, and the Zeo financial assistant
  * **GuardSaaB Governance Console (`127.0.0.1:5174`)**: Agent telemetry, live audit stream, Human-in-the-Loop (HITL) approval queues, and policy simulation
* **Data & Persistence**:
  * **Database**: PostgreSQL 16 managed via Docker Compose (`127.0.0.1:54329`)
  * **Client**: High-throughput connection pooling via [`pg`](https://github.com/brianc/node-postgres)
  * **Immutability**: PostgreSQL database triggers enforcing append-only guarantees (blocking UPDATE/DELETE queries on audit records)
* **Agent Integrations & AI**:
  * **Codex CLI**: Native Python PreToolUse gate hook ([`scripts/guardsaab_codex_hook.py`](scripts/guardsaab_codex_hook.py))
  * **Model Context Protocol (MCP)**: JSON-RPC tool-call inspection, intercept, and mediation
  * **Local LLM**: Optional Ollama integration on `127.0.0.1:11434` for local conversational intelligence
* **Testing & Tooling**:
  * `tsx` TypeScript runtime, Docker Compose, Python `unittest`, end-to-end regression suites, and origin/CSWSH security harnesses

---

## Startup Instructions

GuardSaaB includes unified, automated demo launchers for **Windows**, **Linux**, and **macOS**. Each launcher verifies dependencies, starts PostgreSQL via Docker, boots the GuardSaaB engine, starts both frontend workspaces, checks Ollama availability, and opens the portals in your default browser.

### Prerequisites

* **Option A (Docker)**: Docker Desktop / Docker Engine with Docker Compose (No Node.js needed!)
* **Option B (Native)**: Node.js v20+ with `npm`
* **(Optional) Ollama**: Running on `http://127.0.0.1:11434` for local LLM responses (an offline fallback is included if Ollama is not installed)

---

### Option 0: Pure Docker (Zero Node.js Required)

Spin up the complete environment (PostgreSQL, Control Plane Engine, Governance Console, Company Portal) with one command:

```bash
docker compose up --build
```
* **GuardSaaB Console**: http://localhost:5174
* **Company Portal**: http://localhost:5173
* **Engine API**: http://localhost:9000/health

---

### Diagnostics: "Why is the project not running?"

Run the pre-flight diagnostic checker to test ports, Node version, Docker, and credentials:

```bash
npm run doctor
```

---

### Option 1: Automated Launchers by Operating System

#### Windows
Double-click [`start-demo.bat`](start-demo.bat) in File Explorer, or run in Command Prompt / PowerShell:
```cmd
.\start-demo.bat
```

#### Linux
Grant execution permissions once and execute [`start-demo.sh`](start-demo.sh):
```bash
chmod +x start-demo.sh
./start-demo.sh
```

#### macOS
Double-click [`start-demo.command`](start-demo.command) in Finder, or run in Terminal:
```bash
chmod +x start-demo.command
./start-demo.command
```

#### Cross-Platform (Any OS via npm)
You can also launch the full stack directly with npm on any platform:
```bash
npm run demo
```

---

### Option 2: Step-by-Step Manual Startup

If you prefer to start each service individually:

1. **Install dependencies**:
   ```bash
   npm install
   npm --prefix dashboard install
   ```

2. **Start PostgreSQL database**:
   ```bash
   npm run db:up
   ```

3. **Start the GuardSaaB engine**:
   ```bash
   npm run engine:local
   ```
   *Health endpoint will become available at `http://127.0.0.1:9000/health`.*

4. **Start the web applications** (in separate terminal tabs):
   ```bash
   # Northstar Works company portal
   npm run dev:company    # http://127.0.0.1:5173

   # GuardSaaB governance cockpit
   npm run dev:guardsaab  # http://127.0.0.1:5174
   ```

---

### Demo Accounts & Credentials

The application includes seven synthetic user accounts configured in `credentials.txt` (a template is available in [`credentials.example.txt`](credentials.example.txt)):

| Role | Username | Display Name | Permissions |
| :--- | :--- | :--- | :--- |
| **Employee** | `maya.iyer` | Maya Iyer | Submit requests, view own records & ledger |
| **Employee** | `arjun.mehta` | Arjun Mehta | Submit requests, view own records & ledger |
| **Employee** | `leela.das` | Leela Das | Submit requests, view own records & ledger |
| **Employee** | `kabir.shah` | Kabir Shah | Submit requests, view own records & ledger |
| **Employee** | `priya.nair` | Priya Nair | Submit requests, view own records & ledger |
| **HR** | `nikhil.rao` | Nikhil Rao | Review & approve requests up to ₹100,000 / quota up to ₹200,000 |
| **CEO** | `ananya.menon` | Ananya Menon | Full executive approval, quota overrides, enterprise audit oversight |

*Passwords are listed in [`credentials.example.txt`](credentials.example.txt).*

---

## Walkthrough

1. Sign in to Northstar Works as an employee and ask Zeo for an allowed amount or a request requiring HR review.
2. Follow the policy result in the employee request list and the GuardSaaB **Approvals** or **Activity logs** view.
3. Sign in to GuardSaaB as HR or CEO, review the request, and approve or reject it.
4. Confirm approved funds are added to the employee's simulated company ledger and the activity is recorded.
5. Use the **Agents**, **Policies**, **Sessions**, and **Activity logs** areas to explore gateway governance.

Use only the synthetic Northstar Works records provided for the presentation. Account credits are ledger entries; no external bank or payroll service is connected.

## Policy, audit, and operations

- [Policy authoring and validation](POLICY_GUIDE.md)
- [Audit storage, export, recovery, and rotation](OPERATIONS.md)
- [Security boundary review and tested fixes](SECURITY_REVIEW.md)
- [Presentation walkthrough](JURY_DEMO_GUIDE.md)
- [Change context](CONTEXT_CHANGES.md)

Validate policy files and build the application:

```powershell
node bin/guardsaab.mjs rules validate
npm run typecheck
npm run build
```

Selected automated checks:

```powershell
npm run test:policy-validation
npm run test:audit-sanitize
npm run test:postgres-audit
npm run test:regression
```

## Terminal governance console & judge showcase

GuardSaaB includes a full-featured terminal companion and presentation center. It exposes live health posture, automated threat defense benchmarks, live tool evaluation, real-time WebSocket sentinel streaming, cryptographic audit verification, approvals, and activity timelines:

```bash
# Automated threat defense benchmark (Judge Showcase)
npm run showcase

# Real-time policy evaluation playground (test any command live)
npm run eval -- Bash "cat .env"
npm run eval -- Bash "rm -rf /production-code"

# Cryptographic SHA-256 audit ledger verification
npm run audit

# Real-time WebSocket streaming sentinel
npm run monitor

# Interactive terminal control center
npm run console
```

See [the full terminal-console and judge presentation guide](docs/CLI_CONSOLE.md).

The PostgreSQL audit integration check requires a reachable database configured with `GUARDSAAB_TEST_DATABASE_URL`. The GitHub Actions workflow provisions PostgreSQL for this check.

## Project documentation

See [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) for the current state, [docs/ROADMAP.md](docs/ROADMAP.md) for milestones, [docs/BASE_REPOSITORY.md](docs/BASE_REPOSITORY.md) for the codebase assessment, and [docs/INTEGRATION_MATRIX.md](docs/INTEGRATION_MATRIX.md) for coverage and limitations.

Start with [the product specification](docs/PRODUCT_SPEC.md), [architecture](docs/ARCHITECTURE.md), [security model](docs/SECURITY_MODEL.md), and [known limitations](docs/KNOWN_LIMITATIONS.md).

## Project identity and notices

GuardSaaB is the product name used by the interfaces, setup commands, and current project documentation. The repository includes third-party code and retains its applicable license, copyright, and notice files. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); those legal notices are part of the source distribution.

The product builds on inherited agent gateway and policy components and adds the GuardSaaB presentation, Northstar Works workspace, Zeo integration, role-scoped approval flow, PostgreSQL-backed company state, audit sanitization, and audit-chain storage. The included security review describes its limits; this prototype is not a bank, payroll provider, identity service, or production security guarantee.
