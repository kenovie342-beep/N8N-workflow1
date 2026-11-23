'use strict';
// Builds FFmpeg argument arrays (never shell strings) from a resolved timeline.
// Pure: no I/O. The worker writes the returned textFiles and runs the args.

const ev = n => Math.max(2, Math.round(n / 2) * 2);
const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
const hex = c => '0x' + c.replace('#', '');
const num = n => String(Math.round(n * 1000) / 1000);

function anchorExpr(anchor, m) {
  const a = anchor || 'center';
  const x = a.includes('left') ? `${m}` : a.includes('right') ? `main_w-overlay_w-${m}` : '(main_w-overlay_w)/2';
  const y = a.startsWith('top') ? `${m}` : a.startsWith('bottom') ? `main_h-overlay_h-${m}` : '(main_h-overlay_h)/2';
  return { x, y };
}
function textAnchor(anchor, m) {
  const a = anchor || 'bottom';
  const x = a.includes('left') ? `${m}` : a.includes('right') ? `w-text_w-${m}` : '(w-text_w)/2';
  const y = a.startsWith('top') ? `${m}` : a.startsWith('bottom') ? `h-text_h-${m}` : '(h-text_h)/2';
  return { x, y };
}

// ---- encoder selection -------------------------------------------------
function hwBitrateKbps(w, h, fps, quality) {
  const f = { compressed: 0.07, balanced: 0.11, high: 0.18 }[quality] || 0.11;
  return Math.max(500, Math.round((w * h * fps * f) / 1000));
}
// caps: { encoders:Set, hwWorks:boolean }
function videoEncodeArgs(out, caps, opts = {}) {
  const args = [];
  const wantHw = out.hardware_encode !== 'never' && out.codec === 'h264' && caps && caps.hwWorks && caps.encoders.has('h264_mediacodec');
  if (out.hardware_encode === 'always' && !wantHw) throw new Error('hardware_encode=always but no working h264_mediacodec encoder on this device/ffmpeg build');
  let used = 'software';
  if (wantHw) {
    used = 'h264_mediacodec';
    const b = out.video_bitrate || `${hwBitrateKbps(out.width, out.height, out.fps, out.quality)}k`;
    args.push('-c:v', 'h264_mediacodec', '-b:v', b);
  } else if (out.codec === 'h264') {
    args.push('-c:v', 'libx264', '-preset', out.preset, '-profile:v', 'high');
    if (out.video_bitrate) args.push('-b:v', out.video_bitrate); else args.push('-crf', String(out.crf));
  } else if (out.codec === 'h265') {
    args.push('-c:v', 'libx265', '-preset', out.preset, '-tag:v', 'hvc1');
    if (out.video_bitrate) args.push('-b:v', out.video_bitrate); else args.push('-crf', String(out.crf));
  } else if (out.codec === 'vp9') {
    const cpu = { ultrafast: 8, superfast: 7, veryfast: 6, faster: 5, fast: 4, medium: 3, slow: 2 }[out.preset] || 5;
    args.push('-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', String(cpu));
    if (out.video_bitrate) args.push('-b:v', out.video_bitrate); else args.push('-crf', String(out.crf), '-b:v', '0');
  }
  args.push('-pix_fmt', 'yuv420p', '-r', num(out.fps));
  if (opts.threads) args.push('-threads', String(opts.threads));
  return { args, used };
}
function audioEncodeArgs(out) {
  const a = out.audio;
  const c = { aac: 'aac', mp3: 'libmp3lame', opus: 'libopus' }[a.codec];
  return ['-c:a', c, '-b:a', a.bitrate, '-ar', String(a.sample_rate), '-ac', String(a.channels)];
}

// ---- one scene -> one silent video segment ---------------------------------
// ctx: { scene, out, assets:{id:{path,type}}, enc:{args}, segPath, textDir, fontFile }
function buildSegmentArgs(ctx) {
  const { scene, out, assets, segPath, textDir, fontFile } = ctx;
  const W = out.width, H = out.height, fps = out.fps, dur = scene.duration;
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  const bg = hex(scene.background || '#000000');
  args.push('-f', 'lavfi', '-t', num(dur), '-i', `color=c=${bg}:s=${W}x${H}:r=${num(fps)}`);
  const filters = []; const textFiles = [];
  let cur = '[0:v]'; let k = 1; let n = 0;
  scene.layers.forEach((l, j) => {
    const start = l.start || 0;
    const end = Math.min(l.end === undefined ? dur : l.end, dur);
    const en = `enable='between(t,${num(start)},${num(end)})'`;
    if (l.type === 'text') {
      const file = `${textDir}/${scene.id}_t${j}.txt`;
      textFiles.push({ path: file, content: l.text });
      const m = Math.round((l.margin === undefined ? 0.04 : l.margin) * W);
      const pos = textAnchor(l.anchor, m);
      const px = l.rect ? { x: `${Math.round(l.rect.x * W)}`, y: `${Math.round(l.rect.y * H)}` } : pos;
      const box = l.box === undefined ? { color: '#000000', opacity: 0.5, padding: 12 } : l.box;
      filters.push(`${cur}drawtext=fontfile=${q(fontFile)}:textfile=${q(file)}:expansion=none:fontsize=${Math.round((l.font_size || 0.05) * H)}:fontcolor=${hex(l.color || '#FFFFFF')}` +
        (box ? `:box=1:boxcolor=${hex(box.color || '#000000')}@${box.opacity === undefined ? 0.5 : box.opacity}:boxborderw=${box.padding === undefined ? 12 : box.padding}` : '') +
        `:x=${px.x}:y=${px.y}:${en}[T${n}]`);
      cur = `[T${n}]`; n++; return;
    }
    const a = assets[l.asset];
    const isImg = l.type === 'image' || a.type === 'image';
    const span = Math.max(0.1, dur - start);
    const speed = (!isImg && l.speed) || 1;
    if (isImg) args.push('-loop', '1', '-framerate', num(fps), '-t', num(span), '-i', a.path);
    else {
      if (l.loop) args.push('-stream_loop', '-1');
      const ts = (l.trim && l.trim.start) || 0;
      if (ts > 0) args.push('-ss', num(ts));
      let read = span * speed;
      if (l.trim && l.trim.end !== undefined && !l.loop) read = Math.min(read, (l.trim.end - ts));
      args.push('-t', num(read), '-i', a.path);
    }
    // geometry
    let bw, bh, scale, pos;
    if (l.anchor && l.size) {
      bw = ev(l.size * W); scale = `scale=${bw}:-2`;
      pos = anchorExpr(l.anchor, Math.round((l.margin === undefined ? 0.03 : l.margin) * W));
    } else {
      const r = l.rect || { x: 0, y: 0, w: 1, h: 1 };
      bw = ev(r.w * W); bh = ev(r.h * H);
      const fit = l.fit || (isImg ? 'contain' : 'cover');
      scale = fit === 'cover' ? `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh}` : `scale=${bw}:${bh}:force_original_aspect_ratio=decrease`;
      const X = Math.round(r.x * W), Y = Math.round(r.y * H);
      pos = { x: `${X}+(${bw}-overlay_w)/2`, y: `${Y}+(${bh}-overlay_h)/2` };
    }
    const f = [];
    f.push(speed !== 1 ? `setpts=(PTS-STARTPTS)/${num(speed)}` : 'setpts=PTS-STARTPTS');
    f.push(`fps=${num(fps)}`, scale, 'setsar=1');
    if (l.border) f.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${hex(l.border.color)}:t=${l.border.width}`);
    if (l.opacity !== undefined && l.opacity < 1) f.push('format=yuva420p', `colorchannelmixer=aa=${num(l.opacity)}`);
    if (start > 0) f.push(`setpts=PTS+${num(start)}/TB`);
    filters.push(`[${k}:v]${f.join(',')}[L${k}]`);
    filters.push(`${cur}[L${k}]overlay=x=${pos.x}:y=${pos.y}:eof_action=pass:format=auto:${en}[O${k}]`);
    cur = `[O${k}]`; k++;
  });
  filters.push(`${cur}format=yuv420p,setsar=1[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-an', ...ctx.enc.args, '-t', num(dur));
  if (/\.(mp4|mov)$/.test(segPath)) args.push('-movflags', '+faststart');
  args.push(segPath);
  return { args, textFiles };
}

// ---- audio graph --------------------------------------------------------------
// returns { inputs:[...ffmpeg args], filters:[...], label|null, inputCount }
function buildAudio(plan, out, assets, total, firstIndex) {
  const A = plan.audio || {}; const inputs = []; const f = []; let i = firstIndex; const mix = [];
  const sr = out.audio.sample_rate, lay = out.audio.channels === 1 ? 'mono' : 'stereo';
  const fmt = `aformat=sample_rates=${sr}:channel_layouts=${lay}`;
  let narLabel = null;
  if (A.narration) {
    const n = A.narration; const a = assets[n.asset];
    if (n.trim && n.trim.start) inputs.push('-ss', num(n.trim.start));
    if (n.trim && n.trim.end !== undefined) inputs.push('-t', num(n.trim.end - (n.trim.start || 0)));
    inputs.push('-i', a.path);
    const d = Math.round((n.start || 0) * 1000);
    f.push(`[${i}:a]${fmt},volume=${num(n.volume === undefined ? 1 : n.volume)}${d ? `,adelay=${d}:all=1` : ''}[nar]`);
    narLabel = 'nar'; i++;
  }
  if (A.music) {
    const m = A.music; const a = assets[m.asset];
    inputs.push('-stream_loop', '-1', '-i', a.path);
    const fi = m.fade_in || 0, fo = m.fade_out === undefined ? 2 : m.fade_out;
    let chain = `[${i}:a]${fmt},atrim=0:${num(total)},asetpts=PTS-STARTPTS,volume=${num(m.volume === undefined ? 0.15 : m.volume)}`;
    if (fi) chain += `,afade=t=in:d=${num(fi)}`;
    if (fo) chain += `,afade=t=out:st=${num(Math.max(0, total - fo))}:d=${num(fo)}`;
    if (m.duck !== false && narLabel) {
      f.push(`[nar]asplit=2[nar_mix][nar_sc]`);
      f.push(`${chain}[mus_raw]`);
      f.push(`[mus_raw][nar_sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[mus]`);
      narLabel = 'nar_mix';
    } else f.push(`${chain}[mus]`);
    mix.push('mus'); i++;
  }
  if (narLabel) mix.unshift(narLabel);
  (A.sfx || []).forEach((s, j) => {
    const a = assets[s.asset]; inputs.push('-i', a.path);
    f.push(`[${i}:a]${fmt},volume=${num(s.volume === undefined ? 1 : s.volume)},adelay=${Math.round(s.at * 1000)}:all=1[sfx${j}]`);
    mix.push(`sfx${j}`); i++;
  });
  if (!mix.length) return { inputs, filters: [], label: null, inputCount: 0 };
  let tail = mix.length === 1 ? `[${mix[0]}]anull` : `${mix.map(x => `[${x}]`).join('')}amix=inputs=${mix.length}:duration=longest:normalize=0`;
  tail += `,apad=whole_dur=${num(total)},atrim=0:${num(total)}`;
  if (out.audio.normalize) tail += `,loudnorm=I=${out.audio.loudness_lufs}:TP=-1.5:LRA=11`;
  tail += `,aresample=${sr}`;
  f.push(`${tail}[aout]`);
  return { inputs, filters: f, label: 'aout', inputCount: i - firstIndex };
}

// ---- final assembly ------------------------------------------------------------
// ctx: { timeline:{scenes,total_duration}, plan, out, assets, segPaths:[], enc, aenc, outPath, listPath,
//        burn:{srtPath, style}|null, watermark:{path,...}|null, caps }
function buildFinalArgs(ctx) {
  const { timeline, plan, out, assets, segPaths, outPath } = ctx;
  const total = timeline.total_duration;
  const hasTrans = timeline.scenes.some(s => s.transition_in);
  const needReencode = hasTrans || !!ctx.burn || !!ctx.watermark;
  const copyMode = !needReencode;
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  let vIdx = 0; const filters = []; let vLabel;
  if (copyMode) {
    args.push('-f', 'concat', '-safe', '0', '-i', ctx.listPath); vIdx = 1; vLabel = '0:v';
  } else {
    segPaths.forEach(p => args.push('-i', p));
    vIdx = segPaths.length;
    let acc = '[0:v]';
    timeline.scenes.forEach((s, i) => {
      if (i === 0) return;
      const lab = `[c${i}]`;
      if (s.transition_in) filters.push(`${acc}[${i}:v]xfade=transition=${s.transition_in.type}:duration=${num(s.transition_in.duration)}:offset=${num(s.timeline_start)}${lab}`);
      else filters.push(`${acc}[${i}:v]concat=n=2:v=1:a=0${lab}`);
      acc = lab;
    });
    let v = acc;
    if (ctx.watermark) {
      const w = ctx.watermark; args.push('-loop', '1', '-t', num(total), '-i', w.path);
      const wi = vIdx++; const bw = ev((w.size || 0.12) * out.width);
      const pos = anchorExpr(w.anchor || 'top-right', Math.round((w.margin === undefined ? 0.03 : w.margin) * out.width));
      filters.push(`[${wi}:v]scale=${bw}:-2,format=rgba${w.opacity !== undefined ? `,colorchannelmixer=aa=${num(w.opacity)}` : ''}[wm]`);
      filters.push(`${v}[wm]overlay=x=${pos.x}:y=${pos.y}:format=auto[vw]`); v = '[vw]';
    }
    if (ctx.burn) {
      filters.push(`${v}subtitles=filename=${q(ctx.burn.srtPath)}${ctx.burn.fontsDir ? `:fontsdir=${q(ctx.burn.fontsDir)}` : ''}:force_style=${q(ctx.burn.style)}[vs]`); v = '[vs]';
    }
    filters.push(`${v}format=yuv420p[vfinal]`); vLabel = '[vfinal]';
  }
  const au = buildAudio(plan, out, assets, total, vIdx);
  args.push(...au.inputs); filters.push(...au.filters);
  if (filters.length) args.push('-filter_complex', filters.join(';'));
  args.push('-map', copyMode ? '0:v' : vLabel);
  if (au.label) args.push('-map', `[${au.label}]`, ...ctx.aenc); else args.push('-an');
  if (copyMode) args.push('-c:v', 'copy'); else args.push(...ctx.enc.args);
  args.push('-t', num(total));
  if (/\.(mp4|mov)$/.test(outPath)) args.push('-movflags', '+faststart');
  args.push(outPath);
  return { args, copyMode, total };
}

function subtitleStyle(style, out) {
  const s = style || {};
  const size = Math.round((s.font_size || 0.045) * out.height * 0.75);
  const hexBGR = c => { const h = (c || '#FFFFFF').replace('#', ''); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
  const parts = [`FontSize=${size}`, `PrimaryColour=${hexBGR(s.color)}`, `OutlineColour=${hexBGR(s.outline_color || '#000000')}`, `Outline=${s.outline === undefined ? 2 : s.outline}`, `Alignment=${s.position === 'top' ? 6 : s.position === 'middle' ? 10 : 2}`, `MarginV=${Math.round((s.margin_v === undefined ? 0.06 : s.margin_v) * out.height)}`];
  if (s.font) parts.push(`FontName=${s.font}`);
  if (s.bold) parts.push('Bold=1');
  return parts.join(',');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildSegmentArgs, buildFinalArgs, videoEncodeArgs, audioEncodeArgs, subtitleStyle, hwBitrateKbps };
