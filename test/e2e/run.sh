#!/usr/bin/env bash
# Spins up a throwaway n8n, installs the workflows with the real installer, and runs the e2e suite.
# Usage: N8N_BIN=/path/to/n8n test/e2e/run.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export N8N_BIN="${N8N_BIN:-n8n}" PORT="${E2E_PORT:-5701}"
T="$(mktemp -d)"; export N8N_USER_FOLDER="$T/n8n" VIDEO_CONF_DIR="$T/conf" VW_DATA_DIR="$T/vw" HOME="$T/home"; mkdir -p "$HOME" "$VW_DATA_DIR/assets"
export N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false N8N_PERSONALIZATION_ENABLED=false N8N_PORT=$PORT N8N_RUNNERS_BROKER_PORT=$((PORT+1)) N8N_LISTEN_ADDRESS=127.0.0.1
[ -z "${VW_FONT_FILE:-}" ] && export VW_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
"$ROOT/scripts/make-sample-assets.sh" "$VW_DATA_DIR/assets" 12 >/dev/null
wait_up() { for i in $(seq 1 60); do sleep 2; curl -s -o /dev/null -m 3 "localhost:$PORT/healthz" && break; done; sleep 3; }
# 1) first boot creates the DB and the instance owner (real installs already have an owner)
NM="$(cd "$(dirname "$N8N_BIN")/.." && pwd)"
export N8N_INSTANCE_OWNER_MANAGED_BY_ENV=true N8N_INSTANCE_OWNER_EMAIL=e2e@example.com N8N_INSTANCE_OWNER_FIRST_NAME=E2E N8N_INSTANCE_OWNER_LAST_NAME=Test
export N8N_INSTANCE_OWNER_PASSWORD_HASH="$(NODE_PATH="$NM" node -e "console.log(require('bcryptjs').hashSync('E2eTest12345',10))")"
"$N8N_BIN" start > "$T/n8n0.log" 2>&1 & S0=$!; wait_up
kill $S0; wait $S0 2>/dev/null; sleep 2
# 2) install with the real installer
"$ROOT/scripts/install-n8n.sh" > "$T/install.log" 2>&1 || { cat "$T/install.log"; exit 3; }
grep -E "published|activated|!!|rror|uccess" "$T/install.log"
# 3) run n8n and bootstrap
"$N8N_BIN" start > "$T/n8n.log" 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
wait_up
. "$VIDEO_CONF_DIR/keys.env"; export VIDEO_CLIENT_KEY VIDEO_WORKER_KEY E2E_BASE="http://127.0.0.1:$PORT/webhook"
"$ROOT/scripts/bootstrap.sh" "http://127.0.0.1:$PORT" || { echo BOOTSTRAP FAILED; tail -20 "$T/n8n.log"; exit 4; }
node "$ROOT/test/e2e/e2e.js"; RC=$?
[ $RC -ne 0 ] && { echo "--- n8n log tail ---"; tail -25 "$T/n8n.log"; }
exit $RC
