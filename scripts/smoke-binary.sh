#!/usr/bin/env bash
# Smoke-tests the compiled engine binary - the artifact release.yml actually ships.
#
# Everything under engine/src/test runs through tsx, which storage/db.ts serves with
# better-sqlite3. The binary takes the bun:sqlite branch instead, so none of that suite says
# anything about it. This covers boot, a write, a read back, the dev-mode dashboard path, and a
# clean SIGTERM.
set -euo pipefail

BIN="${1:?usage: smoke-binary.sh <path-to-agentx-engine>}"
PORT="${PORT:-8971}"
WORK="$(mktemp -d)"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

export AGENTX_HOME="$WORK/home"
mkdir -p "$AGENTX_HOME"

fail() { echo "FAIL: $*" >&2; [ -f "$WORK/engine.log" ] && tail -30 "$WORK/engine.log" >&2; exit 1; }

PORT="$PORT" "$BIN" > "$WORK/engine.log" 2>&1 &
PID=$!
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break
  kill -0 "$PID" 2>/dev/null || fail "the binary exited during boot"
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || fail "never became healthy"
echo "ok: boots and serves /health"

# Not from the log - the banner deliberately prints no key. Auth-disabled mode serves it to any
# caller on this port, which is also how the dashboard gets it.
KEY="$(curl -sf "http://127.0.0.1:$PORT/api/v1/auth/config" | grep -oE 'agtx_local_[A-Za-z0-9_-]+' | head -1)"
[ -n "$KEY" ] || fail "no API key from /api/v1/auth/config"

# A real write through bun:sqlite, including the timestamp parsing that used to kill the process.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/v1/ingest/traces" \
  -H 'Content-Type: application/json' -H "X-API-Key: $KEY" \
  -d '{"name":"smoke","input":"in","output":"out","started_at_unix_nano":"1700000000000000000"}')
[ "$code" = "200" ] || fail "ingest returned $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/v1/ingest/traces" \
  -H 'Content-Type: application/json' -H "X-API-Key: $KEY" \
  -d '{"name":"smoke","input":"in","output":"out","started_at_unix_nano":"yesterday"}')
[ "$code" = "200" ] || fail "a malformed timestamp returned $code instead of being tolerated"
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || fail "the malformed timestamp killed the process"
echo "ok: writes through bun:sqlite, and a bad timestamp does not kill it"

# A read back over the same driver.
code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $KEY" \
  "http://127.0.0.1:$PORT/api/v1/agent-monitoring/signals")
[ "$code" = "200" ] || fail "signals read returned $code"
echo "ok: reads back through bun:sqlite"

# SIGTERM is where better-sqlite3 aborted under Node 24; the binary must still exit cleanly.
kill -TERM "$PID"
for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then fail "did not exit within 20s of SIGTERM"; fi
wait "$PID" 2>/dev/null && status=0 || status=$?
[ "$status" = "0" ] || fail "exited $status on SIGTERM rather than shutting down cleanly"
PID=""
grep -q "Shutdown complete" "$WORK/engine.log" || fail "no graceful-shutdown log line"
echo "ok: shuts down cleanly on SIGTERM"

# Dev mode used to derive its download path from import.meta.url, which under a compiled binary
# resolves inside Bun's virtual filesystem - so this extracted the dashboard into /web.
[ -e /web ] && fail "/web exists before the dev-mode check; cannot attribute it"
BINDIR="$(cd "$(dirname "$BIN")" && pwd)"
rm -rf "$BINDIR/web"
PORT="$((PORT + 1))" "$BIN" --dev > "$WORK/dev.log" 2>&1 &
PID=$!
for _ in $(seq 1 180); do
  curl -sf -o /dev/null "http://127.0.0.1:$((PORT + 1))/health" && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
kill "$PID" 2>/dev/null || true
PID=""
if [ -e /web ]; then
  rm -rf /web
  fail "dev mode wrote the dashboard bundle to the filesystem root"
fi
# The download is best-effort by design, so "/web absent" alone proves nothing - offline, the
# whole path is skipped and this check passes without having run. Say which case happened rather
# than reporting a pass either way.
if [ -e "$BINDIR/web/index.html" ]; then
  echo "ok: dev mode downloaded beside the binary, not to /"
  rm -rf "$BINDIR/web"
elif grep -q "dashboard download failed" "$WORK/dev.log" 2>/dev/null; then
  echo "INCONCLUSIVE: the bundle download did not succeed here, so the /-write path never ran"
  sed -n 's/^/  dev.log: /p' "$WORK/dev.log" | grep -i dashboard | head -3
else
  echo "INCONCLUSIVE: dev mode neither downloaded nor reported a failure; /-write path unverified"
fi

echo "compiled binary smoke test passed"
