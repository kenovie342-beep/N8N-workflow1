'use strict';
const test = require('node:test'), assert = require('node:assert');
const E = require('../lib/engine'); const F = require('./fixtures');
const now = 1_700_000_000_000;
const sub = (b) => E.prepareSubmit(b, now, 'job_t1');
test('submit without plan -> awaiting_plan; with valid plan -> queued', () => {
  assert.equal(sub({ instruction: 'x', assets: F.assets }).row.state, 'awaiting_plan');
  const r = sub({ instruction: 'x', assets: F.assets, plan: F.plan, outputs: [{ subtitles: { mode: 'srt', languages: ['en'] } }] }); assert.equal(r.status, 202); assert.equal(r.row.state, 'queued');
});
test('submit rejects invalid plan and bad input with 400 + errors', () => {
  const r = sub({ instruction: 'x', assets: F.assets, plan: { version: 1, scenes: [{ id: 's', layers: [{ type: 'video', asset: 'nope' }] }] } }); assert.equal(r.status, 400); assert.match(r.body.errors.join(), /not in the job/);
  assert.equal(sub({ assets: [] }).status, 400);
});
test('probe/transcribe kinds need no plan and start queued', () => {
  assert.equal(sub({ kind: 'probe', assets: [{ id: 'a', uri: 'a.mp4' }] }).row.state, 'queued');
  assert.equal(sub({ kind: 'transcribe', language: 'en', assets: [{ id: 'a', uri: 'a.wav' }] }).row.state, 'queued');
  assert.equal(sub({ kind: 'transcribe', assets: [{ id: 'a', uri: 'a.wav' }] }).status, 400);
});
test('row only contains known columns', () => { const r = sub({ instruction: 'x' }).row; Object.keys(r).forEach(k => assert.ok(E.COLUMNS.includes(k), k)); });
test('claimPick: priority first, then age; respects not_before and state', () => {
  const rows = [{ job_id: 'a', state: 'queued', priority: 5, created_ms: 1 }, { job_id: 'b', state: 'queued', priority: 9, created_ms: 5 }, { job_id: 'c', state: 'queued', priority: 9, created_ms: 2 }, { job_id: 'd', state: 'running', priority: 9, created_ms: 0 }, { job_id: 'e', state: 'queued', priority: 9, created_ms: 0, not_before_ms: now + 1 }];
  assert.equal(E.claimPick(rows, now).job_id, 'c'); assert.equal(E.claimPick([], now), null);
});
function runningRow(over = {}) { const s = sub({ instruction: 'x', assets: F.assets, plan: F.plan, outputs: [{ subtitles: { mode: 'srt', languages: ['en'] } }] }).row; return { ...s, state: 'running', worker_id: 'w1', attempts: 1, ...over }; }
test('retryable failure -> queued with exponential backoff until max_attempts, then failed', () => {
  let d = E.failDecision(runningRow(), { code: 'low_memory', message: 'm', retryable: true }, now); assert.equal(d.state, 'queued'); assert.equal(d.update.not_before_ms, now + 30000);
  d = E.failDecision(runningRow({ attempts: 3 }), { code: 'low_memory', message: 'm', retryable: true }, now); assert.equal(d.state, 'failed');
  assert.equal(E.backoffMs(1), 30000); assert.equal(E.backoffMs(2), 60000); assert.equal(E.backoffMs(20), 600000);
});
test('non-retryable failure -> failed; cancelled code -> cancelled', () => {
  assert.equal(E.failDecision(runningRow(), { code: 'asset_problem', message: 'x' }, now).state, 'failed');
  assert.equal(E.failDecision(runningRow(), { code: 'cancelled', message: 'x' }, now).state, 'cancelled');
});
test('lease expiry sweeps to retry; QA failure is a terminal failure and keeps the result', () => {
  assert.equal(E.sweepDecision(runningRow(), now).state, 'queued');
  assert.equal(E.sweepDecision(runningRow({ attempts: 3 }), now).state, 'failed');
  const c = E.completeDecision(runningRow(), { result: { qa_ok: false, outputs: [{ label: 'a', qa: { checks: [{ name: 'duration', ok: false, detail: 'x' }] } }] } }, now);
  assert.equal(c.state, 'failed'); assert.match(E.dataOf({ data: c.update.data }).error.failed_checks[0], /duration/);
  assert.equal(E.completeDecision(runningRow(), { result: { qa_ok: true, outputs: [] } }, now).state, 'completed');
});
test('cancel: queued->cancelled, running->flag only, finished->no-op', () => {
  const q = { ...runningRow(), state: 'queued' }; assert.equal(E.cancel(q, now).update.state, 'cancelled');
  const r = E.cancel(runningRow(), now); assert.equal(r.update.cancel_requested, true); assert.equal(r.update.state, undefined);
  assert.equal(E.cancel({ ...runningRow(), state: 'completed' }, now).update, undefined);
});
test('plan attach: validates against stored assets/outputs; replans after failure resets attempts', () => {
  const aw = { ...sub({ instruction: 'x', assets: F.assets, outputs: [{ subtitles: { mode: 'srt', languages: ['en'] } }] }).row };
  assert.equal(E.planAttach(aw, { version: 1, scenes: [] }, now).status, 400);
  const ok = E.planAttach(aw, F.plan, now); assert.equal(ok.status, 200); assert.equal(ok.update.state, 'queued');
  assert.equal(E.planAttach({ ...aw, state: 'running' }, F.plan, now).status, 409);
});
test('retry only for failed/cancelled; progress update is clamped', () => {
  assert.equal(E.retry(runningRow(), now).status, 409); assert.equal(E.retry({ ...runningRow(), state: 'failed' }, now).update.attempts, 0);
  assert.equal(E.progressUpdate({ job_id: 'j', percent: 250 }, now).progress, 100);
});
