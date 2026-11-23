'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cfg = require('./config'); const { run } = require('./util');

async function probe(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'missing', message: 'file not found' };
  const st = fs.statSync(file); if (!st.size) return { ok: false, error: 'empty', message: 'file is empty' };
  const r = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) return { ok: false, error: 'unreadable', message: (r.stderr || 'ffprobe failed').trim().slice(0, 300) };
  let j; try { j = JSON.parse(r.stdout); } catch { return { ok: false, error: 'unreadable', message: 'bad ffprobe output' }; }
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  const pic = (j.streams || []).find(s => s.codec_type === 'video');
  const dur = parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration)) || null;
  const fr = v && v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate.split('/').reduce((x, y) => x / y) : null;
  const isImage = !!pic && !a && (!dur || dur < 0.05 || /image2|png_pipe|jpeg_pipe|webp_pipe|gif/.test((j.format || {}).format_name || '')) && !v;
  return { ok: true, duration: dur, size_bytes: st.size, container: (j.format || {}).format_name, has_video: !!v || !!pic, has_audio: !!a,
    width: (v || pic || {}).width || null, height: (v || pic || {}).height || null, fps: fr ? Math.round(fr * 100) / 100 : null,
    vcodec: (v || pic || {}).codec_name || null, acodec: a ? a.codec_name : null, audio_channels: a ? a.channels : null, is_image: isImage || (!!pic && !a && !dur) };
}
async function quickDecode(file, secs = 2) {
  const r = await run(cfg.ffmpeg, ['-v', 'error', '-nostdin', '-t', String(secs), '-i', file, '-f', 'null', '-']);
  return r.code === 0 && !r.stderr.trim() ? null : (r.stderr.trim().slice(0, 300) || `exit ${r.code}`);
}
function underAllowed(p) {
  let real; try { real = fs.realpathSync(p); } catch { return false; }
  return cfg.allowedRoots.some(r => { try { const rr = fs.realpathSync(r); return real === rr || real.startsWith(rr + path.sep); } catch { return false; } });
}
async function download(uri, dest, onLog) {
  const u = new URL(uri);
  if (cfg.allowedHosts && !cfg.allowedHosts.includes(u.hostname)) throw Object.assign(new Error(`host ${u.hostname} not in VW_ALLOWED_ASSET_HOSTS`), { code: 'asset_forbidden' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part'; let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(uri, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (res.status === 416) { fs.renameSync(part, dest); return; }
  if (!res.ok && res.status !== 206) throw Object.assign(new Error(`download ${res.status} for ${u.hostname}`), { code: res.status >= 500 ? 'download_failed' : 'asset_unavailable', retryable: res.status >= 500 });
  if (res.status === 200 && have) { fs.truncateSync(part, 0); have = 0; }
  const ws = fs.createWriteStream(part, { flags: 'a' });
  const { Readable } = require('stream'); const { pipeline } = require('stream/promises');
  await pipeline(Readable.fromWeb(res.body), ws);
  fs.renameSync(part, dest); if (onLog) onLog(`downloaded ${path.basename(dest)}`);
}
// Resolve each job asset to a local file. Originals are never modified or deleted.
async function resolveAssets(assets, onLog) {
  const out = {};
  for (const a of assets) {
    try {
      let p;
      if (/^https?:\/\//i.test(a.uri)) {
        const ext = (/\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(a.uri) || [null, 'bin'])[1];
        p = path.join(cfg.assetRoot, 'cache', crypto.createHash('sha1').update(a.uri).digest('hex') + '.' + ext);
        if (!fs.existsSync(p)) await download(a.uri, p, onLog);
      } else {
        p = path.isAbsolute(a.uri) ? a.uri : path.join(cfg.assetRoot, a.uri);
        if (!underAllowed(p)) { out[a.id] = { ...a, path: p, probe: { ok: false, error: fs.existsSync(p) ? 'forbidden_path' : 'missing', message: fs.existsSync(p) ? 'path outside allowed roots' : 'file not found on the phone' } }; continue; }
      }
      const pr = (a.type === 'subtitle' || a.type === 'script') ? { ok: fs.existsSync(p), size_bytes: fs.existsSync(p) ? fs.statSync(p).size : 0 } : await probe(p);
      if (pr.ok && a.type === 'video' && !pr.has_video) { pr.ok = false; pr.error = 'wrong_type'; pr.message = 'declared video but has no video stream'; }
      if (pr.ok && a.type === 'audio' && !pr.has_audio) { pr.ok = false; pr.error = 'wrong_type'; pr.message = 'declared audio but has no audio stream'; }
      if (pr.ok && (a.type === 'video' || a.type === 'audio')) { const bad = await quickDecode(p); if (bad) { pr.ok = false; pr.error = 'corrupt'; pr.message = bad; } }
      out[a.id] = { ...a, path: p, probe: pr };
    } catch (e) { out[a.id] = { ...a, path: null, probe: { ok: false, error: e.code || 'fetch_failed', message: String(e.message).slice(0, 300) } }; }
  }
  return out;
}
module.exports = { probe, quickDecode, resolveAssets };
