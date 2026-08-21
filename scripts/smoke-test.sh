#!/usr/bin/env bash
# Full end-to-end verification (plan task #116): builds the whole distribution (if not already
# built), starts agentx-server --dev against a throwaway SQLite database, runs the real
# AgentX-Python SDK against it (scripts/smoke_test.py), then tears down.
#
# Requires OPENAI_API_KEY (Evaluate's judge, Monitor's semantic detector) and Python 3 with
# `pip install agentx-python` available.
#
# SQLite (default) or Postgres, e.g. against a throwaway container:
#   docker run -d --name agentx-pg-test -e POSTGRES_PASSWORD=agentx -e POSTGRES_DB=agentx \
#     -p 55432:5432 postgres:16-alpine
#
# Usage:
#   OPENAI_API_KEY=sk-... ./scripts/smoke-test.sh
#   OPENAI_API_KEY=sk-... AGENTX_DB_URL=postgres://postgres:agentx@localhost:55432/agentx \
#     ./scripts/smoke-test.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY must be set (needed for Evaluate's judge and Monitor's semantic detector)." >&2
  exit 1
fi

if [ ! -f dist/agentx-server ]; then
  echo "dist/agentx-server not found, building..."
  ./build.sh
fi

SMOKE_HOME="$(mktemp -d)"
LOG_FILE="$(mktemp)"
PORT=4799
trap 'kill $SERVER_PID 2>/dev/null || true; rm -rf "$SMOKE_HOME" "$LOG_FILE"' EXIT

echo "Starting agentx-server${AGENTX_DB_URL:+ (against $AGENTX_DB_URL)}..."
# AGENTX_DB_URL, if set in this script's own environment, is inherited by agentx-server (the Go
# CLI forwards its full environment to the engine process it launches, see cli/cmd/server.go).
AGENTX_HOME="$SMOKE_HOME" ./dist/agentx-server --dev --port "$PORT" > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "agentx-server did not become healthy in time. Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# From the endpoint, not the log: the boot banner prints no key. (This previously grepped for a
# "Local API key" line the engine has never printed, so API_KEY silently came out empty.)
API_KEY="$(curl -fsS "http://localhost:$PORT/api/v1/auth/config" | grep -oE 'agtx_local_[A-Za-z0-9_-]+' | head -1)"
if [ -z "$API_KEY" ]; then
  echo "could not read the default project API key from /api/v1/auth/config. Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "Running smoke test against http://localhost:$PORT ..."
AGENTX_API_BASE_URL="http://localhost:$PORT/api/v1" \
AGENTX_API_KEY="$API_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
python3 "$(dirname "$0")/smoke_test.py"
