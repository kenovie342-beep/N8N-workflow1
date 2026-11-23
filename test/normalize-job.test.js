'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeJob } = require('../lib/normalize-job');
const ctx = { id: 'job_t', now: '2026-01-01T00:00:00.000Z' };
const run = b => normalizeJob(b, ctx);

test('rejects missing instruction and non-object body', () => {
  assert.equal(run({}).ok, false);
  assert.equal(run(null).ok, false);
  assert.equal(run([]).ok, false);
  assert.equal(run({ instruction: '   ' }).ok, false);
});
test('defaults are applied AND reported', () => {
  const r = run({ instruction: 'make a video' });
  assert.equal(r.ok, true);
  const o = r.job.outputs[0];
  assert.deepEqual([o.width, o.height, o.fps, o.codec, o.container], [1920, 1080, 30, 'h264', 'mp4']);
  assert.ok(r.defaults_applied.length > 0);
  assert.equal(r.job.kind, 'render');
});
test('geometry: presets x aspects', () => {
  const g = (resolution, aspect) => { const o = run({ instruction: 'x', output: { resolution, aspect } }).job.outputs[0]; return [o.width, o.height]; };
  assert.deepEqual(g('720p', '16:9'), [1280, 720]);
  assert.deepEqual(g('1080p', '9:16'), [1080, 1920]);
  assert.deepEqual(g('1080p', '1:1'), [1080, 1080]);
  assert.deepEqual(g('1440p', '16:9'), [2560, 1440]);
  assert.deepEqual(g('4k', '16:9'), [3840, 2160]);
  assert.deepEqual(g('1080p', '4:3'), [1440, 1080]);
});
test('custom size ok; odd or partial size rejected (not silently changed)', () => {
  assert.equal(run({ instruction: 'x', output: { width: 1080, height: 1920 } }).job.outputs[0].resolution, 'custom');
  assert.equal(run({ instruction: 'x', output: { width: 1081, height: 1920 } }).ok, false);
  assert.equal(run({ instruction: 'x', output: { width: 1080 } }).ok, false);
});
test('codec/container mismatch rejected, not auto-fixed', () => {
  assert.equal(run({ instruction: 'x', output: { codec: 'vp9', container: 'mp4' } }).ok, false);
  const r = run({ instruction: 'x', output: { codec: 'vp9' } });
  assert.equal(r.ok, true);
  assert.deepEqual([r.job.outputs[0].container, r.job.outputs[0].audio.codec], ['webm', 'opus']);
  assert.equal(run({ instruction: 'x', output: { codec: 'hevc' } }).job.outputs[0].codec, 'h265');
});
test('quality -> crf; explicit bitrate suppresses crf', () => {
  assert.equal(run({ instruction: 'x', output: { quality: 'high' } }).job.outputs[0].crf, 18);
  const o = run({ instruction: 'x', output: { video_bitrate: '8M' } }).job.outputs[0];
  assert.equal(o.crf, undefined); assert.equal(o.video_bitrate, '8M');
});
test('fps bounds and types', () => {
  assert.equal(run({ instruction: 'x', output: { fps: 60 } }).job.outputs[0].fps, 60);
  assert.equal(run({ instruction: 'x', output: { fps: 0 } }).ok, false);
  assert.equal(run({ instruction: 'x', output: { fps: '30' } }).ok, false);
});
test('multiple outputs; duplicate labels and output+outputs rejected', () => {
  const r = run({ instruction: 'x', outputs: [{ label: 'yt', resolution: '1080p' }, { label: 'vertical', aspect: '9:16' }] });
  assert.equal(r.ok, true); assert.equal(r.job.outputs.length, 2);
  assert.equal(run({ instruction: 'x', outputs: [{ label: 'a' }, { label: 'a' }] }).ok, false);
  assert.equal(run({ instruction: 'x', output: {}, outputs: [{}] }).ok, false);
  assert.equal(run({ instruction: 'x', outputs: [] }).ok, false);
});
test('assets: type inference, roles, duplicates, traversal, schemes', () => {
  const ok = run({ instruction: 'x', assets: [
    { id: 'p1', uri: 'uploads/presenter.mp4', role: 'presenter' },
    { id: 'n1', uri: 'https://x.test/voice.wav', role: 'narration' },
    { id: 's1', uri: 'sub.srt' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.job.assets.map(a => a.type), ['video', 'audio', 'subtitle']);
  assert.equal(run({ instruction: 'x', assets: [{ id: 'a', uri: 'a.mp4' }, { id: 'a', uri: 'b.mp4' }] }).ok, false);
  assert.equal(run({ instruction: 'x', assets: [{ id: 'a', uri: '../etc/passwd.mp4' }] }).ok, false);
  assert.equal(run({ instruction: 'x', assets: [{ id: 'a', uri: 'file:///data/a.mp4' }] }).ok, false);
  assert.equal(run({ instruction: 'x', assets: [{ id: 'a', uri: 'noext' }] }).ok, false);
  assert.equal(run({ instruction: 'x', assets: [{ id: 'a', uri: 'a.mp4', role: 'bogus' }] }).ok, false);
  assert.equal(run({ instruction: 'x', assets: 'nope' }).ok, false);
});
test('subtitles and audio validation', () => {
  const o = run({ instruction: 'x', output: { subtitles: { mode: 'both', languages: ['en', 'fr', 'pt-BR'] } } }).job.outputs[0];
  assert.equal(o.subtitles.mode, 'both');
  assert.equal(run({ instruction: 'x', output: { subtitles: { mode: 'weird' } } }).ok, false);
  assert.equal(run({ instruction: 'x', output: { subtitles: { languages: ['english'] } } }).ok, false);
  assert.equal(run({ instruction: 'x', output: { audio: { codec: 'opus' } } }).ok, false); // opus not in mp4
  assert.equal(run({ instruction: 'x', output: { audio: { loudness_lufs: 3 } } }).ok, false);
});
test('misc fields', () => {
  assert.equal(run({ instruction: 'x', priority: 10 }).ok, false);
  assert.equal(run({ instruction: 'x', callback_url: 'ftp://x' }).ok, false);
  assert.equal(run({ instruction: 'x', idempotency_key: 'bad key!' }).ok, false);
  assert.equal(run({ instruction: 'x', priority: 9, callback_url: 'https://a.test/cb', idempotency_key: 'k-1' }).ok, true);
});
