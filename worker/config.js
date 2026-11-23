'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const env = process.env;
const home = env.HOME || os.homedir();
const DATA_DIR = env.VW_DATA_DIR || path.join(home, 'video-worker');
function findFont() {
  const c = [env.VW_FONT_FILE, '/data/data/com.termux/files/usr/share/fonts/TTF/DejaVuSans.ttf', '/data/data/com.termux/files/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/system/fonts/Roboto-Regular.ttf', '/system/fonts/DroidSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  return c.find(f => f && fs.existsSync(f)) || null;
}
module.exports = {
  baseUrl: (env.VW_N8N_BASE_URL || '').replace(/\/+$/, ''),   // e.g. https://n8n.example.com/webhook
  workerKey: env.VW_WORKER_KEY || '',
  workerId: env.VW_WORKER_ID || `${os.hostname()}-${process.pid}`.slice(0, 60),
  dataDir: DATA_DIR,
  assetRoot: env.VW_ASSET_ROOT || path.join(DATA_DIR, 'assets'),
  allowedRoots: (env.VW_ALLOWED_ROOTS ? env.VW_ALLOWED_ROOTS.split(':') : [path.join(DATA_DIR, 'assets'), path.join(home, 'storage/shared')]),
  outputDir: env.VW_OUTPUT_DIR || path.join(DATA_DIR, 'output'),
  tmpDir: env.VW_TMP_DIR || path.join(DATA_DIR, 'tmp'),
  stateDir: path.join(DATA_DIR, 'state'),
  ffmpeg: env.VW_FFMPEG || 'ffmpeg', ffprobe: env.VW_FFPROBE || 'ffprobe',
  fontFile: findFont(),
  pollSeconds: +(env.VW_POLL_SECONDS || 5),
  maxConcurrent: +(env.VW_MAX_CONCURRENT || 1),
  threads: env.VW_THREADS ? +env.VW_THREADS : undefined,
  minFreeStorageMb: +(env.VW_MIN_FREE_STORAGE_MB || 1024),
  minFreeRamMb: +(env.VW_MIN_FREE_RAM_MB || 300),
  qaFullDecode: env.VW_QA_FULL_DECODE !== '0',
  whisperBin: env.VW_WHISPER_BIN || '', whisperModel: env.VW_WHISPER_MODEL || '',
  allowedHosts: env.VW_ALLOWED_ASSET_HOSTS ? env.VW_ALLOWED_ASSET_HOSTS.split(',') : null,
  keepTmp: env.VW_KEEP_TMP === '1',
};
