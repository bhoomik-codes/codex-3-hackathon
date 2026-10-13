# GuardSaaB Terminal Control Center & Judge Showcase

The terminal console is a keyboard-first command center for the GuardSaaB governance gateway. It provides automated security benchmarks, real-time WebSocket threat monitoring, arbitrary tool evaluation, and cryptographic audit verification alongside queue approvals, agent directory inspection, and timeline exploration.

## Quick Presentation Commands for Judges

```bash
# 1. Full-screen Interactive Agent Sandbox TUI (Judge Playground + Live GUI-Synced Audit Log)
npm run tui

# 2. Automated threat matrix defense benchmark (Judge Showcase)
npm run showcase

# 3. Live policy evaluation playground (test any command live)
npm run eval -- Bash "cat .env"
npm run eval -- Bash "rm -rf /production-code"
npm run eval -- Bash "git push --force origin main"
npm run eval -- Bash "git status"

# 4. Cryptographic SHA-256 tamper-evident audit ledger verification
npm run audit

# 5. Real-time WebSocket sentinel monitor (streams live agent intercepts)
npm run monitor

# 6. Interactive terminal control center
npm run console
```

---

## Command Reference

The console can be run interactively or as a one-shot CLI:

```bash
npm run console -- <command>
# or
guardsaab console <command>
```

The engine is local-only by default at `127.0.0.1:9000`. Configure another loopback endpoint with `ENGINE_HOST` and `ENGINE_PORT` (or `CB_ENGINE_HOST` / `CB_ENGINE_PORT`).

### Command Groups

#### Judge Showcase & Real-Time Defense

| Command | Category | Description |
| --- | --- | --- |
| `showcase` | **Demo Benchmark** | Runs the complete 8-vector threat matrix, measures intercept latency, and outputs an executive scorecard showing 100% interception. |
| `eval <tool> <payload>` | **Interactive Playground** | Submits any arbitrary shell command or tool payload live through the engine and returns signal classifications, risk band, rule ID, and decision badge (with live dashboard socket-hold if review required). |
| `monitor` | **Live Sentinel Stream** | Connects to `ws://127.0.0.1:9000/ws` and streams real-time agent tool-call intercepts, approval holds, and operator verdicts. |
| `audit` | **Compliance & Integrity** | Verifies the cryptographic SHA-256 hash chain of the audit log and validates head block integrity. |

#### Dashboard & Operations

| Command | Website equivalent | What it does |
| --- | --- | --- |
| `overview` | Overview | Shows gateway status, registered-agent count, held approvals, blocked-action count, and storage posture. Supports `--json`. |
| `agents` | Agents | Shows the registered agent directory, department, state, and responsibility. Supports `--status`, `--department`, `--json`. |
| `status` | System status | Shows engine health, uptime, classifier state, policy status, review queue, and loopback endpoints. Supports `--json`. |
| `policies` | Policies | Lists the loaded rule directory. Filter by action or search text. Supports `--action`, `--search`, `--limit`, `--json`. |
| `scenarios` | Threat Catalog | Lists the built-in security demonstrations. Supports `--json`. |
| `simulate <name>` | Run Scenario | Sends a simulated tool-call payload through the live policy engine and prints its actual verdict, rule, reason, and risk band. Supports `--session`, `--json`. |
| `pending` | Approvals | Displays held requests, including tool inputs and risk scores. Supports `--risk`, `--tool`, `--limit`, `--json`. |
| `approve <id>` | Approve | Resolves a pending request as `ALLOW`. |
| `deny <id>` | Reject | Resolves a pending request as `BLOCK`. |
| `activity` | Activity Logs | Shows recent sanitized gateway audit events, their verdicts, risk, and session references. Supports `--limit`, `--action`, `--session`, `--search`, `--json`. |
| `sessions` | Sessions | Lists recorded agent sessions and their decision totals. Supports `--blocked`, `--limit`, `--json`. |
| `session <id>` | Session timeline | Displays the selected session's event history. Supports `--json`. |
| `completion <shell>` | Shell completion | Emits shell completion scripts for `bash`, `zsh`, or `fish`. |

Subcommand syntax forms are fully supported for automation:
```bash
guardsaab console dashboard overview
guardsaab console agent list --status Guarded
guardsaab console agent list --department Engineering --json
guardsaab console policy list --action BLOCK --limit 20
guardsaab console scenario run resource-bomb --session demo-01
guardsaab console approval list --risk HITL
guardsaab console approval approve <id>
guardsaab console approval deny <id>
guardsaab console activity list --action BLOCK --limit 25
guardsaab console session list --blocked
guardsaab console session show <id>
guardsaab console system status
```

---

## Flags and Automation

All read/list commands support `--json` for scripts and CI. `--limit N` accepts `1` through `500` and is available on policy, approval, activity, and session lists.

| Command | Flags | Meaning |
| --- | --- | --- |
| `agent list` | `--status STATE`, `--department NAME`, `--json` | Filter the local agent registry. |
| `policy list` | `--action ACTION`, `--search TEXT`, `--limit N`, `--json` | Filter policies by `ALLOW`, `HITL`, or `BLOCK`; match text in ID/description. |
| `scenario list` | `--json` | Emit the built-in scenario catalogue. |
| `scenario run` | `--session ID`, `--json` | Associate a simulation with a known session ID; emit the complete verdict object. |
| `approval list` | `--risk BAND`, `--tool NAME`, `--limit N`, `--json` | Filter held actions by risk band or tool name. |
| `activity list` | `--limit N`, `--action ACTION`, `--session ID`, `--search TEXT`, `--json` | Filter audit events by decision/risk band, session, or free text. |
| `session list` | `--blocked`, `--limit N`, `--json` | Show only sessions that include blocks, cap output, or emit JSON. |

Examples:
```bash
# Obtain structured, machine-readable blocked rules
guardsaab console policy list --action BLOCK --json

# Print recent block events for an investigation
guardsaab console activity list --session incident-104 --action BLOCK --json

# Use a deterministic session identifier during a demo
guardsaab console scenario run untrusted-binary --session jury-demo --json
```

Flags accept either `--flag value` or `--flag=value` form. Unknown flags fail immediately with validation feedback.

---

## Built-in Command Help & Completion

Every console command accepts `--help` (or `-h`). Help works offline without a running engine:

```bash
guardsaab console --help
guardsaab console policy list --help
guardsaab console scenario run --help
guardsaab console approval approve --help
guardsaab console activity list --help
guardsaab console session show --help
```

Shell completion:
```bash
# Display the console version without contacting the engine
guardsaab console --version

# Enable completion for the current Bash session
source <(guardsaab console completion bash)

# Persist completion in Zsh or Fish
guardsaab console completion zsh
guardsaab console completion fish
```

---

## 3-Minute Demo Walkthrough for Judges

When demonstrating GuardSaaB to judges from the terminal, follow this high-impact script:

### Step 1: Health & Governance Posture
Run:
```bash
npm run console status
# or
guardsaab console system status
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
# or
npm run eval -- Bash "git push --force origin main"
```
* **Judge talking point**: *"The engine evaluates the tool payload instantly, assigning a risk band (LOW / MEDIUM / HIGH / CRITICAL) and returning a deterministic verdict with microsecond latency. High-impact operations hold live for human review on the dashboard."*

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
