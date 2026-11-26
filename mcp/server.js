#!/usr/bin/env node
'use strict';
// MCP server (stdio, JSON-RPC 2.0) that lets OpenCode drive the n8n video system.
// Zero dependencies. OpenCode supplies the reasoning; this only calls n8n webhooks (+ optional n8n public API for execution errors).
const { validatePlan, resolveTimeline, TRANSITIONS, ANCHORS } = require('../lib/plan');
const BASE = (process.env.VIDEO_N8N_URL || 'http://localhost:5678').replace(/\/+$/, '');
const KEY = process.env.VIDEO_CLIENT_KEY || '';
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`${BASE}/webhook/${p}`, { method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (res.status === 403 || res.status === 401) throw new Error('n8n rejected the client key (set VIDEO_CLIENT_KEY to the value in ~/.n8n-video/keys.env)');
  if (res.status === 404 && /Cannot (GET|POST)/.test(t)) throw new Error('n8n webhook not found: workflows not installed/published, or n8n not restarted (run scripts/install-n8n.sh)');
  if (res.status === 500 && /Data table/.test(t)) throw new Error('video_jobs table missing: run scripts/bootstrap.sh');
  return { status: res.status, body: j };
}
const TERMINAL = ['completed', 'failed', 'cancelled'];
async function waitFor(id, timeoutS, onTick) {
  const t0 = Date.now(); let job;
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const r = await api('GET', `video-jobs/status?job_id=${encodeURIComponent(id)}`); if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    job = r.body.job; if (TERMINAL.includes(job.state)) return { job, timed_out: false };
    await sleep(job.state === 'running' ? 3000 : 4000);
  }
  return { job, timed_out: true };
}
const HINTS = {
  asset_problem: 'One or more input files are missing/corrupt/forbidden on the phone. Check the uri (relative to ~/video-worker/assets or inside ~/storage/shared) or the download URL, then resubmit with the corrected asset.',
  invalid_plan: 'The plan failed validation on the worker. Fix the listed errors and call video_attach_plan again (then video_retry_job if needed).',
  invalid_timeline: 'Scene durations could not be resolved or a transition is longer than half a scene. Set explicit scene durations or shorten the transition.',
  capability_missing: 'This phone\'s ffmpeg/tools lack a needed feature (drawtext font, libass subtitles, whisper.cpp...). Use the alternative suggested in the message (e.g. SRT sidecar instead of burned captions) or install the tool in Termux.',
  low_memory: 'The phone had too little free RAM. Close apps / lower resolution / retry; the job retries automatically with backoff.',
  low_storage: 'Not enough free storage on the phone. Free space or lower quality/resolution.',
  ffmpeg_failed: 'FFmpeg exited with an error; the message holds its last lines. Usually a bad filter combination or unsupported codec/pixel format in a source.',
  lease_expired: 'The worker stopped reporting (app killed, phone asleep/offline or rebooted). The job was re-queued automatically; make sure the worker is running (Termux wake-lock, battery optimisation off).',
  qa_failed: 'Rendering finished but automated checks failed (duration/sync/decode). See failed_checks; fix the plan (e.g. caption cues beyond video end) and retry.',
  download_failed: 'Asset download failed (network/server). Retries happen automatically; check the URL.',
  upload_failed: 'Uploading the finished video to delivery.upload_url failed.',
  worker_shutdown: 'The worker was stopped mid-job; it will resume from cached scene segments when started again.',
  plan_timeout: 'No plan was attached within 24h. Attach one with video_attach_plan or resubmit.',
};

const T = [];
const tool = (name, description, props, required, fn) => T.push({ name, description, inputSchema: { type: 'object', properties: props, required: required || [], additionalProperties: false }, fn });
const assetSchema = { type: 'array', description: 'Input files. uri = path relative to the phone asset folder (~/video-worker/assets), an absolute path under ~/storage/shared, or an http(s) URL the phone downloads.', items: { type: 'object', properties: { id: { type: 'string' }, uri: { type: 'string' }, type: { type: 'string', enum: ['video', 'audio', 'image', 'subtitle', 'script', 'other'] }, role: { type: 'string', enum: ['presenter', 'screen_recording', 'stock', 'narration', 'music', 'sfx', 'image', 'subtitle', 'script', 'other'] } }, required: ['id', 'uri'] } };
const outputSchema = { type: 'object', description: 'One output. Omit fields to take reported defaults (1080p, 16:9, 30fps, h264/mp4, balanced). Either resolution+aspect OR width+height.', properties: { label: { type: 'string' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p', '1440p', '2k', '4k'] }, aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '21:9'] }, width: { type: 'integer' }, height: { type: 'integer' }, fps: { type: 'number' }, codec: { type: 'string', enum: ['h264', 'h265', 'vp9'] }, container: { type: 'string', enum: ['mp4', 'mov', 'mkv', 'webm'] }, quality: { type: 'string', enum: ['compressed', 'balanced', 'high'] }, video_bitrate: { type: 'string' }, crf: { type: 'integer' }, preset: { type: 'string' }, hardware_encode: { type: 'string', enum: ['auto', 'never', 'always'] }, audio: { type: 'object' }, subtitles: { type: 'object', description: '{mode: none|burn|srt|both, languages:["en","fr"], burn_language, style:{font_size,color,position,...}}' } } };

tool('video_health', 'Check that n8n, the workflows and the job table are working, and show queue counts. Call this first.', {}, [], async () => {
  const r = await api('GET', 'video-jobs/list?limit=50'); if (r.status !== 200) return { ok: false, detail: r.body };
  const c = {}; r.body.jobs.forEach(j => { c[j.state] = (c[j.state] || 0) + 1; });
  return { ok: true, n8n: BASE, recent_job_counts: c, note: 'If jobs stay "queued", the phone worker is not running or cannot reach n8n.' };
});
tool('video_output_presets', 'List supported output settings, defaults and rules, so user wishes map to valid settings.', {}, [], async () => ({
  resolutions: { '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160 }, note_resolution: 'Number is the SHORT side: 1080p 16:9 = 1920x1080, 1080p 9:16 = 1080x1920, 1080p 1:1 = 1080x1080', aspects: ['16:9', '9:16', '1:1', '4:3', '21:9'], custom_size: 'width+height, both even, 16..7680',
  fps: '1-120 (default 30)', codecs: { h264: 'mp4/mov/mkv', h265: 'mp4/mov/mkv', vp9: 'webm/mkv' }, quality: { compressed: 'crf 28 (small)', balanced: 'crf 23', high: 'crf 18' }, audio: 'aac|mp3|opus, bitrate, 22050-48000 Hz, 1-2 channels, loudness normalise to -14 LUFS by default',
  subtitles: 'mode none|burn|srt|both; one caption track per language must be supplied in the plan (cues, srt asset or captions.transcribe); burned captions need libass in the phone ffmpeg', multiple_outputs: 'up to 6 outputs per job with unique labels', transitions: TRANSITIONS, anchors: ANCHORS,
  defaults: 'omitted settings take defaults and the API reports them in defaults_applied', limits: 'Requested settings the phone cannot do are REJECTED/FAILED with an explanation, never silently changed.' }));
tool('video_validate_job', 'Dry-run: normalise output settings and validate a job (and optional plan) WITHOUT creating it. Returns the exact resolved settings and defaults applied.', { instruction: { type: 'string' }, assets: assetSchema, outputs: { type: 'array', items: outputSchema }, output: outputSchema, plan: { type: 'object' } }, ['instruction'], async a => { const r = await api('POST', 'video-jobs/validate', a); return { http: r.status, ...r.body }; });
tool('video_validate_plan', 'Offline check of an editing plan against assets/outputs (and a timeline preview if probes are given). Use before video_submit_job to save round trips.', { plan: { type: 'object' }, assets: assetSchema, outputs: { type: 'array', items: outputSchema }, probes: { type: 'object', description: 'Optional map assetId -> {ok,duration} from video_probe_assets, to preview scene timing and total length.' } }, ['plan', 'assets'], async a => {
  const v = validatePlan(a.plan, a.assets, (a.outputs || []).map(o => ({ subtitles: Object.assign({ mode: 'none', languages: ['en'] }, o.subtitles || {}) })));
  const out = { ok: v.ok, errors: v.errors, warnings: v.warnings };
  if (v.ok && a.probes) { const t = resolveTimeline(a.plan, a.probes); out.timeline = { ok: t.ok, errors: t.errors, total_duration: t.total_duration, scenes: t.scenes && t.scenes.map(s => ({ id: s.id, start: s.timeline_start, duration: s.duration })) }; }
  return out; });
tool('video_probe_assets', 'Have the PHONE inspect assets with ffprobe: existence, corruption, duration, resolution, fps, audio presence. Needed to plan scene lengths.', { assets: assetSchema, timeout_seconds: { type: 'integer' } }, ['assets'], async a => {
  const s = await api('POST', 'video-jobs', { kind: 'probe', assets: a.assets, priority: 9 }); if (s.status !== 202) return { ok: false, detail: s.body };
  const w = await waitFor(s.body.job_id, a.timeout_seconds || 120);
  if (w.timed_out) return { ok: false, job_id: s.body.job_id, state: w.job.state, hint: 'Worker did not pick it up in time: is the phone worker running and online?' };
  if (w.job.state !== 'completed') return { ok: false, job_id: s.body.job_id, error: w.job.error };
  return { ok: true, job_id: s.body.job_id, probes: w.job.result.probes, summary: w.job.result.summary }; });
tool('video_transcribe', 'Transcribe speech on the phone (whisper.cpp must be installed there) and return timed cues (source language only; translate them yourself).', { asset: { type: 'object', properties: { id: { type: 'string' }, uri: { type: 'string' }, type: { type: 'string' } }, required: ['id', 'uri'] }, language: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['asset', 'language'], async a => {
  const s = await api('POST', 'video-jobs', { kind: 'transcribe', assets: [a.asset], language: a.language }); if (s.status !== 202) return { ok: false, detail: s.body };
  const w = await waitFor(s.body.job_id, a.timeout_seconds || 600); if (w.timed_out) return { ok: false, job_id: s.body.job_id, state: w.job.state }; if (w.job.state !== 'completed') return { ok: false, error: w.job.error, hint: w.job.error && HINTS[w.job.error.code] };
  return { ok: true, cues: w.job.result.cues }; });
tool('video_submit_job', 'Create a render job. With a plan it is queued for the phone immediately; without one it waits (awaiting_plan) until video_attach_plan. Returns job_id, reported defaults and resolved outputs.', { instruction: { type: 'string', description: 'The user\'s original plain-English request, kept for the record.' }, title: { type: 'string' }, assets: assetSchema, outputs: { type: 'array', items: outputSchema }, output: outputSchema, plan: { type: 'object' }, priority: { type: 'integer' }, callback_url: { type: 'string' }, idempotency_key: { type: 'string' }, delivery: { type: 'object', description: '{upload_url} - phone PUTs each finished file there; {label} is substituted.' } }, ['instruction'], async a => { const r = await api('POST', 'video-jobs', a); return { http: r.status, ...r.body }; });
tool('video_attach_plan', 'Attach or replace the editing plan of a job (awaiting_plan/queued/failed/cancelled). Validates and queues it.', { job_id: { type: 'string' }, plan: { type: 'object' } }, ['job_id', 'plan'], async a => { const r = await api('POST', 'video-jobs/plan', a); return { http: r.status, ...r.body }; });
tool('video_job_status', 'Get a job\'s state, progress, error and result. full=true adds assets/outputs/plan.', { job_id: { type: 'string' }, full: { type: 'boolean' } }, ['job_id'], async a => { const r = await api('GET', `video-jobs/status?job_id=${encodeURIComponent(a.job_id)}${a.full ? '&full=1' : ''}`); return { http: r.status, ...r.body }; });
tool('video_wait_for_job', 'Wait (up to timeout_seconds, max 280) until the job finishes, then return it. If it times out the job keeps running on the phone; call again later.', { job_id: { type: 'string' }, timeout_seconds: { type: 'integer' } }, ['job_id'], async a => { const w = await waitFor(a.job_id, Math.min(280, a.timeout_seconds || 120)); return { finished: !w.timed_out, job: w.job }; });
tool('video_list_jobs', 'List recent jobs (newest first). Optional filters: state, kind, limit.', { state: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer' } }, [], async a => { const q = new URLSearchParams(Object.entries(a).filter(([, v]) => v !== undefined)).toString(); const r = await api('GET', `video-jobs/list?${q}`); return r.body; });
tool('video_cancel_job', 'Cancel a job (queued: immediately; running: the phone stops at its next progress report).', { job_id: { type: 'string' } }, ['job_id'], async a => { const r = await api('POST', 'video-jobs/cancel', a); return { http: r.status, ...r.body }; });
tool('video_retry_job', 'Manually retry a failed/cancelled job (resets attempts).', { job_id: { type: 'string' } }, ['job_id'], async a => { const r = await api('POST', 'video-jobs/retry', a); return { http: r.status, ...r.body }; });
tool('video_get_result', 'Summarise a completed job for the user: output files on the phone, sizes, durations, QA checks, warnings, timings, resource use.', { job_id: { type: 'string' } }, ['job_id'], async a => {
  const r = await api('GET', `video-jobs/status?job_id=${encodeURIComponent(a.job_id)}`); const j = r.body.job; if (!j) return r.body; if (j.state !== 'completed') return { ok: false, state: j.state, error: j.error, progress: j.progress };
  const res = j.result; return { ok: true, title: j.title, outputs: res.outputs.map(o => ({ label: o.label, file_on_phone: o.path, size_mb: +(o.size_bytes / 1e6).toFixed(1), duration_s: o.duration, resolution: `${o.width}x${o.height}@${o.fps}`, codec: `${o.vcodec}/${o.acodec}`, encoder: o.encoder, stream_copy_video: o.stream_copy_video, subtitle_files: o.subtitle_files, uploaded: !!o.uploaded, qa_ok: o.qa.ok, qa_checks: o.qa.checks.map(c => `${c.ok ? 'ok' : 'FAIL'} ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`) })), warnings: res.warnings, render_seconds: res.total_seconds, expected_video_seconds: res.expected_duration, peak_ffmpeg_ram_mb: res.resources && res.resources.peak_rss_mb }; });
tool('video_explain_failure', 'Diagnose a failed/retrying job: error code, message, plain-language cause and the next action. Also lists recent failed n8n executions if N8N_API_KEY is configured.', { job_id: { type: 'string' } }, ['job_id'], async a => {
  const r = await api('GET', `video-jobs/status?job_id=${encodeURIComponent(a.job_id)}`); const j = r.body.job; if (!j) return r.body;
  const e = j.error; const out = { state: j.state, attempts: `${j.attempts}/${j.max_attempts}`, error: e || null, meaning: e ? (HINTS[e.code] || 'Unrecognised error; read the message and the history.') : 'No error recorded.', history: j.history };
  if (N8N_API_KEY) { try { const x = await fetch(`${BASE}/api/v1/executions?status=error&limit=5`, { headers: { 'X-N8N-API-KEY': N8N_API_KEY }, signal: AbortSignal.timeout(15000) }); const d = await x.json(); out.recent_failed_n8n_executions = (d.data || []).map(z => ({ id: z.id, workflowId: z.workflowId, startedAt: z.startedAt })); } catch (err) { out.n8n_executions_error = String(err.message); } }
  return out; });

// ---- JSON-RPC over stdio ---------------------------------------------------
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'n8n-video', version: '0.1.0' } } });
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: T.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (m.method === 'tools/call') {
    const t = T.find(x => x.name === m.params.name); if (!t) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool ' + m.params.name } });
    try { const out = await t.fn(m.params.arguments || {}); return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: out && out.ok === false } }); }
    catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true } }); }
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
}
if (require.main === module) { let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { handle(JSON.parse(line)); } catch (e) { /* ignore malformed */ } } } }); }
module.exports = { T, HINTS };
