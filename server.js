const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT_TMP = path.join(os.tmpdir(), 'silencepro-render');
const UPLOAD_DIR = path.join(ROOT_TMP, 'uploads');
const OUTPUT_DIR = path.join(ROOT_TMP, 'outputs');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || 'veryfast';
const FFMPEG_CRF = process.env.FFMPEG_CRF || '23';
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || '2';

let FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
try { FFMPEG = require('@ffmpeg-installer/ffmpeg').path || FFMPEG; } catch (_) {}
try { FFPROBE = require('@ffprobe-installer/ffprobe').path || FFPROBE; } catch (_) {}

const JOBS = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.mp4', '.mov', '.webm', '.mkv'];
    if (allowed.includes(ext) || /^audio\//.test(file.mimetype) || /^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Formato inválido. Envie MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG ou FLAC.'));
  }
});

app.use(express.static(__dirname));
app.use('/outputs', express.static(OUTPUT_DIR));

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function makeJob() {
  const jobId = crypto.randomBytes(12).toString('hex');
  const job = {
    status: 'queued',
    progress: 0,
    message: 'Na fila...',
    logs: [],
    createdAt: Date.now(),
    ok: true
  };
  JOBS.set(jobId, job);
  return { jobId, job };
}

function addLog(job, message) {
  job.message = message;
  job.logs.push(message);
  if (job.logs.length > 12) job.logs.shift();
}

function runProcess(command, args, onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); if (onData) onData(d.toString(), 'stdout'); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (onData) onData(d.toString(), 'stderr'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-2500) || `Processo finalizou com código ${code}`));
    });
  });
}

async function getDurationSeconds(input) {
  try {
    const { stdout } = await runProcess(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      input
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

function isVideoFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return /^video\//.test(file.mimetype) || ['.mp4', '.mov', '.webm', '.mkv'].includes(ext);
}

function parseSilences(stderr, totalDuration) {
  const silences = [];
  let currentStart = null;
  const reStart = /silence_start:\s*([0-9.]+)/g;
  const reEnd = /silence_end:\s*([0-9.]+)/g;
  const events = [];
  let m;
  while ((m = reStart.exec(stderr)) !== null) events.push({ type: 'start', value: Number(m[1]), index: m.index });
  while ((m = reEnd.exec(stderr)) !== null) events.push({ type: 'end', value: Number(m[1]), index: m.index });
  events.sort((a, b) => a.index - b.index);
  for (const ev of events) {
    if (ev.type === 'start') currentStart = ev.value;
    if (ev.type === 'end' && currentStart !== null) {
      if (ev.value > currentStart) silences.push({ start: currentStart, end: ev.value });
      currentStart = null;
    }
  }
  if (currentStart !== null && totalDuration > currentStart) silences.push({ start: currentStart, end: totalDuration });
  return silences;
}

function buildKeepRanges(silences, totalDuration, padding) {
  if (!totalDuration || totalDuration <= 0) return [{ start: 0, end: 86400 }];
  const removeRanges = silences
    .map(s => ({ start: Math.max(0, s.start + padding), end: Math.min(totalDuration, s.end - padding) }))
    .filter(s => s.end > s.start + 0.005)
    .sort((a, b) => a.start - b.start);

  const keep = [];
  let cursor = 0;
  for (const r of removeRanges) {
    if (r.start > cursor + 0.005) keep.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < totalDuration - 0.005) keep.push({ start: cursor, end: totalDuration });
  return keep.length ? keep : [{ start: 0, end: totalDuration }];
}

function ffTimeToSeconds(t) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function safeName(name) {
  return String(name || 'arquivo').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_\-]+/g, '_').slice(0, 60) || 'arquivo';
}

function exprForRanges(ranges) {
  return ranges.map(r => `between(t\\,${r.start.toFixed(3)}\\,${r.end.toFixed(3)})`).join('+') || '1';
}

async function processJob(jobId, file, settings) {
  const job = JOBS.get(jobId);
  const input = file.path;
  const mediaType = isVideoFile(file) ? 'video' : 'audio';
  const base = safeName(file.originalname);
  const outputExt = mediaType === 'video' ? '.mp4' : '.mp3';
  const outputFile = `SilencePro_${base}_${jobId.slice(0, 6)}${outputExt}`;
  const outputPath = path.join(OUTPUT_DIR, outputFile);

  try {
    job.status = 'running';
    job.progress = 4;
    addLog(job, 'Arquivo recebido no Render.');

    const duration = await getDurationSeconds(input);
    job.progress = 8;
    addLog(job, 'Mapeando silêncios com FFmpeg...');

    const detectArgs = [
      '-hide_banner', '-nostdin', '-i', input,
      '-af', `silencedetect=noise=${settings.threshold}dB:d=${settings.duration}`,
      '-f', 'null', '-'
    ];
    const detect = await runProcess(FFMPEG, detectArgs, (chunk) => {
      if (chunk.includes('silence_')) {
        job.progress = Math.min(24, job.progress + 1);
        job.message = 'Encontrando partes silenciosas...';
      }
    });

    const silences = parseSilences(detect.stderr, duration);
    const keepRanges = buildKeepRanges(silences, duration, settings.padding);
    const removedSeconds = silences.reduce((sum, s) => sum + Math.max(0, (s.end - settings.padding) - (s.start + settings.padding)), 0);
    const cleanSeconds = keepRanges.reduce((sum, r) => sum + (r.end - r.start), 0);

    job.progress = 28;
    addLog(job, silences.length ? `${silences.length} silêncio(s) encontrado(s). Renderizando arquivo limpo...` : 'Nenhum silêncio grande encontrado. Gerando arquivo final...');

    let args;
    if (mediaType === 'video') {
      const expr = exprForRanges(keepRanges);
      const filter = `[0:v]select='${expr}',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='${expr}',asetpts=N/SR/TB[a]`;
      args = [
        '-hide_banner', '-y', '-nostdin', '-i', input,
        '-filter_complex', filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', FFMPEG_PRESET, '-crf', FFMPEG_CRF,
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        '-threads', FFMPEG_THREADS,
        outputPath
      ];
    } else {
      const expr = exprForRanges(keepRanges);
      args = [
        '-hide_banner', '-y', '-nostdin', '-i', input,
        '-af', `aselect='${expr}',asetpts=N/SR/TB`,
        '-vn', '-c:a', 'libmp3lame', '-b:a', '128k',
        outputPath
      ];
    }

    const expectedOut = cleanSeconds || duration || 1;
    await runProcess(FFMPEG, args, (chunk) => {
      const sec = ffTimeToSeconds(chunk);
      if (sec !== null) {
        job.progress = Math.max(job.progress, Math.min(96, 30 + (sec / expectedOut) * 66));
        job.message = mediaType === 'video' ? 'Removendo silêncios do vídeo...' : 'Removendo silêncios do áudio...';
      }
    });

    const stat = await fsp.stat(outputPath);
    job.status = 'done';
    job.progress = 100;
    job.outputFile = outputFile;
    job.downloadName = outputFile;
    job.mediaType = mediaType;
    job.stats = duration
      ? `Original: ${duration.toFixed(1)}s | Limpo: ${cleanSeconds.toFixed(1)}s | Redução: ${Math.max(0, Math.round((1 - cleanSeconds / duration) * 100))}% | ${mediaType === 'video' ? 'MP4' : 'MP3'} ${(stat.size / 1024 / 1024).toFixed(2)} MB`
      : `Arquivo limpo gerado com sucesso. ${mediaType === 'video' ? 'MP4' : 'MP3'} ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
    addLog(job, 'Pronto. Arquivo final liberado.');
  } catch (err) {
    console.error(err);
    job.status = 'error';
    job.progress = Math.max(1, job.progress || 1);
    job.error = 'Não foi possível processar. Verifique se o arquivo tem áudio e tente novamente com um arquivo menor ou outro formato.';
    addLog(job, job.error);
  } finally {
    fsp.unlink(input).catch(() => {});
  }
}

app.post('/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Envie um arquivo de áudio ou vídeo.' });
    const settings = {
      threshold: clampNumber(req.body.threshold, -80, -10, -30),
      duration: clampNumber(req.body.duration, 0.01, 3, 0.10),
      padding: clampNumber(req.body.padding, 0, 0.5, 0.05)
    };
    const { jobId } = makeJob();
    res.json({ ok: true, jobId });
    processJob(jobId, req.file, settings);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Erro ao iniciar processamento.' });
  }
});

app.get('/status/:jobId', (req, res) => {
  const jobId = String(req.params.jobId || '');
  const job = JOBS.get(jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Esse processamento expirou. Envie o arquivo novamente.' });
  res.json({ ok: true, ...job });
});

app.get('/download/:file', (req, res) => {
  const file = path.basename(req.params.file || '');
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send('Arquivo não encontrado. Processe novamente.');
  res.download(full, file);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const msg = err && err.code === 'LIMIT_FILE_SIZE'
    ? `Arquivo muito grande. Limite atual: ${MAX_UPLOAD_MB} MB.`
    : (err.message || 'Erro interno.');
  res.status(400).json({ ok: false, error: msg });
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    if (now - job.createdAt > 1000 * 60 * 60 * 3) JOBS.delete(id);
  }
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    try {
      const files = await fsp.readdir(dir);
      for (const file of files) {
        const full = path.join(dir, file);
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > 1000 * 60 * 60 * 3) await fsp.unlink(full).catch(() => {});
      }
    } catch (_) {}
  }
}, 1000 * 60 * 20).unref();

app.listen(PORT, () => {
  console.log(`Silence Pro Render rodando na porta ${PORT}`);
});
