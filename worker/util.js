'use strict';
const { spawn } = require('child_process'), fs = require('fs'), crypto = require('crypto');

function run(cmd, args, o = {}) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (o.onSpawn) o.onSpawn(p);
    let out = '', err = '', buf = '';
    p.stdout.on('data', d => { const s = d.toString(); if (o.onLine) { buf += s; let i; while ((i = buf.indexOf('\n')) >= 0) { o.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } } else if (out.length < 2e6) out += s; });
    p.stderr.on('data', d => { if (err.length < 64000) err += d.toString(); });
    p.on('error', e => resolve({ code: -1, stdout: out, stderr: String(e.message), killed: false }));
    p.on('close', (code, sig) => resolve({ code, stdout: out, stderr: err, signal: sig }));
  });
}
function readMeminfo() {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8'); const g = k => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t); return m ? Math.round(+m[1] / 1024) : null; };
    return { total_mb: g('MemTotal'), available_mb: g('MemAvailable') };
  } catch { return { total_mb: null, available_mb: null }; }
}
function freeStorageMb(dir) {
  try { const s = fs.statfsSync(dir); return Math.round((s.bavail * s.bsize) / 1048576); } catch { return null; }
}
// Samples a child process: peak RSS (VmHWM) and CPU seconds. Best effort: Android may hide /proc entries.
function monitor(pid) {
  const clk = 100; let peak = 0, cpuStart = null, cpuLast = 0; const t0 = Date.now(); let ok = false;
  const sample = () => {
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); const m = /VmHWM:\s+(\d+)/.exec(st) || /VmRSS:\s+(\d+)/.exec(st);
      if (m) { peak = Math.max(peak, +m[1] / 1024); ok = true; }
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      const cpu = (+f[11] + +f[12]) / clk; if (cpuStart === null) cpuStart = 0; cpuLast = cpu;
    } catch { /* process ended */ }
  };
  const iv = setInterval(sample, 1000); sample();
  return () => { clearInterval(iv); sample(); const wall = (Date.now() - t0) / 1000; return { measured: ok, peak_rss_mb: Math.round(peak), cpu_seconds: Math.round(cpuLast * 10) / 10, wall_seconds: Math.round(wall * 10) / 10, avg_cpu_cores: wall > 0 ? Math.round((cpuLast / wall) * 100) / 100 : 0 }; };
}
function sha256File(p) {
  return new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { run, readMeminfo, freeStorageMb, monitor, sha256File, sleep };
