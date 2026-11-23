'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cfg = require('./config'); const U = require('./util'); const M = require('./media');
const { validatePlan, resolveTimeline } = require('../lib/plan');
const B = require('../lib/ffmpeg-builder'); const S = require('../lib/srt');

class JobError extends Error { constructor(code, message, retryable = false, details) { super(message); this.code = code; this.retryable = retryable; this.details = details; } }
let capsCache = null;
async function detectCaps() {
  if (capsCache) return capsCache;
  const enc = await U.run(cfg.ffmpeg, ['-hide_banner', '-encoders']); const fl = await U.run(cfg.ffmpeg, ['-hide_banner', '-filters']);
  if (enc.code !== 0) throw new JobError('ffmpeg_missing', `ffmpeg not runnable: ${enc.stderr.slice(0, 200)}`, false);
  const encoders = new Set((enc.stdout.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/gm) || []).map(l => l.trim().split(/\s+/)[1]));
  const filters = new Set((fl.stdout.match(/^\s*[TSC.]{3}\s+(\S+)/gm) || []).map(l => l.trim().split(/\s+/)[1]));
  let hwWorks = false;
  if (encoders.has('h264_mediacodec')) { const t = await U.run(cfg.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-c:v', 'h264_mediacodec', '-b:v', '1M', '-f', 'null', '-']); hwWorks = t.code === 0; }
  capsCache = { encoders, filters, hwWorks, drawtext: filters.has('drawtext') && !!cfg.fontFile, subtitles: filters.has('subtitles') };
  return capsCache;
}
const hash = o => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

async function ffmpeg(args, o) {
  let child; let cancelled = false; let lastP = 0;
  const r = await U.run(cfg.ffmpeg, args, {
    onSpawn: p => { child = p; o.stop = U.monitor(p.pid); },
    onLine: line => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && o.expected) { const sec = +m[1] / 1e6; const f = Math.min(1, sec / o.expected); if (f - lastP >= 0.01 && o.onFraction) { lastP = f; o.onFraction(f); } }
      if (o.cancelled && o.cancelled() && child && !cancelled) { cancelled = true; child.kill('SIGTERM'); }
    },
  });
  const stats = o.stop ? o.stop() : null;
  if (cancelled) throw new JobError('cancelled', 'job cancelled', false);
  return { ...r, stats };
}
const merge = (a, b) => !b ? a : ({ peak_rss_mb: Math.max(a.peak_rss_mb || 0, b.peak_rss_mb || 0), cpu_seconds: Math.round(((a.cpu_seconds || 0) + (b.cpu_seconds || 0)) * 10) / 10, measured: a.measured || b.measured });

async function qaOutput(file, o, expectedDur, hasAudio, cueProblems) {
  const checks = []; const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const p = await M.probe(file);
  if (!p.ok) { add('playable', false, p.message); return { ok: false, checks, probe: p }; }
  add('playable', true); add('has_video', p.has_video, p.vcodec);
  add('geometry', p.width === o.width && p.height === o.height, `${p.width}x${p.height} expected ${o.width}x${o.height}`);
  add('fps', p.fps && Math.abs(p.fps - o.fps) < 0.6, `${p.fps} expected ${o.fps}`);
  add('duration', p.duration && Math.abs(p.duration - expectedDur) <= Math.max(0.5, expectedDur * 0.01), `${p.duration} expected ${expectedDur}`);
  if (hasAudio) add('has_audio', p.has_audio, p.acodec);
  if (p.has_audio) {
    const a = await U.run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]);
    const ad = parseFloat(a.stdout); if (ad && p.duration) add('av_sync_duration', Math.abs(ad - p.duration) <= 0.35, `audio ${ad}s vs container ${p.duration}s`);
  }
  if (cueProblems && cueProblems.length) add('subtitle_sync', false, cueProblems.slice(0, 3).join('; '));
  else if (cueProblems) add('subtitle_sync', true);
  if (cfg.qaFullDecode) { const d = await U.run(cfg.ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-']); add('full_decode', d.code === 0 && !d.stderr.trim(), d.stderr.trim().slice(0, 200)); }
  return { ok: checks.every(c => c.ok), checks, probe: p };
}

async function loadCues(plan, assets, transcribed) {
  const tracks = {}; const c = plan.captions || {};
  Object.keys(c.cues || {}).forEach(l => { tracks[l] = c.cues[l]; });
  for (const l of Object.keys(c.srt_assets || {})) tracks[l] = S.parseSrt(fs.readFileSync(assets[c.srt_assets[l]].path, 'utf8'));
  if (transcribed) tracks[c.transcribe.language] = transcribed;
  return tracks;
}

async function renderJob(job, ctx) {
  const t0 = Date.now(); const warnings = []; let stats = {};
  const log = m => ctx.log && ctx.log(m);
  const caps = await detectCaps();
  ctx.progress(1, 'validating_assets', 'Checking assets');
  const assets = await M.resolveAssets(job.assets, log);
  const bad = Object.values(assets).filter(a => !a.probe.ok);
  if (bad.length) throw new JobError('asset_problem', `${bad.length} asset(s) missing/unusable: ` + bad.map(a => `${a.id} (${a.probe.error}: ${a.probe.message})`).join('; '), bad.every(a => a.probe.error === 'download_failed'), bad.map(a => ({ id: a.id, ...a.probe })));
  if (!job.plan) throw new JobError('no_plan', 'job has no editing plan', false);
  const v = validatePlan(job.plan, job.assets, job.outputs); if (!v.ok) throw new JobError('invalid_plan', v.errors.join('; '), false, v.errors);
  warnings.push(...v.warnings);
  const probes = {}; Object.values(assets).forEach(a => { probes[a.id] = a.probe; });
  const tl = resolveTimeline(job.plan, probes); if (!tl.ok) throw new JobError('invalid_timeline', tl.errors.join('; '), false, tl.errors);

  // transcription of the base language (optional)
  let transcribed = null;
  if (job.plan.captions && job.plan.captions.transcribe) {
    ctx.progress(3, 'transcribing', 'Transcribing speech'); const T = require('./transcribe');
    transcribed = await T.transcribe(assets[job.plan.captions.transcribe.asset].path, job.plan.captions.transcribe.language, path.join(cfg.tmpDir, job.job_id), ctx.cancelled);
  }
  const tracks = await loadCues(job.plan, assets, transcribed);

  // preflight resources
  const mem = U.readMeminfo(); if (mem.available_mb !== null && mem.available_mb < cfg.minFreeRamMb) throw new JobError('low_memory', `only ${mem.available_mb} MB RAM available (< ${cfg.minFreeRamMb})`, true);
  const free = U.freeStorageMb(cfg.dataDir);
  const need = job.outputs.reduce((s, o) => s + (B.hwBitrateKbps(o.width, o.height, o.fps, o.quality) * 125 * tl.total_duration * 2.5) / 1048576, 0);
  if (free !== null && free < need + cfg.minFreeStorageMb) throw new JobError('low_storage', `free ${free} MB < estimated ${Math.round(need)} MB + reserve ${cfg.minFreeStorageMb} MB`, true);

  const tmp = path.join(cfg.tmpDir, job.job_id); fs.mkdirSync(path.join(tmp, 'seg'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'txt'), { recursive: true });
  const outDir = path.join(cfg.outputDir, job.job_id); fs.mkdirSync(outDir, { recursive: true });
  const needText = job.plan.scenes.some(s => s.layers.some(l => l.type === 'text'));
  if (needText && !caps.drawtext) throw new JobError('capability_missing', 'text overlays need ffmpeg drawtext and a font file (set VW_FONT_FILE)', false);

  const results = []; const unitsPerOut = tl.scenes.reduce((s, x) => s + x.duration, 0) + tl.total_duration * 0.5; const totalUnits = unitsPerOut * job.outputs.length; let done = 0;
  const upd = (extra, stage, msg) => ctx.progress(Math.min(99, 5 + 94 * (done + extra) / totalUnits), stage, msg);
  for (const out of job.outputs) {
    const ot0 = Date.now();
    const lowSources = Object.values(assets).filter(a => a.type === 'video' && a.probe.height && a.probe.height < Math.min(out.width, out.height)).map(a => a.id);
    if (out.no_upscale && lowSources.length) warnings.push(`[${out.label}] sources smaller than ${out.width}x${out.height} are upscaled: ${lowSources.join(', ')}`);
    const enc = B.videoEncodeArgs(out, caps, { threads: cfg.threads }); const aenc = B.audioEncodeArgs(out);
    if (enc.used !== 'software') log(`[${out.label}] using hardware encoder ${enc.used}`);
    const ext = out.container; const segPaths = [];
    for (let i = 0; i < tl.scenes.length; i++) {
      const sc = tl.scenes[i]; const key = hash({ sc: { ...sc, timeline_start: 0 }, g: [out.width, out.height, out.fps], e: enc.args, a: sc.layers.filter(l => l.asset).map(l => { const s = fs.statSync(assets[l.asset].path); return [l.asset, s.size, s.mtimeMs]; }) });
      const seg = path.join(tmp, 'seg', `${String(i).padStart(3, '0')}_${key}.${ext === 'webm' ? 'webm' : 'mp4'}`); segPaths.push(seg);
      if (fs.existsSync(seg) && fs.statSync(seg).size > 0) { log(`[${out.label}] scene ${sc.id}: reused cached segment (resume)`); done += sc.duration; continue; }
      const built = B.buildSegmentArgs({ scene: sc, out, assets, enc, segPath: seg + '.part.' + ext, textDir: path.join(tmp, 'txt'), fontFile: cfg.fontFile });
      built.textFiles.forEach(f => fs.writeFileSync(f.path, f.content));
      const base = done; const r = await ffmpeg(built.args, { expected: sc.duration, cancelled: ctx.cancelled, onFraction: f => upd(f * sc.duration, 'rendering', `[${out.label}] scene ${i + 1}/${tl.scenes.length}`) });
      if (r.code !== 0) throw new JobError('ffmpeg_failed', `scene ${sc.id}: ${r.stderr.trim().slice(-400)}`, false);
      fs.renameSync(seg + '.part.' + ext, seg); stats = merge(stats, r.stats); done = base + sc.duration; upd(0, 'rendering', `[${out.label}] scene ${i + 1}/${tl.scenes.length} done`);
    }
    // subtitles
    const sub = out.subtitles; let burn = null; const cueProblems = []; const sidecars = [];
    if (sub.mode !== 'none') {
      for (const l of sub.languages) {
        const cues = tracks[l]; const p = S.checkCues(cues, tl.total_duration); p.forEach(x => cueProblems.push(`${l}: ${x}`));
        if (sub.mode === 'srt' || sub.mode === 'both') { const f = path.join(outDir, `${job.title_slug || 'video'}_${out.label}.${l}.srt`); fs.writeFileSync(f, S.cuesToSrt(cues)); sidecars.push(f); }
      }
      if (sub.mode === 'burn' || sub.mode === 'both') {
        if (!caps.subtitles) throw new JobError('capability_missing', 'burned captions need an ffmpeg build with the libass "subtitles" filter; use subtitles.mode "srt" instead', false);
        const bl = sub.burn_language || sub.languages[0]; const sf = path.join(tmp, `burn_${out.label}_${bl}.srt`); fs.writeFileSync(sf, S.cuesToSrt(tracks[bl]));
        burn = { srtPath: sf, style: B.subtitleStyle(sub.style, out), fontsDir: cfg.fontFile ? path.dirname(cfg.fontFile) : undefined };
      }
    }
    const wmAsset = job.plan.watermark; const watermark = wmAsset ? { ...wmAsset, path: assets[wmAsset.asset].path } : null;
    const listPath = path.join(tmp, `list_${out.label}.txt`); fs.writeFileSync(listPath, segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const outPath = path.join(outDir, `${job.title_slug || 'video'}_${out.label}.${ext}`);
    const fin = B.buildFinalArgs({ timeline: tl, plan: job.plan, out, assets, segPaths, enc, aenc, outPath: outPath + '.part.' + ext, listPath, burn, watermark });
    const finUnits = tl.total_duration * 0.5; const base2 = done;
    const fr = await ffmpeg(fin.args, { expected: tl.total_duration, cancelled: ctx.cancelled, onFraction: f => upd(f * finUnits, 'finalizing', `[${out.label}] ${fin.copyMode ? 'muxing (stream copy)' : 'encoding final'}`) });
    if (fr.code !== 0) throw new JobError('ffmpeg_failed', `final pass: ${fr.stderr.trim().slice(-400)}`, false);
    fs.renameSync(outPath + '.part.' + ext, outPath); stats = merge(stats, fr.stats); done = base2 + finUnits;
    ctx.progress(Math.min(99, 5 + 94 * done / totalUnits), 'qa', `[${out.label}] quality checks`);
    const hasAudio = !!(job.plan.audio && (job.plan.audio.narration || job.plan.audio.music || (job.plan.audio.sfx || []).length));
    const qa = await qaOutput(outPath, out, tl.total_duration, hasAudio, sub.mode !== 'none' ? cueProblems : null);
    results.push({ label: out.label, path: outPath, size_bytes: fs.statSync(outPath).size, sha256: await U.sha256File(outPath), duration: qa.probe.duration, width: qa.probe.width, height: qa.probe.height, fps: qa.probe.fps, vcodec: qa.probe.vcodec, acodec: qa.probe.acodec,
      encoder: enc.used, stream_copy_video: fin.copyMode, subtitle_files: sidecars, qa: { ok: qa.ok, checks: qa.checks }, render_seconds: Math.round((Date.now() - ot0) / 100) / 10 });
  }
  if (!cfg.keepTmp) fs.rmSync(tmp, { recursive: true, force: true });
  const allOk = results.every(r => r.qa.ok);
  return { outputs: results, qa_ok: allOk, warnings, total_seconds: Math.round((Date.now() - t0) / 100) / 10, expected_duration: tl.total_duration, resources: { peak_rss_mb: stats.peak_rss_mb, cpu_seconds: stats.cpu_seconds, measured: !!stats.measured, ffmpeg_peak_rss_note: 'peak RSS of the largest single ffmpeg process' } };
}
module.exports = { renderJob, detectCaps, JobError };
