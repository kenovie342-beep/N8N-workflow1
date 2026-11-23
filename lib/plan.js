'use strict';
// Editing-plan schema, validation and timeline resolution.
// Pure functions shared by: n8n Code nodes, the MCP server and the Android worker.

const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const TRANSITIONS = ['fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose', 'pixelize', 'radial', 'smoothleft', 'smoothright'];
const LIMITS = { scenes: 200, layers: 8, sfx: 100, cues: 5000 };

const isNum = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);

function validatePlan(plan, assets, outputs) {
  const errors = [], warnings = [];
  const E = m => errors.push(m);
  if (!isObj(plan)) return { ok: false, errors: ['plan must be an object'], warnings };
  if (plan.version !== 1) E('plan.version must be 1');
  const byId = {};
  (assets || []).forEach(a => { byId[a.id] = a; });
  const needAsset = (id, p, types) => {
    if (typeof id !== 'string' || !byId[id]) { E(`${p}: asset "${id}" is not in the job's assets`); return null; }
    if (types && !types.includes(byId[id].type)) E(`${p}: asset "${id}" is type ${byId[id].type}, expected ${types.join('/')}`);
    return byId[id];
  };
  const checkTrim = (t, p) => {
    if (t === undefined) return;
    if (!isObj(t) || !isNum(t.start === undefined ? 0 : t.start, 0, 86400) || (t.end !== undefined && !isNum(t.end, 0, 86400))) { E(`${p}.trim must be {start>=0,end?}`); return; }
    if (t.end !== undefined && t.end <= (t.start || 0)) E(`${p}.trim.end must be > start`);
  };
  const checkRect = (l, p) => {
    if (l.rect !== undefined) {
      const r = l.rect;
      if (!isObj(r) || !['x', 'y', 'w', 'h'].every(k => isNum(r[k], 0, 1)) || r.w <= 0 || r.h <= 0 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001) E(`${p}.rect needs x,y,w,h as fractions of the canvas inside 0..1`);
    }
    if (l.anchor !== undefined && !ANCHORS.includes(l.anchor)) E(`${p}.anchor must be one of ${ANCHORS.join(', ')}`);
    if (l.size !== undefined && !isNum(l.size, 0.02, 1)) E(`${p}.size must be 0.02-1 (fraction of canvas width)`);
    if (l.margin !== undefined && !isNum(l.margin, 0, 0.3)) E(`${p}.margin must be 0-0.3`);
    if (l.opacity !== undefined && !isNum(l.opacity, 0, 1)) E(`${p}.opacity must be 0-1`);
  };

  if (!Array.isArray(plan.scenes) || !plan.scenes.length) E('plan.scenes must be a non-empty array');
  else {
    if (plan.scenes.length > LIMITS.scenes) E(`max ${LIMITS.scenes} scenes`);
    const ids = new Set();
    plan.scenes.forEach((s, i) => {
      const p = `scenes[${i}]`;
      if (!isObj(s)) { E(`${p} must be an object`); return; }
      if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(s.id)) E(`${p}.id must match [A-Za-z0-9_-]{1,40}`);
      else if (ids.has(s.id)) E(`${p}.id "${s.id}" duplicated`); else ids.add(s.id);
      if (s.duration !== undefined && !isNum(s.duration, 0.1, 7200)) E(`${p}.duration must be 0.1-7200 seconds`);
      if (s.background !== undefined && !/^#[0-9a-fA-F]{6}$/.test(s.background)) E(`${p}.background must be #RRGGBB`);
      if (s.transition_in !== undefined) {
        const t = s.transition_in;
        if (i === 0) E(`${p}.transition_in is not allowed on the first scene`);
        if (!isObj(t) || !TRANSITIONS.includes(t.type) || !isNum(t.duration, 0.1, 5)) E(`${p}.transition_in needs type (${TRANSITIONS.join('|')}) and duration 0.1-5`);
      }
      if (!Array.isArray(s.layers) || !s.layers.length) { E(`${p}.layers must be a non-empty array`); return; }
      if (s.layers.length > LIMITS.layers) E(`${p}: max ${LIMITS.layers} layers`);
      let hasBase = false;
      s.layers.forEach((l, j) => {
        const q = `${p}.layers[${j}]`;
        if (!isObj(l)) { E(`${q} must be an object`); return; }
        if (!['video', 'image', 'text'].includes(l.type)) { E(`${q}.type must be video|image|text`); return; }
        if (l.start !== undefined && !isNum(l.start, 0, 7200)) E(`${q}.start must be >=0`);
        if (l.end !== undefined && !isNum(l.end, 0, 7200)) E(`${q}.end must be >=0`);
        if (l.start !== undefined && l.end !== undefined && l.end <= l.start) E(`${q}.end must be > start`);
        checkRect(l, q);
        if (l.type === 'text') {
          if (typeof l.text !== 'string' || !l.text.length || l.text.length > 500) E(`${q}.text must be 1-500 chars`);
          if (l.font_size !== undefined && !isNum(l.font_size, 0.015, 0.25)) E(`${q}.font_size must be 0.015-0.25 (fraction of height)`);
          if (l.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(l.color)) E(`${q}.color must be #RRGGBB`);
          return;
        }
        if (j === 0) hasBase = true;
        const a = needAsset(l.asset, q, l.type === 'video' ? ['video', 'image'] : ['image']);
        if (l.type === 'video') {
          checkTrim(l.trim, q);
          if (l.speed !== undefined && !isNum(l.speed, 0.25, 4)) E(`${q}.speed must be 0.25-4`);
        }
        if (l.fit !== undefined && !['cover', 'contain'].includes(l.fit)) E(`${q}.fit must be cover|contain`);
        if (l.border !== undefined && !(isObj(l.border) && isNum(l.border.width, 1, 40) && /^#[0-9a-fA-F]{6}$/.test(l.border.color || ''))) E(`${q}.border needs width 1-40 and color #RRGGBB`);
        if (a && a.type === 'image' && s.duration === undefined && l.end === undefined && !s.layers.some(x => x.type === 'video')) E(`${q}: image-only scenes need scene.duration (or layer end)`);
      });
      if (!hasBase && s.layers.every(l => l.type === 'text') && s.duration === undefined) E(`${p}: text-only scenes need duration`);
    });
  }

  const a = plan.audio;
  if (a !== undefined) {
    if (!isObj(a)) E('plan.audio must be an object'); else {
      if (a.narration !== undefined) {
        if (!isObj(a.narration)) E('audio.narration must be an object'); else {
          needAsset(a.narration.asset, 'audio.narration', ['audio', 'video']);
          if (a.narration.start !== undefined && !isNum(a.narration.start, 0, 7200)) E('audio.narration.start must be >=0');
          if (a.narration.volume !== undefined && !isNum(a.narration.volume, 0, 4)) E('audio.narration.volume must be 0-4');
          checkTrim(a.narration.trim, 'audio.narration');
        }
      }
      if (a.music !== undefined) {
        if (!isObj(a.music)) E('audio.music must be an object'); else {
          needAsset(a.music.asset, 'audio.music', ['audio', 'video']);
          if (a.music.volume !== undefined && !isNum(a.music.volume, 0, 2)) E('audio.music.volume must be 0-2');
          if (a.music.fade_in !== undefined && !isNum(a.music.fade_in, 0, 30)) E('audio.music.fade_in must be 0-30');
          if (a.music.fade_out !== undefined && !isNum(a.music.fade_out, 0, 30)) E('audio.music.fade_out must be 0-30');
          if (a.music.duck !== undefined && typeof a.music.duck !== 'boolean') E('audio.music.duck must be boolean');
        }
      }
      if (a.sfx !== undefined) {
        if (!Array.isArray(a.sfx) || a.sfx.length > LIMITS.sfx) E(`audio.sfx must be an array (max ${LIMITS.sfx})`);
        else a.sfx.forEach((x, i) => {
          if (!isObj(x)) { E(`audio.sfx[${i}] must be an object`); return; }
          needAsset(x.asset, `audio.sfx[${i}]`, ['audio']);
          if (!isNum(x.at, 0, 86400)) E(`audio.sfx[${i}].at must be seconds >=0`);
          if (x.volume !== undefined && !isNum(x.volume, 0, 4)) E(`audio.sfx[${i}].volume must be 0-4`);
        });
      }
      if (a.source_audio !== undefined && a.source_audio !== 'remove') E('audio.source_audio: only "remove" is supported (presenter audio is always removed)');
    }
  }

  const c = plan.captions;
  const haveLangs = new Set();
  if (c !== undefined) {
    if (!isObj(c)) E('plan.captions must be an object'); else {
      if (c.cues !== undefined) {
        if (!isObj(c.cues)) E('captions.cues must be {lang:[{start,end,text}]}');
        else Object.keys(c.cues).forEach(lang => {
          if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) { E(`captions.cues: bad language code "${lang}"`); return; }
          const arr = c.cues[lang];
          if (!Array.isArray(arr) || !arr.length || arr.length > LIMITS.cues) { E(`captions.cues.${lang} must be 1-${LIMITS.cues} cues`); return; }
          let prevEnd = 0, bad = 0;
          arr.forEach((q, i) => {
            if (!isObj(q) || !isNum(q.start, 0, 86400) || !isNum(q.end, 0, 86400) || q.end <= q.start || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 500) { if (bad++ < 3) E(`captions.cues.${lang}[${i}] needs start<end and text 1-500 chars`); return; }
            if (q.start < prevEnd - 0.001 && bad++ < 3) E(`captions.cues.${lang}[${i}] overlaps/out of order (subtitle sync problem)`);
            prevEnd = q.end;
          });
          haveLangs.add(lang);
        });
      }
      if (c.srt_assets !== undefined) {
        if (!isObj(c.srt_assets)) E('captions.srt_assets must be {lang: assetId}');
        else Object.keys(c.srt_assets).forEach(lang => { needAsset(c.srt_assets[lang], `captions.srt_assets.${lang}`, ['subtitle']); haveLangs.add(lang); });
      }
      if (c.transcribe !== undefined) {
        if (!isObj(c.transcribe) || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(c.transcribe.language || '')) E('captions.transcribe needs {asset, language}');
        else { needAsset(c.transcribe.asset, 'captions.transcribe', ['audio', 'video']); haveLangs.add(c.transcribe.language); }
      }
    }
  }
  if (plan.watermark !== undefined) {
    if (!isObj(plan.watermark)) E('plan.watermark must be an object'); else { needAsset(plan.watermark.asset, 'watermark', ['image']); checkRect(plan.watermark, 'watermark'); }
  }
  (outputs || []).forEach((o, i) => {
    const s = o.subtitles || { mode: 'none' };
    if (s.mode && s.mode !== 'none') {
      (s.languages || []).forEach(l => { if (!haveLangs.has(l)) E(`outputs[${i}] wants ${l} subtitles but the plan has no caption track for "${l}" (supply cues, an srt asset or captions.transcribe; translations must be supplied as cues)`); });
      if (s.mode === 'burn' || s.mode === 'both') {
        const bl = s.burn_language || (s.languages || [])[0];
        if (bl && !(s.languages || []).includes(bl)) E(`outputs[${i}].subtitles.burn_language "${bl}" not in languages`);
      }
    }
  });
  if (!plan.audio || (!plan.audio.narration && !plan.audio.music && !(plan.audio.sfx || []).length)) warnings.push('Plan has no audio: output will be silent.');
  return { ok: errors.length === 0, errors, warnings };
}

// probes: { assetId: { ok, duration, width, height, has_video, has_audio, ... } }
function resolveTimeline(plan, probes) {
  const errors = [];
  const scenes = [];
  plan.scenes.forEach((s, i) => {
    let dur = s.duration;
    if (dur === undefined) {
      let m = 0;
      s.layers.forEach((l, j) => {
        let d = null;
        if (l.type === 'video') {
          const pr = probes[l.asset];
          if (!pr || !pr.ok || !pr.duration) { errors.push(`scenes[${i}].layers[${j}]: no probed duration for "${l.asset}"`); return; }
          const ts = (l.trim && l.trim.start) || 0, te = (l.trim && l.trim.end) || pr.duration;
          d = (te - ts) / (l.speed || 1);
        } else if (l.end !== undefined) d = l.end;
        if (d !== null && (l.start || 0) + d > m) m = (l.start || 0) + d;
      });
      dur = m;
    }
    if (!(dur > 0)) errors.push(`scenes[${i}]: cannot determine duration`);
    scenes.push({ ...s, duration: Math.round(dur * 1000) / 1000 });
  });
  scenes.forEach((s, i) => {
    if (s.transition_in) {
      const prev = scenes[i - 1];
      const lim = Math.min(prev.duration, s.duration) / 2;
      if (s.transition_in.duration > lim + 1e-6) errors.push(`scenes[${i}].transition_in.duration ${s.transition_in.duration}s exceeds half of the shorter adjacent scene (${lim.toFixed(2)}s)`);
    }
  });
  let t = 0;
  scenes.forEach((s, i) => { s.timeline_start = i === 0 ? 0 : t - (s.transition_in ? s.transition_in.duration : 0); t = s.timeline_start + s.duration; });
  return { ok: errors.length === 0, errors, scenes, total_duration: Math.round(t * 1000) / 1000 };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { validatePlan, resolveTimeline, ANCHORS, TRANSITIONS };
