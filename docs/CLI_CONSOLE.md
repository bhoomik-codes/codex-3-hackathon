# GuardSaaB Terminal Control Center & Judge Showcase

The terminal console is a keyboard-first command center for the GuardSaaB governance gateway. It provides automated security benchmarks, real-time WebSocket threat monitoring, arbitrary tool evaluation, and cryptographic audit verification alongside queue approvals and timeline exploration.

## Quick Presentation Commands for Judges

```bash
# 1. Automated threat matrix defense benchmark (Judge Showcase)
npm run showcase

# 2. Live policy evaluation playground (test any command live)
npm run eval -- Bash "cat .env"
npm run eval -- Bash "rm -rf /production-code"
npm run eval -- Bash "git push --force origin main"
npm run eval -- Bash "git status"

# 3. Cryptographic SHA-256 tamper-evident audit ledger verification
npm run audit

# 4. Real-time WebSocket sentinel monitor (streams live agent intercepts)
npm run monitor

# 5. Interactive terminal control center
npm run console
```

---

## Command Reference

| Command | Category | Description |
| --- | --- | --- |
| `showcase` | **Demo Benchmark** | Runs the complete 8-vector threat matrix, measures intercept latency, and outputs an executive scorecard showing 100% interception. |
| `eval <tool> <payload>` | **Interactive Playground** | Submits any arbitrary shell command or tool payload live through the engine and returns signal classifications, risk band, rule ID, and decision badge. |
| `monitor` | **Live Sentinel Stream** | Connects to `ws://127.0.0.1:9000/ws` and streams real-time agent tool-call intercepts, approval holds, and operator verdicts. |
| `audit` | **Compliance & Integrity** | Verifies the cryptographic SHA-256 hash chain of the audit log and validates head block integrity. |
| `status` | **Posture Overview** | Displays engine health, uptime, classifier state, policy status, review queue, and loopback endpoints in an ANSI card. |
| `scenarios` | **Threat Catalog** | Lists all 8 attack vectors with expected verdicts and category mappings. |
| `simulate <name>` | **Single Scenario** | Executes an individual security demonstration with detailed parameter breakdowns. |
| `pending` | **Human-in-the-Loop** | Lists requests held for operator review with risk scores and parameters. |
| `approve <id>` | **Approval Decision** | Authorizes a held agent tool call as `ALLOW`. |
| `deny <id>` | **Block Decision** | Rejects a held agent tool call as `BLOCK`. |
| `activity` | **Session Audit** | Summarizes all recorded autonomous agent sessions with action, block, and hold metrics. |
| `session <id>` | **Timeline** | Displays the chronological event stream for a specific agent session. |

---

## 3-Minute Demo Walkthrough for Judges

When demonstrating GuardSaaB to judges from the terminal, follow this high-impact script:

### Step 1: Health & Governance Posture
Run:
```bash
npm run console status
```
* **Judge talking point**: *"GuardSaaB runs as a low-latency local control plane on loopback, enforcing deterministic JSONLogic policies combined with behavioral anomaly detection, prompt-injection classifiers, and a PostgreSQL-backed audit ledger."*

### Step 2: Automated Threat Matrix Defense Benchmark
Run:
```bash
npm run showcase
```
* **Judge talking point**: *"In under 100 milliseconds, GuardSaaB intercepts prompt-injection credential theft (`.env`), supply-chain malware IOCs (`pip install grokwrapper`), mass deletion (`rm -rf`), and resource exhaustion fork bombs, achieving a 100% threat interception rate while keeping benign commands completely friction-free."*

### Step 3: Interactive Tool Evaluation Playground
Ask the judge: *"Give me any shell command or tool payload to test live."*
Run:
```bash
npm run eval -- Bash "cat ~/.aws/credentials"
# or
npm run eval -- Bash "sysctl -w net.ipv4.ip_forward=1"
```
* **Judge talking point**: *"The engine evaluates the tool payload instantly, assigning a risk band (LOW / MEDIUM / HIGH / CRITICAL) and returning a deterministic verdict with microsecond latency."*

### Step 4: Cryptographic SHA-256 Audit Chain Verification
Run:
```bash
npm run audit
```
* **Judge talking point**: *"Every security decision is cryptographically sealed into a SHA-256 hash-chained block. If an autonomous agent or rogue process attempts to delete or tamper with historical security logs, the chain verification detects the breach immediately."*

### Step 5: Live Real-Time Sentinel Streaming
Open a separate split terminal or background window and run:
```bash
npm run monitor
```
* **Judge talking point**: *"Security operations teams can watch agent actions stream in real time over local WebSockets, receiving instant alerts the second an autonomous agent attempts a suspicious tool call."*
