#!/usr/bin/env bash
# Boot the Dockyard API on the real Docker socket + real Postgres, run the
# end-to-end acceptance test against it, then shut it down.
#
#   bash scripts/run-e2e.sh
#
# Leaves logs in /tmp/dockyard-api.log. Exit code is the e2e exit code.

set -uo pipefail
export PATH=/root/.hermes/node/bin:$PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG=/tmp/dockyard-api.log
: > "$LOG"

echo "== migrations =="
node server/src/db/migrate.ts || { echo "MIGRATE FAILED"; exit 1; }

echo "== starting api =="
node server/src/index.ts >> "$LOG" 2>&1 &
API_PID=$!
echo "api pid=$API_PID log=$LOG"

cleanup() {
  echo "== stopping api (pid $API_PID) =="
  kill "$API_PID" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$API_PID" 2>/dev/null
  # Anything the panel spawned (cloudflared children) goes with it.
  pkill -f "cloudflared tunnel --url http://127.0.0.1:18" 2>/dev/null
  echo "== api log tail =="
  tail -25 "$LOG"
}
trap cleanup EXIT

echo "== e2e =="
node scripts/e2e.mjs
RC=$?
echo "== e2e exit $RC =="
exit $RC
