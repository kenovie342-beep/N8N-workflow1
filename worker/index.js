#!/usr/bin/env node
'use strict';
// Android/Termux render worker. Outbound-only: it polls n8n over HTTPS, so carrier NAT is irrelevant.
const fs = require('fs'), path = require('path');
const cfg = require('./config'); const api = require('./api'); const U = require('./util'); const M = require('./media');
const { renderJob, detectCaps, JobError } = require('./render');

const log = (...a) => console.log(new Date().toISOString(), ...a);
let stopping = false, active = 0, netBackoff = 0;
const pendingFile = path.join(cfg.stateDir, 'pending-report.json'), currentFile = path.join(cfg.stateDir, 'current.json');
const wr = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };

async function send(kind, body, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { return await api[kind](body); }
    catch (e) { if (e.status && e.status < 500) return { ok: false, status: e.status, error: e.message }; log(`${kind} failed (${e.message}); retry ${i + 1}/${tries}`); await U.sleep(Math.min(30000, 2000 * 2 ** i)); }
  }
  return null;
}
async function flushPending() {
  if (!fs.existsSync(pendingFile)) return;
  const p = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); log(`re-sending unreported ${p.kind} for ${p.body.job_id}`);
  const r = await send(p.kind, p.body, 3);
  if (r) { fs.unlinkSync(pendingFile); log('pending report delivered/closed:', JSON.stringify(r).slice(0, 120)); }
}
async function upload(out, url) {
  const st = fs.statSync(out.path); const { Readable } = require('stream');
  const res = await fetch(url, { method: 'PUT', body: Readable.toWeb(fs.createReadStream(out.path)), duplex: 'half', headers: { 'Content-Length': String(st.size), 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!res.ok) throw new JobError('upload_failed', `upload ${out.label}: HTTP ${res.status}`, true);
}

async function runJob(job) {
  const t0 = Date.now(); let cancelled = false; let last = { p: 0, stage: 'claimed', msg: '' }; let lastSent = 0, lastStage = '';
  wr(currentFile, { job_id: job.job_id, started: new Date().toISOString(), attempt: job.attempt });
  const sendProgress = async () => {
    lastSent = Date.now(); const r = await send('progress', { job_id: job.job_id, worker_id: cfg.workerId, percent: last.p, stage: last.stage, message: last.msg, ram_free_mb: U.readMeminfo().available_mb }, 1);
    if (r && (r.cancel || r.status === 409)) { cancelled = true; }
  };
  const hb = setInterval(() => { if (Date.now() - lastSent > 20000) sendProgress(); }, 10000);
  const ctx = { log, cancelled: () => cancelled || stopping,
    progress: (p, stage, msg) => { last = { p, stage, msg }; if (Date.now() - lastSent > 4000 || stage !== lastStage) { lastStage = stage; sendProgress(); } } };
  let kind = 'complete', body;
  try {
    log(`job ${job.job_id} (${job.kind}) attempt ${job.attempt}`);
    let result;
    if (job.kind === 'probe') {
      const res = await M.resolveAssets(job.assets, log); const probes = {}; Object.values(res).forEach(a => { probes[a.id] = a.probe; });
      result = { probes, qa_ok: true, outputs: [], summary: Object.values(probes).map(p => p.ok).filter(Boolean).length + '/' + job.assets.length + ' assets usable' };
    } else if (job.kind === 'transcribe') {
      const res = await M.resolveAssets(job.assets, log); const a = Object.values(res)[0]; if (!a.probe.ok) throw new JobError('asset_problem', `${a.id}: ${a.probe.error} ${a.probe.message}`, false);
      const cues = await require('./transcribe').transcribe(a.path, job.language, path.join(cfg.tmpDir, job.job_id), ctx.cancelled);
      result = { cues, qa_ok: true, outputs: [], language: job.language };
    } else {
      result = await renderJob(job, ctx);
      if (job.delivery && job.delivery.upload_url) for (const o of result.outputs) { ctx.progress(99, 'uploading', `uploading ${o.label}`); await upload(o, job.delivery.upload_url.replace('{label}', o.label)); o.uploaded = true; }
    }
    if (stopping) throw new JobError('worker_shutdown', 'worker shutting down', true);
    body = { job_id: job.job_id, worker_id: cfg.workerId, result };
  } catch (e) {
    kind = 'fail';
    const code = stopping && e.code === 'cancelled' ? 'worker_shutdown' : (e.code || 'worker_error');
    body = { job_id: job.job_id, worker_id: cfg.workerId, error: { code, message: String(e.message || e), retryable: stopping ? true : !!e.retryable, details: e.details } };
    log(`job ${job.job_id} failed: ${code}: ${e.message}`);
  } finally { clearInterval(hb); }
  if (kind === 'fail' && cancelled && !stopping) body.error = { code: 'cancelled', message: 'cancelled by user', retryable: false };
  wr(pendingFile, { kind, body });
  const r = await send(kind, body);
  if (r) { fs.unlinkSync(pendingFile); log(`job ${job.job_id} ${kind} reported in ${Math.round((Date.now() - t0) / 1000)}s: ${JSON.stringify(r).slice(0, 100)}`); }
  else log('could not reach n8n; report saved and will be re-sent');
  if (fs.existsSync(currentFile)) fs.unlinkSync(currentFile);
}

async function diagnostics() {
  const caps = await detectCaps(); const mem = U.readMeminfo();
  console.log(JSON.stringify({ worker_id: cfg.workerId, n8n: cfg.baseUrl || '(VW_N8N_BASE_URL not set)', node: process.version, ffmpeg_encoders: ['libx264', 'libx265', 'libvpx-vp9', 'h264_mediacodec', 'aac', 'libopus', 'libmp3lame'].filter(e => caps.encoders.has(e)),
    filters: { drawtext: caps.drawtext, subtitles: caps.subtitles, xfade: caps.filters.has('xfade'), loudnorm: caps.filters.has('loudnorm'), sidechaincompress: caps.filters.has('sidechaincompress') }, hardware_h264_encode_works: caps.hwWorks, font_file: cfg.fontFile,
    whisper: !!(cfg.whisperBin && fs.existsSync(cfg.whisperModel || '')), ram: mem, free_storage_mb: U.freeStorageMb(cfg.dataDir), asset_root: cfg.assetRoot, output_dir: cfg.outputDir, max_concurrent: cfg.maxConcurrent }, null, 2));
  if (cfg.baseUrl && cfg.workerKey) { try { const r = await api.claim({ worker_id: cfg.workerId, busy: true }); console.log('n8n connection + worker key:', r.ok ? 'OK' : JSON.stringify(r)); } catch (e) { console.log('n8n connection FAILED:', e.message); process.exitCode = 1; } }
}

async function main() {
  [cfg.dataDir, cfg.assetRoot, cfg.outputDir, cfg.tmpDir, cfg.stateDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
  if (process.argv.includes('--check')) return diagnostics();
  if (!cfg.baseUrl || !cfg.workerKey) { console.error('Set VW_N8N_BASE_URL (e.g. https://host/webhook) and VW_WORKER_KEY'); process.exit(2); }
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { log(`${s}: finishing/aborting current job and exiting`); stopping = true; });
  // crash recovery: a leftover current.json means the process died mid-render; n8n will re-queue after the lease expires, cached segments make the re-run fast.
  if (fs.existsSync(currentFile)) { log('previous run was interrupted:', fs.readFileSync(currentFile, 'utf8')); fs.unlinkSync(currentFile); }
  const cutoff = Date.now() - 3 * 86400000; try { for (const d of fs.readdirSync(cfg.tmpDir)) { const p = path.join(cfg.tmpDir, d); if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } } catch { /* ignore */ }
  const caps = await detectCaps(); log(`worker ${cfg.workerId} up; hw h264 encode: ${caps.hwWorks}; drawtext: ${caps.drawtext}; subtitles(libass): ${caps.subtitles}`);
  while (!stopping) {
    try {
      await flushPending();
      const mem = U.readMeminfo(), free = U.freeStorageMb(cfg.dataDir);
      const lowRam = mem.available_mb !== null && mem.available_mb < cfg.minFreeRamMb, lowDisk = free !== null && free < cfg.minFreeStorageMb;
      if (active >= cfg.maxConcurrent || lowRam || lowDisk) { if (lowRam || lowDisk) log(`not claiming: ram ${mem.available_mb}MB, disk ${free}MB`); await U.sleep(cfg.pollSeconds * 1000); continue; }
      const r = await api.claim({ worker_id: cfg.workerId, free_ram_mb: mem.available_mb, free_storage_mb: free }); netBackoff = 0;
      if (r.job) { active++; runJob(r.job).catch(e => log('runJob crashed', e)).finally(() => { active--; }); await U.sleep(500); }
      else await U.sleep(cfg.pollSeconds * 1000 * (0.8 + Math.random() * 0.4));
    } catch (e) { netBackoff = Math.min(60, (netBackoff || 2) * 2); log(`n8n unreachable (${e.message}); retry in ${netBackoff}s`); await U.sleep(netBackoff * 1000); }
  }
  while (active > 0) await U.sleep(500); log('stopped');
}
main().catch(e => { console.error(e); process.exit(1); });
