# GuardSaaB — Quickstart & Deployment Guide

> **For Hackathon Judges & Reviewers**: GuardSaaB can be launched in **under 30 seconds** on any Windows, macOS, or Linux machine using either **Docker** or **Node.js**.

---

## 🚀 Quick Launch (Choose Your Preferred Method)

### Method 1: Pure Docker (Zero Node.js Required)

If you have Docker installed, you can spin up the entire ecosystem (PostgreSQL, Control Plane Engine, Governance Console, and Company Portal) with one command:

```bash
docker compose up --build
```

**Services will be live at:**
* **GuardSaaB Governance Console**: [http://localhost:5174](http://localhost:5174)
* **Northstar Works Company Portal**: [http://localhost:5173](http://localhost:5173)
* **Control Plane API & Health**: [http://localhost:9000/health](http://localhost:9000/health)
* **PostgreSQL Database**: `localhost:54329`

To stop: `docker compose down`

---

### Method 2: One-Click Native Demo (Cross-Platform)

If you have Node.js 20+ installed:

#### Windows
Double-click [`start-demo.bat`](start-demo.bat) or run in PowerShell:
```powershell
.\start-demo.bat
```

#### macOS / Linux
Grant execution permissions and run [`start-demo.sh`](start-demo.sh):
```bash
chmod +x start-demo.sh
./start-demo.sh
```

#### Any Platform via npm
```bash
npm run demo
```

* Automatically detects and starts PostgreSQL if Docker is available.
* If Docker is not running, **automatically falls back to Standalone Mode** (in-memory state & local file ledger) so the demo never crashes!
* Auto-initializes `credentials.txt` if missing.
* Opens both portals in your browser.

---

## 🩺 Diagnostic Doctor: "Why is the project not running?"

If you ever encounter an issue on a new PC (e.g. port taken, outdated Node version, missing packages), run the built-in diagnostic doctor:

```bash
npm run doctor
```

The Doctor automatically runs 13 system-level pre-flight checks:
* **Node.js runtime version** (verifies Node 20+)
* **Port availability**:
  * `:9000` (Engine API & WebSocket)
  * `:5173` (Northstar Works Portal)
  * `:5174` (GuardSaaB Governance Console)
  * `:54329` (PostgreSQL Local)
* **Conflict detection**: If a port is occupied by another app, identifies it and gives the exact command to free it.
* **Credentials verification**: Ensures `credentials.txt` has valid accounts.
* **Security policy validation**: Parses all 43 rules in `rules/default_policy.yaml`.
* **Docker daemon & container status**.
* **Logs directory and recent error scans**.

---

## 🎮 Interactive Features for Judges

### 1. Full-Screen Interactive Sandbox TUI
Judges can test attack payloads live in a full-screen terminal interface:

```bash
npm run tui
```

* **Live Human-in-the-Loop (HITL)**: Type `git push --force origin main` (or press `!1`) and watch the TUI place the action on `⏸ HOLD`, dispatching a real approval request to the Web Dashboard at [http://127.0.0.1:5174](http://127.0.0.1:5174)!
* **Live Sync**: Approve or reject on the web dashboard (or press `[A]` / `[D]` in the TUI), and watch both interfaces update in real time.
* **Quick Presets**: Press `[!1]` to `[!8]` to test credential exfiltration, destructive `rm -rf`, supply-chain malware, fork bombs, and benign commands.
* **Mouse Wheel Scrolling**: Smoothly scroll the Sandbox or Live Audit Log with your mouse wheel.

### 2. Automated Defense Benchmark (Scorecard)
Runs an automated suite across all 8 threat vectors with sub-millisecond latencies:

```bash
npm run showcase
```

### 3. Cryptographic Audit Ledger Verification
Mathematically verifies the SHA-256 Merkle chain integrity of the local audit ledger:

```bash
npm run audit
```

### 4. Live Policy Evaluator
Test any arbitrary command directly against the security gate:

```bash
npm run eval -- Bash "cat .env"
npm run eval -- Bash "git push --force origin main"
npm run eval -- Bash "rm -rf /production-code"
```

---

## 📁 Structured Logging Directory

All service logs are automatically written to `logs/` for complete auditability and troubleshooting:

* `logs/engine.log`: Control plane engine API, WebSocket, and rule evaluations.
* `logs/dashboard.log`: GuardSaaB Governance Console frontend server logs.
* `logs/company.log`: Northstar Works Portal frontend server logs.

If any service fails during startup, the launcher automatically extracts and prints the last 25 lines of the relevant log file directly to your terminal.

---

## ⚙️ Default Credentials (for Login)

Sign in to the portals at [http://127.0.0.1:5174](http://127.0.0.1:5174) or [http://127.0.0.1:5173](http://127.0.0.1:5173):

| Role | Username | Password | Permissions |
| :--- | :--- | :--- | :--- |
| **Security Admin / SOC** | `security.admin` | `AuditAdmin#2026!` | Full governance access, approve all holds |
| **CEO / Executive** | `arjun.mehta` | `ArjunExecutive#2026!` | Approve high-value fund requests (> ₹2,00,000) |
| **HR Director** | `kavita.sharma` | `KavitaHR#2026!` | Review employee quota requests |
| **Finance Controller**| `rohit.verma` | `RohitFinance#2026!` | Inspect audit ledger & transfer chains |
| **Staff Engineer** | `maya.iyer` | `MayaEngineer#2026!` | Standard developer agent sandbox |

---

## ❓ Troubleshooting FAQ

### 1. `Error: listen EADDRINUSE: address already in use :::9000`
Another process is using port 9000. Run:
```bash
npx kill-port 9000 5173 5174
```
Or run `npm run doctor` to identify the conflicting process.

### 2. `credentials.txt is missing`
Run:
```bash
cp credentials.example.txt credentials.txt
```
*(On Windows: `copy credentials.example.txt credentials.txt`)*

### 3. Docker is not running on my PC
No problem! The demo launchers (`npm run demo`, `start-demo.bat`, `start-demo.sh`) will automatically detect this and switch to **Standalone Mode** using local memory and JSONL files.
