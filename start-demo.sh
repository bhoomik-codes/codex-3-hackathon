#!/usr/bin/env bash
# ================================================================
# GuardSaaB - Linux Presentation Launcher
# Starts PostgreSQL (Docker), the GuardSaaB engine, and both web portals.
# ================================================================

set -e

# Resolve script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENGINE_URL="http://127.0.0.1:9000/health"
COMPANY_URL="http://127.0.0.1:5173/"
GUARDSAAB_URL="http://127.0.0.1:5174/"

echo ""
echo "================================================================"
echo "            GUARDSAAB  |  NORTHSTAR WORKS"
echo "               Linux Presentation Launcher"
echo "================================================================"
echo ""

# Verify Node.js 20+
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 20 or newer is required. Please install Node.js."
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[ERROR] Node.js 20+ required. Current version: $(node --version)"
  exit 1
fi

# Verify npm
if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm was not found. Please install npm."
  exit 1
fi

# Ensure credentials.txt exists
if [ ! -f "credentials.txt" ]; then
  if [ -f "credentials.example.txt" ]; then
    echo "[INFO] credentials.txt was missing. Initializing from credentials.example.txt..."
    cp "credentials.example.txt" "credentials.txt"
    chmod 600 "credentials.txt" 2>/dev/null || true
  else
    echo "[ERROR] credentials.txt is missing. Please restore the accounts file."
    exit 1
  fi
fi

# Step 1: Dependencies
echo "[1/5] Checking project dependencies..."
if [ ! -f "node_modules/tsx/dist/cli.mjs" ]; then
  echo "      Installing engine dependencies..."
  npm install
fi

if [ ! -f "dashboard/node_modules/vite/bin/vite.js" ]; then
  echo "      Installing dashboard dependencies..."
  npm --prefix dashboard install
fi

# Step 2: PostgreSQL via Docker
echo ""
# Step 2: PostgreSQL via Docker (with Standalone fallback)
echo ""
echo "[2/5] Checking PostgreSQL container..."
USE_LOCAL_DB=1
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "      [WARN] Docker is not running or not installed."
  echo "             Proceeding in Standalone Mode (in-memory state & file ledger)."
  USE_LOCAL_DB=0
else
  if docker compose up -d --wait postgres 2>/dev/null; then
    echo "      ✓ PostgreSQL is ready on 127.0.0.1:54329."
    USE_LOCAL_DB=1
  else
    echo "      [WARN] PostgreSQL failed to start. Falling back to Standalone Mode."
    USE_LOCAL_DB=0
  fi
fi

# Process cleanup trap
PIDS=()
cleanup() {
  echo ""
  echo "Shutting down GuardSaaB services..."
  for pid in "${PIDS[@]}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "Services stopped cleanly."
}
trap cleanup EXIT INT TERM

# Step 3: Start GuardSaaB Engine
echo ""
echo "[3/5] Starting GuardSaaB engine..."
mkdir -p logs
ENGINE_LOG="logs/engine.log"

if curl -sf "$ENGINE_URL" 2>/dev/null | grep -q '"ready":true'; then
  echo "      ✓ Existing engine is healthy on :9000; reusing it."
else
  if [ "$USE_LOCAL_DB" -eq 1 ]; then
    npm run engine:local >> "$ENGINE_LOG" 2>&1 &
  else
    npm run engine >> "$ENGINE_LOG" 2>&1 &
  fi
  ENGINE_PID=$!
  PIDS+=("$ENGINE_PID")

  echo "      Waiting for engine health check on port 9000..."
  READY=0
  for _ in {1..60}; do
    if curl -sf "$ENGINE_URL" 2>/dev/null | grep -q '"ready":true'; then
      READY=1
      break
    fi
    sleep 1
  done

  if [ "$READY" -ne 1 ]; then
    echo "[ERROR] Engine did not become healthy within 60s. Check /tmp/guardsaab-engine.log."
    exit 1
  fi
  echo "      Engine is healthy and connected to PostgreSQL."
fi

# Step 4: Start frontends
echo ""
echo "[4/5] Starting web portals..."

# Company Workspace (:5173)
if curl -sf "$COMPANY_URL" >/dev/null 2>&1; then
  echo "      Northstar Works site is already running."
else
  npm run dev:company > /tmp/guardsaab-company.log 2>&1 &
  COMPANY_PID=$!
  PIDS+=("$COMPANY_PID")
  for _ in {1..45}; do
    if curl -sf "$COMPANY_URL" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# GuardSaaB Console (:5174)
if curl -sf "$GUARDSAAB_URL" >/dev/null 2>&1; then
  echo "      GuardSaaB Console is already running."
else
  npm run dev:guardsaab > /tmp/guardsaab-console.log 2>&1 &
  GUARDSAAB_PID=$!
  PIDS+=("$GUARDSAAB_PID")
  for _ in {1..45}; do
    if curl -sf "$GUARDSAAB_URL" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

# Step 5: Ollama Check
echo ""
echo "[5/5] Checking local AI availability..."
if curl -sf "http://127.0.0.1:11434/api/tags" 2>/dev/null | grep -q 'models'; then
  echo "      Ollama is online with local model(s)."
else
  echo "      [NOTE] Ollama not detected on :11434. Portals will show offline fallback for AI chat."
fi

echo ""
echo "================================================================"
echo " READY FOR PRESENTATION"
echo ""
echo " Northstar Works company website:  $COMPANY_URL"
echo " GuardSaaB governance console:     $GUARDSAAB_URL"
echo " Engine health:                   $ENGINE_URL"
echo ""
echo " Demo accounts are configured in credentials.txt"
echo " Press Ctrl+C to stop all services."
echo "================================================================"
echo ""

# Attempt to open browsers on Linux
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$COMPANY_URL" >/dev/null 2>&1 || true
  xdg-open "$GUARDSAAB_URL" >/dev/null 2>&1 || true
elif command -v sensible-browser >/dev/null 2>&1; then
  sensible-browser "$COMPANY_URL" >/dev/null 2>&1 || true
  sensible-browser "$GUARDSAAB_URL" >/dev/null 2>&1 || true
fi

# Keep running until Ctrl+C
wait
