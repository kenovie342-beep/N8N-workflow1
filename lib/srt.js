'use strict';
const pad = (n, w) => String(n).padStart(w, '0');
function ts(sec) {
  const ms = Math.round(sec * 1000);
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor(ms / 60000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}
function cuesToSrt(cues) { return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text.trim()}\n`).join('\n'); }
function tsParse(s) { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0').slice(0, 3)) / 1000 : NaN; }
function parseSrt(text) {
  const out = [];
  text.replace(/\r/g, '').split(/\n\n+/).forEach(b => {
    const l = b.trim().split('\n'); const i = l.findIndex(x => x.includes('-->'));
    if (i < 0) return;
    const [a, c] = l[i].split('-->'); const start = tsParse(a), end = tsParse(c);
    const t = l.slice(i + 1).join('\n').trim();
    if (!isNaN(start) && !isNaN(end) && t) out.push({ start, end, text: t });
  });
  return out;
}
// Subtitle sync check: returns list of problems
function checkCues(cues, totalDuration) {
  const p = []; let prev = 0;
  cues.forEach((c, i) => {
    if (c.end <= c.start) p.push(`cue ${i + 1}: end<=start`);
    if (c.start < prev - 0.001) p.push(`cue ${i + 1}: overlaps previous`);
    if (totalDuration && c.start > totalDuration + 0.5) p.push(`cue ${i + 1}: starts after video end`);
    prev = c.end;
  });
  if (totalDuration && cues.length && cues[cues.length - 1].end > totalDuration + 1) p.push('last cue ends >1s after video end');
  return p;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { cuesToSrt, parseSrt, checkCues };
