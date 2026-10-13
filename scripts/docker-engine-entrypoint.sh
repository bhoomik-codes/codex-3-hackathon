#!/usr/bin/env bash
set -e

echo "================================================================"
echo "         GUARDSAAB CONTROL PLANE ENGINE (DOCKER)"
echo "================================================================"

# Initialize credentials.txt if not present
if [ ! -f /app/credentials.txt ]; then
  if [ -f /app/credentials.example.txt ]; then
    echo "[INFO] credentials.txt missing in volume; seeding from credentials.example.txt..."
    cp /app/credentials.example.txt /app/credentials.txt
  fi
fi

# Print environment summary for diagnostics
echo "[CONFIG] ENGINE_HOST:       ${ENGINE_HOST:-0.0.0.0}"
echo "[CONFIG] ENGINE_PORT:       ${ENGINE_PORT:-9000}"
echo "[CONFIG] STATE_DIR:         ${CB_STATE_DIR:-/app/.cerberus}"
echo "[CONFIG] DATABASE_URL:      ${GUARDSAAB_DATABASE_URL:-(in-memory / file mode)}"

# Execute main process
exec "$@"
