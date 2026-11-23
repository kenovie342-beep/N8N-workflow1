'use strict';
// Job state machine. Pure functions over "rows" (one DB row per job) so each
// n8n Code node does one small, atomic step. No I/O, no static data.
// States: awaiting_plan -> queued -> running -> completed | failed | cancelled
// Lazy so Code nodes that don't submit/plan jobs don't need the other libs concatenated.
const getNormalize = () => (typeof normalizeJob === 'function' ? normalizeJob : require('./normalize-job').normalizeJob);
const getValidate = () => (typeof validatePlan === 'function' ? validatePlan : require('./plan').validatePlan);

const COLUMNS = ['job_id', 'state', 'kind', 'priority', 'created_ms', 'updated_ms', 'lease_ms', 'not_before_ms', 'worker_id', 'attempts', 'max_attempts', 'cancel_requested', 'progress', 'stage', 'message', 'idem_key', 'data'];
const LEASE_SECONDS = 120;
const TERMINAL = ['completed', 'failed', 'cancelled'];
const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);

function newJobId(now, rnd) { return 'job_' + now.toString(36) + '_' + (rnd || Math.random().toString(16).slice(2, 10)).slice(0, 8); }
function pick(row) { const o = {}; COLUMNS.forEach(c => { if (row[c] !== undefined) o[c] = row[c]; }); return o; }
function dataOf(row) { try { return JSON.parse(row.data); } catch { return {}; } }
function addHistory(d, now, state, note) { d.history = (d.history || []).concat([{ at: new Date(now).toISOString(), state, note: clip(note, 300) }]).slice(-60); }

// ---- submit ------------------------------------------------------------
function prepareSubmit(body, now, id) {
  const r = getNormalize()(body, { id, now: new Date(now).toISOString() });
  if (!r.ok) return { status: 400, body: { ok: false, errors: r.errors, warnings: r.warnings } };
  const job = r.job; let state = job.kind === 'render' ? 'awaiting_plan' : 'queued'; const warnings = r.warnings.slice();
  if (job.kind === 'render' && body.plan !== undefined) {
    const v = getValidate()(body.plan, job.assets, job.outputs);
    if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors, warnings: v.warnings } };
    job.plan = body.plan; state = 'queued'; warnings.push(...v.warnings);
  }
  addHistory(job, now, state, 'submitted');
  const row = { job_id: id, state, kind: job.kind, priority: job.priority, created_ms: now, updated_ms: now, lease_ms: 0, not_before_ms: 0, worker_id: '', attempts: 0, max_attempts: job.max_attempts, cancel_requested: false, progress: 0, stage: state, message: '', idem_key: job.idempotency_key || '', data: JSON.stringify(job) };
  return { status: 202, row, body: { ok: true, job_id: id, state, next: state === 'awaiting_plan' ? 'POST /video-jobs/plan with an editing plan to queue it' : 'queued for the worker', defaults_applied: r.defaults_applied, warnings, outputs: job.outputs.map(o => ({ label: o.label, width: o.width, height: o.height, fps: o.fps, codec: o.codec, container: o.container, quality: o.quality, subtitles: o.subtitles.mode })) } };
}

function publicView(row, full) {
  const d = dataOf(row);
  const v = { job_id: row.job_id, kind: row.kind, state: row.state, progress: row.progress, stage: row.stage, message: row.message, attempts: row.attempts, max_attempts: row.max_attempts, worker_id: row.worker_id || null, cancel_requested: !!row.cancel_requested,
    created_at: new Date(row.created_ms).toISOString(), updated_at: new Date(row.updated_ms).toISOString(), title: d.title, instruction: d.instruction, has_plan: !!d.plan, outputs_requested: (d.outputs || []).map(o => `${o.label}: ${o.width}x${o.height}@${o.fps} ${o.codec}/${o.container}`), result: d.result || null, error: d.error || null, history: (d.history || []).slice(-15) };
  if (full) { v.assets = d.assets; v.outputs = d.outputs; v.plan = d.plan; }
  return v;
}

// ---- plan ------------------------------------------------------------------
function planAttach(row, plan, now) {
  if (row.kind !== 'render') return { status: 409, body: { ok: false, errors: ['only render jobs take a plan'] } };
  if (!['awaiting_plan', 'queued', 'failed', 'cancelled'].includes(row.state)) return { status: 409, body: { ok: false, errors: [`job is ${row.state}; plans can only be replaced while awaiting_plan/queued (or after failure)`] } };
  const d = dataOf(row); const v = getValidate()(plan, d.assets, d.outputs);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors, warnings: v.warnings } };
  d.plan = plan; d.error = null; addHistory(d, now, 'queued', 'plan attached');
  return { status: 200, expect_state: row.state, update: { job_id: row.job_id, state: 'queued', updated_ms: now, not_before_ms: 0, attempts: row.state === 'failed' || row.state === 'cancelled' ? 0 : row.attempts, cancel_requested: false, progress: 0, stage: 'queued', message: 'plan attached', data: JSON.stringify(d) }, body: { ok: true, job_id: row.job_id, state: 'queued', warnings: v.warnings } };
}

// ---- cancel / retry ------------------------------------------------------
function cancel(row, now) {
  if (TERMINAL.includes(row.state)) return { status: 200, body: { ok: true, job_id: row.job_id, state: row.state, note: 'already finished' } };
  if (row.state === 'running') return { status: 202, expect_state: 'running', update: { job_id: row.job_id, cancel_requested: true, updated_ms: now, message: 'cancel requested; worker will stop at its next progress report' }, body: { ok: true, job_id: row.job_id, state: 'running', note: 'cancel requested' } };
  const d = dataOf(row); addHistory(d, now, 'cancelled', 'cancelled by user');
  return { status: 200, expect_state: row.state, update: { job_id: row.job_id, state: 'cancelled', updated_ms: now, stage: 'cancelled', message: 'cancelled', data: JSON.stringify(d) }, body: { ok: true, job_id: row.job_id, state: 'cancelled' } };
}
function retry(row, now) {
  if (!['failed', 'cancelled'].includes(row.state)) return { status: 409, body: { ok: false, errors: [`job is ${row.state}; only failed/cancelled jobs can be retried`] } };
  const d = dataOf(row); const st = d.plan || row.kind !== 'render' ? 'queued' : 'awaiting_plan'; d.error = null; addHistory(d, now, st, 'manual retry');
  return { status: 202, expect_state: row.state, update: { job_id: row.job_id, state: st, attempts: 0, updated_ms: now, not_before_ms: 0, cancel_requested: false, progress: 0, stage: st, message: 'manual retry', worker_id: '', data: JSON.stringify(d) }, body: { ok: true, job_id: row.job_id, state: st } };
}

// ---- worker side --------------------------------------------------------
function claimPick(rows, now) {
  const ok = rows.filter(r => r.state === 'queued' && (r.not_before_ms || 0) <= now);
  ok.sort((a, b) => (b.priority - a.priority) || (a.created_ms - b.created_ms));
  return ok[0] || null;
}
function claimUpdate(row, workerId, now) {
  return { job_id: row.job_id, state: 'running', worker_id: clip(workerId, 60), lease_ms: now + LEASE_SECONDS * 1000, attempts: (row.attempts || 0) + 1, updated_ms: now, progress: 0, stage: 'claimed', message: 'claimed by ' + clip(workerId, 60) };
}
function claimBody(row, workerId) {
  const d = dataOf(row);
  return { ok: true, job: { job_id: row.job_id, kind: row.kind, title_slug: d.title_slug, language: d.language, assets: d.assets, outputs: d.outputs, plan: d.plan, delivery: d.delivery, attempt: (row.attempts || 0) + 1, lease_seconds: LEASE_SECONDS } };
}
function progressUpdate(b, now) {
  return { job_id: clip(b.job_id, 80), progress: Math.max(0, Math.min(100, Math.round(+b.percent || 0))), stage: clip(b.stage, 60), message: clip(b.message, 300), lease_ms: now + LEASE_SECONDS * 1000, updated_ms: now };
}
function completeDecision(row, b, now) {
  const d = dataOf(row); const res = b.result || {};
  if (res.qa_ok === false) {
    d.result = res; d.error = { code: 'qa_failed', message: 'Output failed quality checks', retryable: false, failed_checks: (res.outputs || []).flatMap(o => (o.qa.checks || []).filter(c => !c.ok).map(c => `${o.label}:${c.name} ${c.detail || ''}`)).slice(0, 10) };
    addHistory(d, now, 'failed', 'QA failed');
    return { state: 'failed', update: { job_id: row.job_id, state: 'failed', updated_ms: now, stage: 'qa_failed', message: 'quality checks failed', data: JSON.stringify(d) } };
  }
  d.result = res; d.error = null; addHistory(d, now, 'completed', 'worker finished');
  return { state: 'completed', update: { job_id: row.job_id, state: 'completed', progress: 100, updated_ms: now, stage: 'completed', message: 'done', data: JSON.stringify(d) } };
}
function backoffMs(attempts) { return Math.min(10 * 60 * 1000, 30000 * Math.pow(2, Math.max(0, attempts - 1))); }
function failDecision(row, err, now) {
  const d = dataOf(row); const e = { code: clip(err.code || 'error', 60), message: clip(err.message, 1500), retryable: !!err.retryable, details: err.details === undefined ? undefined : JSON.parse(JSON.stringify(err.details, (k, v) => typeof v === 'string' ? clip(v, 400) : v)), at: new Date(now).toISOString() };
  if (e.retryable && (row.attempts || 0) < (row.max_attempts || 3)) {
    d.error = e; addHistory(d, now, 'queued', `attempt ${row.attempts} failed (${e.code}); retrying in ${Math.round(backoffMs(row.attempts) / 1000)}s`);
    return { state: 'queued', update: { job_id: row.job_id, state: 'queued', worker_id: '', not_before_ms: now + backoffMs(row.attempts), updated_ms: now, stage: 'retry_wait', message: `retry after ${e.code}`, data: JSON.stringify(d) } };
  }
  d.error = e; addHistory(d, now, e.code === 'cancelled' ? 'cancelled' : 'failed', e.message);
  const st = e.code === 'cancelled' ? 'cancelled' : 'failed';
  return { state: st, update: { job_id: row.job_id, state: st, updated_ms: now, stage: st, message: clip(e.message, 280), data: JSON.stringify(d) } };
}
function sweepDecision(row, now) { return failDecision(row, { code: 'lease_expired', message: `worker ${row.worker_id || '?'} stopped reporting (phone offline, app killed, or rebooted)`, retryable: true }, now); }
function stalePlan(row, now) { const d = dataOf(row); d.error = { code: 'plan_timeout', message: 'No editing plan was attached within 24h', retryable: false }; addHistory(d, now, 'failed', 'plan timeout'); return { job_id: row.job_id, state: 'failed', updated_ms: now, stage: 'plan_timeout', message: 'no plan within 24h', data: JSON.stringify(d) }; }
function notifyPayload(row) { const v = publicView(row, false); return { event: 'video_job.' + row.state, job: v }; }

if (typeof module !== 'undefined' && module.exports) module.exports = { COLUMNS, LEASE_SECONDS, TERMINAL, newJobId, pick, dataOf, prepareSubmit, publicView, planAttach, cancel, retry, claimPick, claimUpdate, claimBody, progressUpdate, completeDecision, failDecision, sweepDecision, stalePlan, notifyPayload, backoffMs };
