'use strict';
const fs = require('fs'), path = require('path');
const cfg = require('./config'); const U = require('./util'); const S = require('../lib/srt');
class CapErr extends Error { constructor(m) { super(m); this.code = 'capability_missing'; this.retryable = false; } }
// Uses whisper.cpp if the user installed it (VW_WHISPER_BIN + VW_WHISPER_MODEL). Nothing is sent off-device.
async function transcribe(file, lang, tmpDir, cancelled) {
  if (!cfg.whisperBin || !cfg.whisperModel || !fs.existsSync(cfg.whisperModel)) throw new CapErr('Transcription needs whisper.cpp on the phone: set VW_WHISPER_BIN and VW_WHISPER_MODEL (see docs/TERMUX_SETUP.md), or supply an SRT/script/cues instead.');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wav = path.join(tmpDir, 'asr.wav');
  const a = await U.run(cfg.ffmpeg, ['-y', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  if (a.code !== 0) throw new CapErr('could not extract audio for transcription: ' + a.stderr.slice(0, 200));
  const base = path.join(tmpDir, 'asr');
  const w = await U.run(cfg.whisperBin, ['-m', cfg.whisperModel, '-f', wav, '-l', lang.split('-')[0], '-osrt', '-of', base]);
  if (w.code !== 0 || !fs.existsSync(base + '.srt')) throw new CapErr('whisper failed: ' + (w.stderr || w.stdout).slice(-300));
  return S.parseSrt(fs.readFileSync(base + '.srt', 'utf8'));
}
module.exports = { transcribe };
