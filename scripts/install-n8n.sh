#!/usr/bin/env bash
# Installs the video-production workflows + credentials into an EXISTING, unmodified n8n.
# Usage: N8N_USER_FOLDER=~/.n8n scripts/install-n8n.sh      (stop n8n first, then start it again afterwards)
# Env:   N8N_BIN (default: n8n)   VIDEO_CONF_DIR (default: ~/.n8n-video)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N8N="${N8N_BIN:-n8n}"
CONF="${VIDEO_CONF_DIR:-$HOME/.n8n-video}"; mkdir -p "$CONF"; chmod 700 "$CONF"
KEYS="$CONF/keys.env"
gen() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
if [ ! -f "$KEYS" ]; then
  ( umask 077; printf 'VIDEO_CLIENT_KEY=%s\nVIDEO_WORKER_KEY=%s\n' "$(gen)" "$(gen)" > "$KEYS" )
  echo "Generated API keys in $KEYS"
fi
# shellcheck disable=SC1090
set -a; . "$KEYS"; set +a
echo "== building workflows"; node "$ROOT/scripts/build-workflows.js"
echo "== importing credentials"
( umask 077; node -e "
const [c,w]=[process.env.VIDEO_CLIENT_KEY,process.env.VIDEO_WORKER_KEY];
const mk=(id,name,v)=>({id,name,type:'httpHeaderAuth',data:{name:'X-API-Key',value:v}});
console.log(JSON.stringify([mk('vpcred00000000001','Video Client Key',c),mk('vpcred00000000002','Video Worker Key',w)]));" > "$CONF/creds.json" )
SC=(); [ -n "${N8N_PROJECT_ID:-}" ] && SC+=("--projectId=$N8N_PROJECT_ID"); [ -n "${N8N_USER_ID:-}" ] && SC+=("--userId=$N8N_USER_ID")
"$N8N" import:credentials --input="$CONF/creds.json" ${SC[@]+"${SC[@]}"} 2>&1 | grep -iE "success|error" || true; rm -f "$CONF/creds.json"
echo "== importing workflows"
SCOPE=(); [ -n "${N8N_PROJECT_ID:-}" ] && SCOPE+=("--projectId=$N8N_PROJECT_ID"); [ -n "${N8N_USER_ID:-}" ] && SCOPE+=("--userId=$N8N_USER_ID")
for f in VP-00-setup VP-01-job-api VP-02-worker-gateway VP-03-recovery-sweeper VP-04-notifier; do
  "$N8N" import:workflow --input="$ROOT/workflows/$f.json" ${SCOPE[@]+"${SCOPE[@]}"} 2>&1 | grep -iE "success|error" || true
done
echo "== publishing workflows"
for id in vpwf000000000000 vpwf000000000001 vpwf000000000002 vpwf000000000003 vpwf000000000004; do
  if "$N8N" publish:workflow --id="$id" >/dev/null 2>&1; then echo "published $id"; else "$N8N" update:workflow --id="$id" --active=true >/dev/null 2>&1 && echo "activated $id" || echo "!! could not activate $id - open it in the n8n UI and click Publish/Activate"; fi
done
cat <<MSG

Done. (Re)start n8n, then run ONCE:  scripts/bootstrap.sh <n8n base URL>   (creates the job table).
  Client key (OpenCode/MCP):  stored in $KEYS  (VIDEO_CLIENT_KEY)
  Worker key (phone):         stored in $KEYS  (VIDEO_WORKER_KEY)
  Webhook base URL:           <your n8n URL>/webhook
MSG
