'use strict';
const test = require('node:test'), assert = require('node:assert'), { execFileSync } = require('child_process');
const P = require('../lib/plan'), B = require('../lib/ffmpeg-builder'), S = require('../lib/srt'), F = require('./fixtures');
const out = { width: 1280, height: 720, fps: 30, codec: 'h264', container: 'mp4', quality: 'balanced', crf: 23, preset: 'veryfast', hardware_encode: 'never', audio: { codec: 'aac', bitrate: '192k', sample_rate: 48000, channels: 2, normalize: true, loudness_lufs: -14 }, subtitles: { mode: 'none', languages: ['en'] } };
test('fixture plan validates; common mistakes are caught', () => {
  assert.equal(P.validatePlan(F.plan, F.assets, [out]).ok, true);
  const bad = JSON.parse(JSON.stringify(F.plan)); bad.scenes[1].transition_in.duration = 9; bad.audio.music.asset = 'screen'; bad.scenes[0].layers[1].text = '';
  const r = P.validatePlan(bad, F.assets, [out]); assert.equal(r.ok, false); assert.ok(r.errors.length >= 2);
  assert.match(P.validatePlan({ version: 1, scenes: [{ id: 'a', layers: [{ type: 'video', asset: 'presenter' }] }] }, F.assets, [{ subtitles: { mode: 'burn', languages: ['de'] } }]).errors.join(), /no caption track for "de"/);
  const ov = JSON.parse(JSON.stringify(F.plan)); ov.captions.cues.en[1].start = 1; assert.match(P.validatePlan(ov, F.assets, [out]).errors.join(), /overlaps/);
});
test('timeline: durations, transitions overlap, total', () => {
  const probes = { presenter: { ok: true, duration: 12 }, screen: { ok: true, duration: 12 }, stock: { ok: true, duration: 12 } };
  const t = P.resolveTimeline(F.plan, probes); assert.equal(t.ok, true); assert.equal(t.total_duration, 18.6); assert.equal(t.scenes[1].timeline_start, 5.2);
  const open = P.resolveTimeline({ version: 1, scenes: [{ id: 'a', layers: [{ type: 'video', asset: 'presenter', trim: { start: 2, end: 8 }, speed: 2 }] }] }, probes); assert.equal(open.total_duration, 3);
  assert.equal(P.resolveTimeline({ version: 1, scenes: [{ id: 'a', layers: [{ type: 'video', asset: 'zzz' }] }] }, probes).ok, false);
});
test('ffmpeg args: arrays (no shell), PiP overlay, stream-copy only when safe', () => {
  const assets = {}; F.assets.forEach(a => { assets[a.id] = { ...a, path: '/x/' + a.uri }; });
  const t = P.resolveTimeline(F.plan, { presenter: { ok: true, duration: 12 }, screen: { ok: true, duration: 12 }, stock: { ok: true, duration: 12 } });
  const enc = B.videoEncodeArgs(out, { encoders: new Set(), hwWorks: false });
  const seg = B.buildSegmentArgs({ scene: t.scenes[1], out, assets, enc, segPath: '/t/s.mp4', textDir: '/t', fontFile: '/f.ttf' }); assert.ok(Array.isArray(seg.args));
  assert.match(seg.args.join(' '), /overlay=x=main_w-overlay_w-\d+:y=main_h-overlay_h-\d+/);
  const base = { timeline: t, plan: { scenes: [], audio: {} }, out, assets, segPaths: ['/a', '/b'], enc, aenc: B.audioEncodeArgs(out), outPath: '/o.mp4', listPath: '/l.txt' };
  const noTrans = { ...t, scenes: t.scenes.map(s => ({ ...s, transition_in: undefined })) };
  assert.equal(B.buildFinalArgs({ ...base, timeline: noTrans }).copyMode, true);
  assert.equal(B.buildFinalArgs({ ...base }).copyMode, false);
  assert.equal(B.buildFinalArgs({ ...base, timeline: noTrans, burn: { srtPath: '/s.srt', style: 'FontSize=20' } }).copyMode, false);
});
test('hardware encode: auto falls back to software; always without support throws; never skips', () => {
  assert.equal(B.videoEncodeArgs({ ...out, hardware_encode: 'auto' }, { encoders: new Set(['h264_mediacodec']), hwWorks: false }).used, 'software');
  assert.equal(B.videoEncodeArgs({ ...out, hardware_encode: 'auto' }, { encoders: new Set(['h264_mediacodec']), hwWorks: true }).used, 'h264_mediacodec');
  assert.throws(() => B.videoEncodeArgs({ ...out, hardware_encode: 'always' }, { encoders: new Set(), hwWorks: false }), /always/);
  assert.equal(B.videoEncodeArgs({ ...out, hardware_encode: 'never' }, { encoders: new Set(['h264_mediacodec']), hwWorks: true }).used, 'software');
});
test('srt round-trip and sync checks', () => {
  const cues = [{ start: 0.5, end: 2.25, text: 'Hi' }, { start: 3, end: 4.5, text: 'There\nyou' }]; assert.deepEqual(S.parseSrt(S.cuesToSrt(cues)), cues);
  assert.equal(S.checkCues(cues, 10).length, 0); assert.ok(S.checkCues([{ start: 0, end: 5, text: 'a' }, { start: 4, end: 6, text: 'b' }], 10).length);
});
test('REAL ffmpeg: builder output actually renders (skipped without ffmpeg)', { skip: (() => { try { execFileSync('ffmpeg', ['-version']); return false; } catch { return 'no ffmpeg'; } })() }, () => {
  const fs = require('fs'), os = require('os'), path = require('path'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
  const run = a => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
  run(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-pix_fmt', 'yuv420p', d + '/a.mp4']); run(['-f', 'lavfi', '-i', 'sine=d=3', d + '/n.wav']);
  const assets = { a: { id: 'a', type: 'video', path: d + '/a.mp4' }, n: { id: 'n', type: 'audio', path: d + '/n.wav' } };
  const o = { ...out, width: 320, height: 180, fps: 25 }; const plan = { version: 1, scenes: [{ id: 's1', duration: 2, layers: [{ type: 'video', asset: 'a' }] }, { id: 's2', duration: 2, layers: [{ type: 'video', asset: 'a', trim: { start: 1 } }] }], audio: { narration: { asset: 'n' } } };
  const t = P.resolveTimeline(plan, { a: { ok: true, duration: 3 } }); const enc = B.videoEncodeArgs(o, { encoders: new Set(), hwWorks: false });
  const segs = t.scenes.map((s, i) => { const p = `${d}/s${i}.mp4`; execFileSync('ffmpeg', B.buildSegmentArgs({ scene: s, out: o, assets, enc, segPath: p, textDir: d, fontFile: '' }).args); return p; });
  fs.writeFileSync(d + '/l.txt', segs.map(p => `file '${p}'`).join('\n'));
  const f = B.buildFinalArgs({ timeline: t, plan, out: o, assets, segPaths: segs, enc, aenc: B.audioEncodeArgs(o), outPath: d + '/o.mp4', listPath: d + '/l.txt' }); assert.equal(f.copyMode, true); execFileSync('ffmpeg', f.args);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', d + '/o.mp4']).toString()); assert.ok(Math.abs(dur - 4) < 0.15, 'duration ' + dur);
});
