'use strict';
// End-to-end test against a REAL n8n with the workflows installed, driving the REAL worker + FFmpeg.
const { spawn, execFileSync } = require('child_process'), http = require('http'), fs = require('fs'), path = require('path');
const BASE = process.env.E2E_BASE, CK = process.env.VIDEO_CLIENT_KEY, WK = process.env.VIDEO_WORKER_KEY, DATA = process.env.VW_DATA_DIR;
const F = require('../fixtures');
let pass = 0, fail = 0; const results = [];
const ok = (c, name, extra) => { (c ? pass++ : fail++); results.push(`${c ? 'PASS' : 'FAIL'}  ${name}${!c && extra ? '  -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); console.log(results[results.length - 1]); };
const call = async (m, p, body, key = CK) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j; const t = await r.text(); try { j = JSON.parse(t); } catch { j = { raw: t }; } return { s: r.status, j }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitState(id, states, timeoutS) { const t0 = Date.now(); let last; while ((Date.now() - t0) / 1000 < timeoutS) { const r = await call('GET', `video-jobs/status?job_id=${id}`); last = r.j.job; if (last && states.includes(last.state)) return last; await sleep(1500); } return last; }

(async () => {
  // --- auth
  let r = await fetch(`${BASE}/video-jobs/list`); ok(r.status === 403 || r.status === 401, 'unauthenticated request is rejected', r.status);
  r = await call('GET', 'video-jobs/list', null, WK); ok(r.s === 403, 'worker key cannot use the client API', r.s);
  r = await call('POST', 'video-worker/claim', { worker_id: 'x', busy: true }, CK); ok(r.s === 403, 'client key cannot use the worker API', r.s);
  // --- validate
  r = await call('POST', 'video-jobs/validate', { instruction: 'x', output: { resolution: '1080p', aspect: '9:16', fps: 60 } });
  ok(r.s === 200 && r.j.outputs[0].width === 1080 && r.j.outputs[0].height === 1920 && r.j.outputs[0].fps === 60, 'validate: 1080p 9:16 60fps -> 1080x1920@60', r);
  r = await call('POST', 'video-jobs/validate', { instruction: 'x', output: { codec: 'vp9', container: 'mp4' } }); ok(r.s === 400 && /cannot go in mp4/.test(JSON.stringify(r.j)), 'validate: incompatible codec/container rejected not silently changed', r);
  // --- concurrency: 12 parallel submissions must all persist (static data lost updates in my first design)
  const ids = (await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', 'video-jobs', { instruction: 'concurrency ' + i, assets: [] })))).map(x => x.j.job_id);
  ok(ids.every(Boolean) && new Set(ids).size === 12, '12 parallel submissions all accepted with distinct ids');
  await sleep(1500); const list = await call('GET', 'video-jobs/list?limit=50'); const have = new Set((list.j.jobs || []).map(j => j.job_id)); ok(ids.every(i => have.has(i)), 'all 12 parallel jobs are persisted (no lost updates)', { have: have.size });
  for (const id of ids) await call('POST', 'video-jobs/cancel', { job_id: id });
  // --- idempotency
  const a1 = await call('POST', 'video-jobs', { instruction: 'idem', idempotency_key: 'k1', assets: [] }), a2 = await call('POST', 'video-jobs', { instruction: 'idem', idempotency_key: 'k1', assets: [] });
  ok(a1.j.job_id && a2.j.duplicate && a2.j.job_id === a1.j.job_id, 'idempotency key returns the same job'); await call('POST', 'video-jobs/cancel', { job_id: a1.j.job_id });
  // --- cancel a running job (claimed by a fake worker)
  const cj = (await call('POST', 'video-jobs', { kind: 'probe', assets: [{ id: 'a', uri: 'presenter.mp4' }], priority: 9 })).j.job_id;
  const cl = await call('POST', 'video-worker/claim', { worker_id: 'ghost' }, WK); ok(cl.j.job && cl.j.job.job_id === cj, 'claim hands out the highest-priority queued job', cl.j);
  const cl2 = await call('POST', 'video-worker/claim', { worker_id: 'ghost2' }, WK); ok(cl2.j.job === null, 'a second worker cannot claim a running job');
  r = await call('POST', 'video-jobs/cancel', { job_id: cj }); ok(r.s === 202, 'cancel on running job is accepted', r);
  r = await call('POST', 'video-worker/progress', { job_id: cj, worker_id: 'ghost', percent: 10, stage: 'x' }, WK); ok(r.j.cancel === true, 'worker is told to stop on next progress report', r);
  r = await call('POST', 'video-worker/progress', { job_id: cj, worker_id: 'intruder', percent: 10, stage: 'x' }, WK); ok(r.s === 409, 'progress from a non-owner worker is refused', r);
  r = await call('POST', 'video-worker/fail', { job_id: cj, worker_id: 'ghost', error: { code: 'cancelled', message: 'stop', retryable: false } }, WK);
  let st = await waitState(cj, ['cancelled', 'failed'], 10); ok(st && st.state === 'cancelled', 'cancelled job ends in state cancelled', st && st.state);
  // --- retryable failure requeues with backoff
  const rj = (await call('POST', 'video-jobs', { kind: 'probe', assets: [{ id: 'a', uri: 'presenter.mp4' }], priority: 9 })).j.job_id;
  await call('POST', 'video-worker/claim', { worker_id: 'ghost' }, WK);
  await call('POST', 'video-worker/fail', { job_id: rj, worker_id: 'ghost', error: { code: 'low_memory', message: 'test', retryable: true } }, WK);
  st = await waitState(rj, ['queued'], 8); ok(st && st.state === 'queued' && st.attempts === 1 && st.error && st.error.code === 'low_memory', 'retryable failure -> re-queued (attempt 1, error recorded)', st);
  r = await call('POST', 'video-worker/claim', { worker_id: 'ghost' }, WK); ok(r.j.job === null, 'retry respects backoff (not claimable immediately)', r.j);
  await call('POST', 'video-jobs/cancel', { job_id: rj });
  // --- callback server
  const got = []; const srv = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { got.push({ ev: q.headers['x-video-event'], b: JSON.parse(b) }); s.end('ok'); }); }).listen(0); const cbUrl = `http://127.0.0.1:${srv.address().port}/cb`;
  // --- start the REAL worker
  const wenv = { ...process.env, VW_N8N_BASE_URL: BASE, VW_WORKER_KEY: WK, VW_POLL_SECONDS: '2', VW_WORKER_ID: 'e2e-worker', VW_ALLOWED_ROOTS: path.join(DATA, 'assets') };
  const worker = spawn('node', [path.join(__dirname, '../../worker/index.js')], { env: wenv, stdio: ['ignore', 'pipe', 'pipe'] }); let wlog = ''; worker.stdout.on('data', d => wlog += d); worker.stderr.on('data', d => wlog += d);
  try {
    // probe job
    const pj = (await call('POST', 'video-jobs', { kind: 'probe', assets: [...F.assets, { id: 'missing', type: 'video', uri: 'nope.mp4' }], callback_url: cbUrl })).j.job_id;
    st = await waitState(pj, ['completed', 'failed'], 60); ok(st && st.state === 'completed', 'probe job completes via the real worker', st);
    const pr = st && st.result && st.result.probes; ok(pr && pr.presenter.ok && pr.presenter.width === 1280 && pr.presenter.duration > 11 && pr.missing.ok === false && pr.missing.error === 'missing', 'probe reports durations/resolution and flags the missing file', pr && { p: pr.presenter, m: pr.missing });
    await sleep(2500); ok(got.some(g => g.ev === 'video_job.completed' && g.b.job.job_id === pj), 'completion callback delivered to callback_url', got.map(g => g.ev));
    // render: no plan -> waits
    const body = { instruction: 'E2E: three-scene tutorial, PiP, captions, 2 outputs', title: 'E2E Tutorial', assets: F.assets, callback_url: cbUrl,
      outputs: [{ label: 'landscape', resolution: '720p', aspect: '16:9', fps: 30, subtitles: { mode: 'both', languages: ['en', 'fr'], burn_language: 'fr' } }, { label: 'vertical', resolution: '720p', aspect: '9:16', fps: 24, quality: 'compressed' }] };
    const sj = (await call('POST', 'video-jobs', body)).j; ok(sj.state === 'awaiting_plan', 'render job without a plan waits in awaiting_plan', sj);
    await sleep(4000); st = (await call('GET', `video-jobs/status?job_id=${sj.job_id}`)).j.job; ok(st.state === 'awaiting_plan', 'worker does not claim a job that has no plan');
    r = await call('POST', 'video-jobs/plan', { job_id: sj.job_id, plan: { version: 1, scenes: [{ id: 's1', layers: [{ type: 'video', asset: 'ghost-asset' }] }] } }); ok(r.s === 400 && /not in the job/.test(JSON.stringify(r.j)), 'invalid plan (unknown asset) is rejected with a clear error', r);
    r = await call('POST', 'video-jobs/plan', { job_id: sj.job_id, plan: F.plan }); ok(r.s === 200 && r.j.state === 'queued', 'valid plan attached -> queued', r);
    const t0 = Date.now(); let seenRunning = false, maxPct = 0;
    while ((Date.now() - t0) / 1000 < 200) { st = (await call('GET', `video-jobs/status?job_id=${sj.job_id}`)).j.job; if (st.state === 'running') { seenRunning = true; maxPct = Math.max(maxPct, st.progress); } if (['completed', 'failed'].includes(st.state)) break; await sleep(1500); }
    ok(st.state === 'completed', 'render job completes on the worker', st.error || st.state); ok(seenRunning && maxPct > 0, 'progress was reported while running', { maxPct });
    const outs = (st.result && st.result.outputs) || []; ok(outs.length === 2 && outs.every(o => o.qa.ok), 'both outputs pass automated QA (playable, geometry, fps, duration, A/V sync, decode)', outs.map(o => o.qa.checks.filter(c => !c.ok)));
    for (const o of outs) { const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', o.path]).toString()); const v = p.streams.find(s => s.codec_type === 'video'); ok(v.width === (o.label === 'landscape' ? 1280 : 720) && v.height === (o.label === 'landscape' ? 720 : 1280), `independent ffprobe: ${o.label} geometry ${v.width}x${v.height}`); }
    ok(outs[0] && outs[0].subtitle_files.length === 2 && outs[0].subtitle_files.every(f => fs.existsSync(f)), 'EN + FR SRT sidecars written');
    await sleep(2500); ok(got.some(g => g.ev === 'video_job.completed' && g.b.job.job_id === sj.job_id), 'render completion callback delivered');
    console.log(`render: ${st.result.total_seconds}s wall for ${st.result.expected_duration}s of video x2 outputs; peak ffmpeg RSS ${st.result.resources.peak_rss_mb} MB; sizes ${outs.map(o => o.label + '=' + (o.size_bytes / 1e6).toFixed(1) + 'MB').join(', ')}`);
    // failure path: missing asset -> non-retryable fail with explanation
    const fj = (await call('POST', 'video-jobs', { instruction: 'broken', assets: [{ id: 'x', type: 'video', uri: 'does-not-exist.mp4' }], plan: { version: 1, scenes: [{ id: 's', layers: [{ type: 'video', asset: 'x' }] }] } })).j.job_id;
    st = await waitState(fj, ['failed', 'completed'], 40); ok(st && st.state === 'failed' && st.error.code === 'asset_problem' && /missing/.test(st.error.message), 'missing asset -> failed with readable asset_problem (no retry loop)', st && st.error);
    r = await call('POST', 'video-jobs/retry', { job_id: fj }); ok(r.s === 202, 'failed job can be retried manually'); await call('POST', 'video-jobs/cancel', { job_id: fj });
  } finally { worker.kill('SIGTERM'); await sleep(1000); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log('--- worker log tail ---\n' + wlog.slice(-3000)); }
  fs.writeFileSync(process.env.E2E_REPORT || '/tmp/e2e-report.txt', results.join('\n') + `\n\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E crashed', e); process.exit(2); });
