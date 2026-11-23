#!/usr/bin/env bash
# Creates the video_jobs data table inside the running n8n (idempotent). Usage: scripts/bootstrap.sh http://localhost:5678
set -uo pipefail
BASE="${1:?n8n base URL, e.g. http://localhost:5678}"; CONF="${VIDEO_CONF_DIR:-$HOME/.n8n-video}"; . "$CONF/keys.env"
for i in $(seq 1 40); do   # webhooks register a few seconds after n8n reports healthy
  CODE=$(curl -s -o /tmp/vp-bootstrap.out -w '%{http_code}' -X POST "${BASE%/}/webhook/video-setup" -H "X-API-Key: $VIDEO_CLIENT_KEY" -H 'Content-Type: application/json' -d '{}')
  [ "$CODE" = 404 ] && { sleep 2; continue; }
  cat /tmp/vp-bootstrap.out; echo; [ "$CODE" = 200 ] && exit 0 || { echo "bootstrap failed: HTTP $CODE" >&2; exit 1; }
done
echo "webhook never registered - are workflows published and n8n restarted?" >&2; exit 1
