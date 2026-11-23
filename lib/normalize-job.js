'use strict';
// Validates a video-job submission and fills in sensible, REPORTED defaults.
// Pure function: no n8n APIs, so it is unit-testable and embedded verbatim
// into the n8n Code node by scripts/build-workflow.js.

const RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '2k': 1440, '4k': 2160, '2160p': 2160 };
const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3], '21:9': [21, 9] };
const CODECS = { h264: 'libx264', h265: 'libx265', hevc: 'libx265', vp9: 'libvpx-vp9' };
const CONTAINERS = { mp4: ['h264', 'h265'], mov: ['h264', 'h265'], mkv: ['h264', 'h265', 'vp9'], webm: ['vp9'] };
const AUDIO_CODECS = { aac: ['mp4', 'mov', 'mkv'], mp3: ['mp4', 'mkv'], opus: ['mkv', 'webm'] };
const QUALITY_CRF = {
  h264: { compressed: 28, balanced: 23, high: 18 },
  h265: { compressed: 30, balanced: 26, high: 21 },
  vp9: { compressed: 38, balanced: 32, high: 26 },
};
const ASSET_TYPES = ['video', 'audio', 'image', 'subtitle', 'script', 'other'];
const ASSET_ROLES = ['presenter', 'screen_recording', 'stock', 'narration', 'music', 'sfx', 'image', 'subtitle', 'script', 'other'];
const EXT_TYPE = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
  subtitle: ['srt', 'vtt', 'ass'],
  script: ['txt', 'md', 'docx'],
};

function inferType(uri) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  for (const t of Object.keys(EXT_TYPE)) if (EXT_TYPE[t].includes(ext)) return t;
  return null;
}

function normalizeAssets(raw, errors, warnings) {
  if (raw === undefined) { warnings.push('No assets supplied; the plan can only use stock/API sources.'); return []; }
  if (!Array.isArray(raw)) { errors.push('assets must be an array'); return []; }
  if (raw.length > 200) errors.push('assets: maximum 200 per job');
  const seen = new Set();
  const out = [];
  raw.forEach((a, i) => {
    const p = `assets[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${p} must be an object`); return; }
    if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) { errors.push(`${p}.id must match [A-Za-z0-9_-]{1,64}`); return; }
    if (seen.has(a.id)) errors.push(`${p}.id "${a.id}" is duplicated`);
    seen.add(a.id);
    if (typeof a.uri !== 'string' || !a.uri.length || a.uri.length > 2048) { errors.push(`${p}.uri is required (http(s) URL or worker-relative path)`); return; }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(a.uri)) errors.push(`${p}.uri must not contain ".."`);
    if (!/^https?:\/\//i.test(a.uri) && /^[a-z][a-z0-9+.-]*:/i.test(a.uri)) errors.push(`${p}.uri scheme not allowed (use http(s) or a relative path)`);
    let type = a.type;
    if (type === undefined) { type = inferType(a.uri); if (!type) errors.push(`${p}.type could not be inferred from uri; set it explicitly`); }
    else if (!ASSET_TYPES.includes(type)) errors.push(`${p}.type must be one of ${ASSET_TYPES.join(', ')}`);
    const role = a.role === undefined ? 'other' : a.role;
    if (!ASSET_ROLES.includes(role)) errors.push(`${p}.role must be one of ${ASSET_ROLES.join(', ')}`);
    out.push({ id: a.id, type, role, uri: a.uri, label: typeof a.label === 'string' ? a.label.slice(0, 120) : undefined, status: 'pending_validation' });
  });
  return out;
}

function normalizeOutput(o, idx, errors, defaults) {
  const p = `outputs[${idx}]`;
  const used = (k, v) => defaults.push(`${p}.${k}=${v}`);
  if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(`${p} must be an object`); return null; }
  const r = {};
  r.label = o.label === undefined ? `v${idx + 1}` : o.label;
  if (typeof r.label !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(r.label)) errors.push(`${p}.label must match [A-Za-z0-9_-]{1,32}`);

  // --- geometry ---
  const hasW = o.width !== undefined, hasH = o.height !== undefined;
  if (hasW || hasH) {
    if (!(hasW && hasH)) errors.push(`${p}: custom size needs both width and height`);
    else if (![o.width, o.height].every(n => Number.isInteger(n) && n >= 16 && n <= 7680)) errors.push(`${p}: width/height must be integers 16-7680`);
    else if (o.width % 2 || o.height % 2) errors.push(`${p}: width/height must be even (yuv420p requirement); not auto-changed`);
    else { r.width = o.width; r.height = o.height; r.resolution = 'custom'; r.aspect = `${o.width}:${o.height}`; }
  } else {
    let res = o.resolution; if (res === undefined) { res = '1080p'; used('resolution', res); }
    let asp = o.aspect; if (asp === undefined) { asp = '16:9'; used('aspect', asp); }
    const short = RESOLUTIONS[String(res).toLowerCase()], ar = ASPECTS[asp];
    if (!short) errors.push(`${p}.resolution must be one of ${Object.keys(RESOLUTIONS).join(', ')} or give width+height`);
    if (!ar) errors.push(`${p}.aspect must be one of ${Object.keys(ASPECTS).join(', ')} or give width+height`);
    if (short && ar) {
      const mn = Math.min(ar[0], ar[1]), mx = Math.max(ar[0], ar[1]);
      let long = Math.round((short * mx) / mn); if (long % 2) long += 1;
      r.width = ar[0] >= ar[1] ? long : short; r.height = ar[0] >= ar[1] ? short : long;
      r.resolution = String(res).toLowerCase(); r.aspect = asp;
    }
  }
  r.no_upscale = o.no_upscale === undefined ? true : !!o.no_upscale;
  if (o.no_upscale === undefined) used('no_upscale', true);

  // --- fps ---
  if (o.fps === undefined) { r.fps = 30; used('fps', 30); }
  else if (typeof o.fps !== 'number' || !(o.fps >= 1 && o.fps <= 120)) errors.push(`${p}.fps must be a number 1-120`);
  else r.fps = o.fps;

  // --- codec / container ---
  let codec = o.codec === undefined ? 'h264' : String(o.codec).toLowerCase();
  if (o.codec === undefined) used('codec', 'h264');
  if (codec === 'hevc') codec = 'h265';
  let cont = o.container === undefined ? (codec === 'vp9' ? 'webm' : 'mp4') : String(o.container).toLowerCase();
  if (o.container === undefined) used('container', cont);
  if (!CODECS[codec]) errors.push(`${p}.codec must be one of h264, h265, vp9`);
  else if (!CONTAINERS[cont]) errors.push(`${p}.container must be one of ${Object.keys(CONTAINERS).join(', ')}`);
  else if (!CONTAINERS[cont].includes(codec)) errors.push(`${p}: codec ${codec} cannot go in ${cont}; not auto-changed`);
  r.codec = codec; r.container = cont; r.ffmpeg_vcodec = CODECS[codec];

  // --- quality / bitrate ---
  const q = o.quality === undefined ? 'balanced' : o.quality;
  if (o.quality === undefined) used('quality', 'balanced');
  if (!['compressed', 'balanced', 'high'].includes(q)) errors.push(`${p}.quality must be compressed|balanced|high`);
  r.quality = q;
  if (o.video_bitrate !== undefined) {
    if (typeof o.video_bitrate !== 'string' || !/^\d{1,6}[kKmM]$/.test(o.video_bitrate)) errors.push(`${p}.video_bitrate like "4000k" or "8M"`);
    else r.video_bitrate = o.video_bitrate;
  }
  if (o.crf !== undefined) {
    if (!Number.isInteger(o.crf) || o.crf < 0 || o.crf > 51) errors.push(`${p}.crf must be integer 0-51`); else r.crf = o.crf;
  } else if (!r.video_bitrate && QUALITY_CRF[codec] && QUALITY_CRF[codec][q] !== undefined) r.crf = QUALITY_CRF[codec][q];
  const preset = o.preset === undefined ? 'veryfast' : o.preset;
  if (o.preset === undefined) used('preset', 'veryfast');
  if (!['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].includes(preset)) errors.push(`${p}.preset invalid`);
  r.preset = preset;
  r.hardware_encode = o.hardware_encode === undefined ? 'auto' : o.hardware_encode;
  if (o.hardware_encode === undefined) used('hardware_encode', 'auto');
  if (!['auto', 'never', 'always'].includes(r.hardware_encode)) errors.push(`${p}.hardware_encode must be auto|never|always`);

  // --- audio ---
  const a = o.audio === undefined ? {} : o.audio;
  if (typeof a !== 'object' || Array.isArray(a) || a === null) { errors.push(`${p}.audio must be an object`); return r; }
  const ac = a.codec === undefined ? (cont === 'webm' ? 'opus' : 'aac') : a.codec;
  if (a.codec === undefined) used('audio.codec', ac);
  if (!AUDIO_CODECS[ac]) errors.push(`${p}.audio.codec must be aac|mp3|opus`);
  else if (!AUDIO_CODECS[ac].includes(cont)) errors.push(`${p}: audio ${ac} not valid in ${cont}; not auto-changed`);
  const ab = a.bitrate === undefined ? '192k' : a.bitrate;
  if (a.bitrate === undefined) used('audio.bitrate', ab);
  if (typeof ab !== 'string' || !/^\d{2,4}k$/i.test(ab)) errors.push(`${p}.audio.bitrate like "192k"`);
  const sr = a.sample_rate === undefined ? 48000 : a.sample_rate;
  if (![22050, 32000, 44100, 48000].includes(sr)) errors.push(`${p}.audio.sample_rate must be 22050|32000|44100|48000`);
  const ch = a.channels === undefined ? 2 : a.channels;
  if (![1, 2].includes(ch)) errors.push(`${p}.audio.channels must be 1 or 2`);
  const lufs = a.loudness_lufs === undefined ? -14 : a.loudness_lufs;
  if (a.loudness_lufs === undefined) used('audio.loudness_lufs', -14);
  if (typeof lufs !== 'number' || lufs > -5 || lufs < -40) errors.push(`${p}.audio.loudness_lufs must be -40..-5`);
  r.audio = { codec: ac, bitrate: ab, sample_rate: sr, channels: ch, normalize: a.normalize === undefined ? true : !!a.normalize, loudness_lufs: lufs };

  // --- subtitles ---
  const s = o.subtitles === undefined ? {} : o.subtitles;
  if (typeof s !== 'object' || Array.isArray(s) || s === null) { errors.push(`${p}.subtitles must be an object`); return r; }
  const mode = s.mode === undefined ? 'none' : s.mode;
  if (s.mode === undefined) used('subtitles.mode', 'none');
  if (!['none', 'burn', 'srt', 'both'].includes(mode)) errors.push(`${p}.subtitles.mode must be none|burn|srt|both`);
  const langs = s.languages === undefined ? ['en'] : s.languages;
  if (!Array.isArray(langs) || !langs.length || langs.length > 10 || !langs.every(l => typeof l === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l))) errors.push(`${p}.subtitles.languages must be 1-10 language codes like "en", "fr", "pt-BR"`);
  r.subtitles = { mode, languages: langs, style: (s.style && typeof s.style === 'object' && !Array.isArray(s.style)) ? s.style : {}, burn_language: s.burn_language };
  return r;
}

function normalizeJob(body, ctx) {
  const errors = [], warnings = [], defaults = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body must be a JSON object'], warnings, defaults_applied: defaults };
  const kind = body.kind === undefined ? 'render' : body.kind;
  if (!['render', 'probe', 'transcribe'].includes(kind)) errors.push('kind must be render|probe|transcribe');
  let instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (kind === 'render' && !instruction) errors.push('instruction (the plain-English request) is required');
  if (instruction.length > 20000) errors.push('instruction: maximum 20000 characters');
  if (!instruction) instruction = kind;
  const assets = normalizeAssets(body.assets, errors, warnings);
  if (kind !== 'render' && !assets.length) errors.push(`${kind} jobs need at least one asset`);
  if (kind === 'transcribe') {
    if (assets.length !== 1 || !['audio', 'video'].includes(assets[0].type)) errors.push('transcribe jobs need exactly one audio/video asset');
    if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(body.language || '')) errors.push('transcribe jobs need language like "en"');
  }
  let outputs = [];
  if (kind === 'render') {
    let rawOuts;
    if (body.outputs !== undefined && body.output !== undefined) errors.push('Provide either output or outputs, not both');
    if (body.outputs !== undefined) rawOuts = body.outputs;
    else if (body.output !== undefined) rawOuts = [body.output];
    else { rawOuts = [{}]; defaults.push('output=all defaults (1080p 16:9 30fps h264 mp4)'); }
    if (!Array.isArray(rawOuts) || !rawOuts.length || rawOuts.length > 6) errors.push('outputs must be an array of 1-6 objects');
    else {
      outputs = rawOuts.map((o, i) => normalizeOutput(o, i, errors, defaults));
      const labels = outputs.filter(Boolean).map(o => o.label);
      if (new Set(labels).size !== labels.length) errors.push('output labels must be unique');
    }
  }
  const priority = body.priority === undefined ? 5 : body.priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) errors.push('priority must be an integer 0-9');
  if (body.callback_url !== undefined && !(typeof body.callback_url === 'string' && /^https?:\/\/[^\s]+$/i.test(body.callback_url))) errors.push('callback_url must be an http(s) URL');
  if (body.delivery !== undefined && !(body.delivery && typeof body.delivery.upload_url === 'string' && /^https?:\/\/[^\s]+$/i.test(body.delivery.upload_url))) errors.push('delivery must be {upload_url: http(s) URL}');
  if (body.idempotency_key !== undefined && !(typeof body.idempotency_key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.idempotency_key))) errors.push('idempotency_key must match [A-Za-z0-9_.:-]{1,128}');
  if (body.max_attempts !== undefined && !(Number.isInteger(body.max_attempts) && body.max_attempts >= 1 && body.max_attempts <= 10)) errors.push('max_attempts must be an integer 1-10');
  const title = typeof body.title === 'string' ? body.title : '';
  if (errors.length) return { ok: false, errors, warnings, defaults_applied: defaults };

  const now = ctx.now;
  const slug = (title || instruction).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
  return {
    ok: true, errors: [], warnings, defaults_applied: defaults,
    job: {
      job_id: ctx.id, kind, instruction, title: title.slice(0, 120), title_slug: slug, language: body.language,
      assets, outputs, priority, max_attempts: body.max_attempts || 3,
      callback_url: body.callback_url, delivery: body.delivery, idempotency_key: body.idempotency_key,
      plan: null, result: null, error: null, created_at: now, history: [],
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { normalizeJob };
