#!/usr/bin/env bash
set -e

echo "================================================================"
echo "          GUARDSAAB WEB FRONTEND (DOCKER)"
echo "================================================================"
echo "[CONFIG] VITE_HOST:        ${VITE_HOST:-0.0.0.0}"
echo "[CONFIG] PORT:             ${PORT:-5174}"
echo "[CONFIG] VITE_ENGINE_URL:  ${VITE_ENGINE_URL:-http://engine:9000}"
echo "[CONFIG] VITE_WS_URL:      ${VITE_WS_URL:-ws://engine:9000/ws}"

exec "$@"
