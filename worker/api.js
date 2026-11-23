'use strict';
const cfg = require('./config');
async function call(p, body, timeoutMs = 20000) {
  const res = await fetch(`${cfg.baseUrl}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.workerKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const txt = await res.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!res.ok) { const e = new Error(`n8n ${p} -> HTTP ${res.status} ${txt.slice(0, 200)}`); e.status = res.status; throw e; }
  return j;
}
module.exports = {
  claim: b => call('video-worker/claim', b),
  progress: b => call('video-worker/progress', b),
  complete: b => call('video-worker/complete', b, 60000),
  fail: b => call('video-worker/fail', b),
};
