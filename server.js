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
const ROOT_TMP = path.join(os.tmpdir(), 'silencepro-mp4');
const UPLOAD_DIR = path.join(ROOT_TMP, 'uploads');
const OUTPUT_DIR = path.join(ROOT_TMP, 'outputs');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || 'ultrafast';
const FFMPEG_CRF = process.env.FFMPEG_CRF || '23';
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 1000 * 60 * 60 * 3);
const MAX_PROCESS_MS = Number(process.env.MAX_PROCESS_MS || 1000 * 60 * 20);

// Anti-clonagem básico para Render.
// Configure no Render em Environment se usar outro domínio.
// Exemplo: ALLOWED_ORIGINS=https://silencepro.pages.dev,https://seudominio.com
const DEFAULT_ALLOWED_ORIGINS = ['https://silencepro.pages.dev'];
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 12);
const RATE_BUCKETS = new Map();

// Proteção extra opcional por senha.
// No Render, configure ACCESS_PASSWORD para ativar a tela de acesso.
const ACCESS_PASSWORD = String(process.env.ACCESS_PASSWORD || '').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 12);
const SESSIONS = new Map();
// Desligado por padrão para evitar bug de repetição/gagueira causado por cortes sem reencode em keyframes.
const FAST_COPY_MODE = String(process.env.FAST_COPY_MODE || '0') === '1';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json({ limit: '20kb' }));

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return String(origin).replace(/\/$/, '');
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch (e) {}
  }
  return '';
}

function selfOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return proto + '://' + req.get('host');
}

function isAllowedOrigin(req) {
  const origin = requestOrigin(req);
  if (!origin) return true; // permite download direto e teste interno
  if (origin === selfOrigin(req)) return true; // permite usar direto pelo próprio Render
  return ALLOWED_ORIGINS.includes(origin);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > -1) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return cookies;
}

function signSession(id) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(id).digest('hex');
}

function createSession() {
  const id = crypto.randomUUID();
  const token = id + '.' + signSession(id);
  SESSIONS.set(id, { createdAt: Date.now(), updatedAt: Date.now() });
  return token;
}

function destroySession(token) {
  const parts = String(token || '').split('.');
  if (parts.length === 2) SESSIONS.delete(parts[0]);
}

function isAuthenticated(req) {
  if (!ACCESS_PASSWORD) return true;
  const token = parseCookies(req).sp_session;
  if (!token) return false;

  const parts = String(token).split('.');
  if (parts.length !== 2) return false;

  const [id, sig] = parts;
  if (signSession(id) !== sig) return false;

  const session = SESSIONS.get(id);
  if (!session) return false;

  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    SESSIONS.delete(id);
    return false;
  }

  session.updatedAt = Date.now();
  return true;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    'sp_session=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function authRequired(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({
    ok: false,
    code: 'AUTH_REQUIRED',
    error: 'Acesso protegido. Digite a senha para usar o Silence Pro.'
  });
}

function antiCloneAndRateLimit(req, res, next) {
  const origin = requestOrigin(req);

  if (origin && isAllowedOrigin(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com; " +
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "connect-src 'self' " + ALLOWED_ORIGINS.join(' ') + "; frame-ancestors 'none';"
  );

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  const protectedRoute =
    req.path.startsWith('/process') ||
    req.path.startsWith('/status') ||
    req.path.startsWith('/download') ||
    req.path.startsWith('/preview');

  if (protectedRoute && !isAllowedOrigin(req)) {
    return res.status(403).json({
      ok: false,
      error: 'Acesso bloqueado. Este motor só funciona no domínio oficial do Silence Pro.'
    });
  }

  if (protectedRoute && !isAuthenticated(req)) {
    return res.status(401).json({
      ok: false,
      code: 'AUTH_REQUIRED',
      error: 'Acesso protegido. Digite a senha para usar o Silence Pro.'
    });
  }

  if (req.method === 'POST' && req.path.startsWith('/process')) {
    const key = clientIp(req);
    const now = Date.now();
    const bucket = RATE_BUCKETS.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }

    bucket.count += 1;
    RATE_BUCKETS.set(key, bucket);

    if (bucket.count > RATE_LIMIT_MAX) {
      return res.status(429).json({
        ok: false,
        error: 'Muitas tentativas em pouco tempo. Aguarde um pouco e tente novamente.'
      });
    }
  }

  next();
}

app.use(antiCloneAndRateLimit);

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of RATE_BUCKETS) {
    if (now > bucket.resetAt + RATE_LIMIT_WINDOW_MS) RATE_BUCKETS.delete(key);
  }
}, 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of SESSIONS) {
    if (now - session.updatedAt > SESSION_TTL_MS) SESSIONS.delete(id);
  }
}, 60 * 1000 * 15).unref();

function safeBaseName(name) {
  return String(name || 'video').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'video';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '-' + safeBaseName(file.originalname) + path.extname(file.originalname || '.mp4'))
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.mp4', '.mov', '.webm', '.mkv'];
    if ((file.mimetype || '').startsWith('video/') || allowed.includes(ext)) return cb(null, true);
    cb(new Error('Formato inválido. Envie MP4, MOV, WEBM ou MKV.'));
  }
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || MAX_PROCESS_MS);
    const { timeoutMs: _ignored, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('O processamento demorou demais e foi interrompido. Tente um vídeo menor ou use o modo Viral Max/Natural.'));
    }, timeoutMs);

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error((stderr || stdout || 'Erro desconhecido no FFmpeg.').slice(-3500));
        err.code = code;
        reject(err);
      }
    });
  });
}

async function probe(inputPath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath]);
  const data = JSON.parse(stdout || '{}');
  const duration = Number(data.format && data.format.duration ? data.format.duration : 0);
  const streams = data.streams || [];
  return {
    duration,
    hasVideo: streams.some(s => s.codec_type === 'video'),
    hasAudio: streams.some(s => s.codec_type === 'audio')
  };
}

async function detectSilences(inputPath, thresholdDb, minSilenceSec) {
  // Correção de segurança:
  // antes o código forçava tudo para -25dB, até o modo Natural.
  // Isso deixava todos os modos agressivos e cortava fala baixa/respiração como se fosse silêncio.
  const effectiveThreshold = Math.max(-80, Math.min(-10, Number(thresholdDb) || -35));
  const effectiveMinSilence = Math.max(0.08, Math.min(3, Number(minSilenceSec) || 0.18));

  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', inputPath,
    '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000',
    '-af', 'highpass=f=70,lowpass=f=9000,silencedetect=n=' + effectiveThreshold + 'dB:d=' + effectiveMinSilence,
    '-f', 'null', '-'
  ]);
  const silences = [];
  let currentStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) currentStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && currentStart !== null) {
      silences.push({ start: currentStart, end: Number(end[1]) });
      currentStart = null;
    }
  }
  return { silences, openSilenceStart: currentStart, effectiveThreshold, effectiveMinSilence };
}

function buildCutRanges(duration, silences, openSilenceStart, paddingSec) {
  const max = Math.max(0, Number(duration) || 0);
  const ranges = [...silences];
  if (openSilenceStart !== null && openSilenceStart !== undefined) ranges.push({ start: openSilenceStart, end: max });

  const cuts = [];
  const requestedMargin = Math.max(0, Math.min(0.18, Number(paddingSec) || 0));
  for (const s of ranges) {
    // Correção de segurança:
    // a margem agora preserva um pedacinho antes/depois da fala.
    // Não expande o corte para dentro da palavra, evitando corte seco em sílabas.
    const rawStart = Math.max(0, Math.min(max, Number(s.start)));
    const rawEnd = Math.max(0, Math.min(max, Number(s.end)));
    const silenceDur = Math.max(0, rawEnd - rawStart);
    const margin = Math.min(requestedMargin, silenceDur * 0.35);
    const start = Math.max(0, Math.min(max, rawStart + margin));
    const end = Math.max(0, Math.min(max, rawEnd - margin));
    if (end - start >= 0.045) cuts.push({ start, end });
  }
  cuts.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const c of cuts) {
    if (!merged.length || c.start > merged[merged.length - 1].end + 0.080) merged.push({ ...c });
    else merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, c.end);
  }
  return merged;
}

function finalSecondsAfterCuts(duration, cuts) {
  const removed = cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
  return Math.max(0, duration - removed);
}

function buildKeepRanges(duration, cuts) {
  const total = Math.max(0, Number(duration) || 0);
  if (!cuts.length) return [{ start: 0, end: total }];
  const keep = [];
  let cursor = 0;
  for (const c of cuts) {
    const start = Math.max(0, Math.min(total, Number(c.start) || 0));
    const end = Math.max(0, Math.min(total, Number(c.end) || 0));
    if (start > cursor + 0.02) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < total - 0.02) keep.push({ start: cursor, end: total });
  // Evita microtrechos de áudio entre cortes muito próximos.
  // Esses pedaços minúsculos são os que mais geram chiado, estalo e sensação de erro no corte.
  return keep.filter(r => r.end - r.start >= 0.090);
}

function quoteConcatPath(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

function buildDropExpression(cuts) {
  if (!cuts.length) return '1';
  const parts = cuts.map(c => `between(t,${Math.max(0, c.start).toFixed(3)},${Math.max(0, c.end).toFixed(3)})`);
  return `not(${parts.join('+')})`;
}

async function renderCopyConcat(inputPath, outputPath, cuts, duration) {
  const keep = buildKeepRanges(duration, cuts);
  if (!keep.length) throw new Error('O corte ficou agressivo demais e removeria todo o vídeo.');

  const listPath = path.join(ROOT_TMP, crypto.randomUUID() + '-concat.ffconcat');
  let list = 'ffconcat version 1.0\n';
  for (const r of keep) {
    list += `file '${quoteConcatPath(inputPath)}'\n`;
    list += `inpoint ${Math.max(0, r.start).toFixed(3)}\n`;
    list += `outpoint ${Math.max(0, r.end).toFixed(3)}\n`;
  }
  await fsp.writeFile(listPath, list, 'utf8');
  try {
    await run('ffmpeg', [
      '-hide_banner', '-y', '-nostdin',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts',
      '-movflags', '+faststart', outputPath
    ]);
  } finally {
    fsp.unlink(listPath).catch(() => {});
  }
}

async function renderPreciseSelect(inputPath, outputPath, cuts, duration) {
  // ANTI-GAGO + ANTI-CHIADO:
  // 1) Não usa corte por cópia em keyframes, para não repetir fala.
  // 2) Usa trim/atrim com timestamps zerados.
  // 3) Aplica micro fade-in/fade-out em cada emenda de áudio para matar estalos/chiados de corte.
  // 4) Remove microtrechos curtos demais, que geralmente causam artefatos em narrações.
  const keep = buildKeepRanges(duration, cuts);
  if (!keep.length) throw new Error('O corte ficou agressivo demais e removeria todo o vídeo.');

  const filterPath = path.join(ROOT_TMP, crypto.randomUUID() + '-anti-chiado.filter');
  const AUDIO_FADE = Math.max(0.006, Math.min(0.018, Number(process.env.AUDIO_FADE_SEC || 0.012)));
  let filter = '';
  for (let i = 0; i < keep.length; i++) {
    const r = keep[i];
    const segDur = Math.max(0, r.end - r.start);
    const start = Math.max(0, r.start).toFixed(3);
    const end = Math.max(0, r.end).toFixed(3);
    const fade = Math.min(AUDIO_FADE, Math.max(0.003, segDur / 4));
    const outStart = Math.max(0, segDur - fade).toFixed(3);
    const fadeStr = fade.toFixed(3);

    filter += `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}];`;
    filter += `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,`;
    filter += `afade=t=in:st=0:d=${fadeStr},afade=t=out:st=${outStart}:d=${fadeStr},`;
    filter += `aresample=async=1:first_pts=0[a${i}];`;
  }
  for (let i = 0; i < keep.length; i++) filter += `[v${i}][a${i}]`;
  filter += `concat=n=${keep.length}:v=1:a=1[vcat][acat];`;
  filter += `[acat]aresample=async=1:first_pts=0,alimiter=limit=0.98[a]`;

  await fsp.writeFile(filterPath, filter, 'utf8');
  try {
    await run('ffmpeg', [
      '-hide_banner', '-y', '-nostdin', '-i', inputPath,
      '-filter_complex_script', filterPath,
      '-map', '[vcat]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', FFMPEG_PRESET, '-crf', FFMPEG_CRF,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-threads', '0', outputPath
    ]);
  } finally {
    fsp.unlink(filterPath).catch(() => {});
  }
}

async function renderWithCuts(inputPath, outputPath, cuts, duration) {
  if (!cuts.length) {
    // Sem corte real: cópia instantânea, sem perda de qualidade.
    await run('ffmpeg', [
      '-hide_banner', '-y', '-nostdin', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-movflags', '+faststart', outputPath
    ]);
    return { mode: 'copy-no-cuts' };
  }

  if (FAST_COPY_MODE) {
    try {
      await renderCopyConcat(inputPath, outputPath, cuts, duration);
      const outInfo = await probe(outputPath).catch(() => null);
      const expected = finalSecondsAfterCuts(duration, cuts);
      // Se o corte por cópia não reduziu o suficiente por causa de keyframes, usa o corte preciso.
      if (outInfo && outInfo.duration <= Math.min(duration - 0.15, expected + 0.75)) {
        return { mode: 'ultra-fast-copy' };
      }
      fsp.unlink(outputPath).catch(() => {});
    } catch (e) {
      fsp.unlink(outputPath).catch(() => {});
    }
  }

  await renderPreciseSelect(inputPath, outputPath, cuts, duration);
  return { mode: 'precise-anti-gago-anti-chiado' };
}

function cleanOldFiles() {
  const maxAgeMs = 1000 * 60 * 60;
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    fs.readdir(dir, (err, files) => {
      if (err) return;
      for (const file of files) {
        const full = path.join(dir, file);
        fs.stat(full, (statErr, stat) => {
          if (!statErr && Date.now() - stat.mtimeMs > maxAgeMs) fs.unlink(full, () => {});
        });
      }
    });
  }
}
setInterval(cleanOldFiles, 1000 * 60 * 15).unref();


const JOBS = new Map();
const PROCESS_QUEUE = [];
let activeJob = null;

function nowTime() {
  return new Date().toLocaleTimeString('pt-PT', { hour12: false });
}

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    progress: 1,
    message: 'Na fila...',
    logs: [],
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  JOBS.set(id, job);
  return job;
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

function logJob(job, msg, type = 'info') {
  job.logs.push({ time: nowTime(), msg, type });
  if (job.logs.length > 80) job.logs.shift();
  job.updatedAt = Date.now();
}

function queuePosition(jobId) {
  const idx = PROCESS_QUEUE.findIndex(item => item.job.id === jobId);
  return idx < 0 ? 0 : idx + 1;
}

function enqueueJob(job, task) {
  PROCESS_QUEUE.push({ job, task });
  const pos = queuePosition(job.id);
  updateJob(job, {
    status: 'queued',
    progress: 5,
    message: pos > 1 ? `Na fila: ${pos - 1} vídeo(s) na frente` : 'Aguardando processamento...'
  });
  drainQueue();
}

async function drainQueue() {
  if (activeJob) return;
  const item = PROCESS_QUEUE.shift();
  if (!item) return;

  const { job, task } = item;
  activeJob = job.id;

  try {
    updateJob(job, { status: 'processing', progress: 10, message: 'Iniciando processamento...' });
    logJob(job, 'A ligar o motor de áudio...', 'info');
    const result = await task(job);
    updateJob(job, { status: 'done', progress: 100, message: 'Processamento concluído!', result });
    logJob(job, 'Pronto! Processamento concluído.', 'success');
  } catch (err) {
    updateJob(job, {
      status: 'error',
      progress: 100,
      message: 'Erro no processamento',
      error: err.message || 'Erro ao processar vídeo.'
    });
    logJob(job, 'ERRO: ' + (err.message || 'Erro ao processar vídeo.'), 'error');
  } finally {
    activeJob = null;
    setImmediate(drainQueue);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.updatedAt > JOB_TTL_MS) JOBS.delete(id);
  }
}, 1000 * 60 * 15).unref();


const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"pt-PT\" class=\"dark\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>Silence Pro by Leinad | Removedor de Silêncio</title>\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script src=\"https://unpkg.com/lucide@latest\"></script>\n    <!-- Motor LameJS para codificação real do MP3 -->\n    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js\"></script>\n    <script>\n        tailwind.config = {\n            darkMode: 'class',\n            theme: {\n                extend: {\n                    colors: {\n                        gray: {\n                            850: '#1f2937',\n                            900: '#111827',\n                            950: '#030712',\n                        }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        ::-webkit-scrollbar { width: 8px; }\n        ::-webkit-scrollbar-track { background: #111827; }\n        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }\n        ::-webkit-scrollbar-thumb:hover { background: #4b5563; }\n        .glass-panel {\n            background: rgba(31, 41, 55, 0.7);\n            backdrop-filter: blur(10px);\n            border: 1px solid rgba(75, 85, 99, 0.4);\n        }\n    </style>\n</head>\n<body class=\"bg-gray-950 text-gray-100 min-h-screen flex flex-col font-sans selection:bg-blue-500 selection:text-white\">\n\n    <header class=\"border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50\">\n        <div class=\"max-w-5xl mx-auto px-4 h-16 flex items-center justify-between\">\n            <div class=\"flex items-center gap-3\">\n                <i data-lucide=\"scissors\" class=\"text-blue-500 w-6 h-6\"></i>\n                <div class=\"flex items-center\">\n                    <span class=\"font-bold text-xl tracking-tight\">Silence <span class=\"text-blue-500\">Pro</span></span>\n                    <span class=\"ml-3 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full border border-gray-700 shadow-sm\">by Leinad</span>\n                </div>\n            </div>\n            <div class=\"text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block\">Motor MP3 + Zero-Crossing Otimizado</div>\n        </div>\n    </header>\n\n    <main class=\"flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6\">\n        \n        <div class=\"md:col-span-1 space-y-6\">\n            \n            <div id=\"drop-zone\" class=\"glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden\">\n                <input type=\"file\" id=\"audio-input\" accept=\"video/*,.mp4,.mov,.webm,.mkv\" class=\"absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10\">\n                <div class=\"flex flex-col items-center gap-3 pointer-events-none\">\n                    <div class=\"w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform\">\n                        <i data-lucide=\"upload-cloud\" class=\"text-blue-400 w-6 h-6\"></i>\n                    </div>\n                    <div>\n                        <p class=\"font-medium text-gray-200\">Arraste o seu áudio</p>\n                        <p class=\"text-xs text-gray-400 mt-1\">ou toque para procurar</p>\n                        <div class=\"mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2\">\n                            <p>MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG e FLAC.</p>\n                        </div>\n                    </div>\n                </div>\n                <div id=\"file-info\" class=\"hidden mt-4 pt-4 border-t border-gray-700 text-sm text-left\">\n                    <div class=\"flex items-center gap-2 text-green-400 mb-1\">\n                        <i data-lucide=\"check-circle\" class=\"w-4 h-4\"></i>\n                        <span class=\"font-medium truncate\" id=\"file-name\">processando...</span>\n                    </div>\n                    <span class=\"text-gray-400 text-xs\" id=\"file-size\">0 MB</span>\n                </div>\n            </div>\n\n            <div class=\"glass-panel rounded-2xl p-6 space-y-5\">\n                <div class=\"flex items-center justify-between mb-2\">\n                    <h3 class=\"font-semibold text-lg flex items-center gap-2\">\n                        <i data-lucide=\"sliders\" class=\"w-5 h-5 text-gray-400\"></i>\n                        Ajustes de Corte\n                    </h3>\n                </div>\n\n                <div class=\"space-y-3 pb-4 border-b border-gray-800\">\n                    <label class=\"text-sm text-gray-300 font-medium\">Estratégia de Retenção</label>\n                    <div class=\"grid grid-cols-3 gap-2\">\n                        <button type=\"button\" id=\"preset-extremo\" class=\"py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center\">\n                            <span>🚀 Extremo</span>\n                            <span class=\"font-normal text-[9px] text-gray-200\">(Corte seco)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-agressivo\" class=\"py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900\">\n                            <span>🔥 Viral Max</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Liso, sem ruído)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-natural\" class=\"py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center\">\n                            <span>🎙️ Natural</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Podcast)</span>\n                        </button>\n                    </div>\n                </div>\n\n                <div class=\"space-y-2 pt-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Volume de corte (dB)</label>\n                        <span id=\"threshold-val\" class=\"font-mono text-blue-400\">-30 dB</span>\n                    </div>\n                    <input type=\"range\" id=\"threshold\" min=\"-80\" max=\"-10\" value=\"-30\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n\n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Silêncio mínimo (seg)</label>\n                        <span id=\"duration-val\" class=\"font-mono text-blue-400\">0.10s</span>\n                    </div>\n                    <input type=\"range\" id=\"duration\" min=\"0.01\" max=\"3\" step=\"0.01\" value=\"0.10\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n                \n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Margem natural (seg)</label>\n                        <span id=\"padding-val\" class=\"font-mono text-blue-400\">0.05s</span>\n                    </div>\n                    <input type=\"range\" id=\"padding\" min=\"0\" max=\"0.5\" step=\"0.01\" value=\"0.05\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n            </div>\n\n            <button id=\"process-btn\" disabled class=\"w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]\">\n                <i data-lucide=\"zap\" class=\"w-5 h-5\"></i>\n                Remover Silêncios\n            </button>\n        </div>\n\n        <div class=\"md:col-span-2 flex flex-col gap-6\">\n            \n            <div class=\"glass-panel rounded-2xl p-6 flex-1 flex flex-col relative\">\n                <h3 class=\"font-semibold text-lg flex items-center gap-2 mb-4\">\n                    <i data-lucide=\"activity\" class=\"w-5 h-5 text-gray-400\"></i>\n                    Estado do Processamento\n                </h3>\n                \n                <div id=\"log-container\" class=\"flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2\">\n                    <div class=\"text-gray-600\">A aguardar áudio...</div>\n                </div>\n\n                <div id=\"loading-overlay\" class=\"hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10\">\n                    <div class=\"relative w-20 h-20 mb-3 shrink-0\">\n                        <svg class=\"absolute inset-0 w-20 h-20 -rotate-90\" viewBox=\"0 0 80 80\" aria-hidden=\"true\">\n                            <circle cx=\"40\" cy=\"40\" r=\"34\" fill=\"none\" stroke=\"rgba(75, 85, 99, 0.85)\" stroke-width=\"5\"></circle>\n                            <circle id=\"loading-progress-ring\" cx=\"40\" cy=\"40\" r=\"34\" fill=\"none\" stroke=\"#3b82f6\" stroke-width=\"5\" stroke-linecap=\"round\" stroke-dasharray=\"213.63\" stroke-dashoffset=\"213.63\"></circle>\n                        </svg>\n                        <span id=\"loading-percent\" class=\"absolute inset-0 z-10 flex items-center justify-center font-black text-lg leading-none text-white tabular-nums text-center\">0%</span>\n                    </div>\n                    <p class=\"font-medium text-lg animate-pulse text-center\" id=\"loading-text\">Removendo silêncios...</p>\n                    <p class=\"text-sm text-blue-300 mt-2 font-mono\" id=\"loading-time\">Tempo decorrido: 0s</p>\n                </div>\n            </div>\n\n            <div id=\"result-panel\" class=\"glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]\">\n                <div class=\"flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4\">\n                    <div class=\"text-center sm:text-left\">\n                        <h3 class=\"font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1\">\n                            <i data-lucide=\"party-popper\" class=\"w-6 h-6\"></i>\n                            MP4 Pronto a Usar!\n                        </h3>\n                        <p class=\"text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1\" id=\"result-stats\">Calculando redução...</p>\n                    </div>\n                    \n                    <a id=\"download-btn\" href=\"#\" download=\"video_viral_limpo.mp4\" class=\"w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer\">\n                        <i data-lucide=\"download\" class=\"w-6 h-6\"></i>\n                        BAIXAR MP4\n                    </a>\n                </div>\n                <div class=\"mt-6 pt-4 border-t border-gray-700\">\n                    <video id=\"audio-preview\" controls class=\"w-full rounded-lg bg-black max-h-[430px]\"></video>\n                </div>\n            </div>\n\n        </div>\n    </main>\n\n    <footer class=\"w-full text-center pb-8 pt-4\">\n        <p class=\"text-[11px] text-gray-500 font-medium tracking-widest uppercase\">\"Que Ele cresça e eu diminua.\" <span class=\"text-gray-600 ml-1\">- João 3:30</span></p>\n    </footer>\n\n    <script>\n        lucide.createIcons();\n        checkAuth();\n\n        const fileInput = document.getElementById('audio-input');\n        const dropZone = document.getElementById('drop-zone');\n        const fileNameEl = document.getElementById('file-name');\n        const fileSizeEl = document.getElementById('file-size');\n        const fileInfoEl = document.getElementById('file-info');\n        const processBtn = document.getElementById('process-btn');\n        const thresholdInput = document.getElementById('threshold');\n        const durationInput = document.getElementById('duration');\n        const paddingInput = document.getElementById('padding');\n        const thresholdVal = document.getElementById('threshold-val');\n        const durationVal = document.getElementById('duration-val');\n        const paddingVal = document.getElementById('padding-val');\n        const logContainer = document.getElementById('log-container');\n        const loadingOverlay = document.getElementById('loading-overlay');\n        const loadingText = document.getElementById('loading-text');\n        const loadingPercent = document.getElementById('loading-percent');\n        const loadingRing = document.getElementById('loading-progress-ring');\n        const loadingTime = document.getElementById('loading-time');\n        const resultPanel = document.getElementById('result-panel');\n        const authOverlay = document.getElementById('auth-overlay');\n        const authForm = document.getElementById('auth-form');\n        const authPassword = document.getElementById('auth-password');\n        const authError = document.getElementById('auth-error');\n        const resultStats = document.getElementById('result-stats');\n        const downloadBtn = document.getElementById('download-btn');\n        const audioPreview = document.getElementById('audio-preview');\n        const presetExtremo = document.getElementById('preset-extremo');\n        const presetAgressivo = document.getElementById('preset-agressivo');\n        const presetNatural = document.getElementById('preset-natural');\n\n        let currentFile = null;\n        let processingStartedAt = 0;\n        let timeTimer = null;\n        let lastProgressValue = 0;\n\n        function formatTime(seconds) {\n            const s = Math.max(0, Math.round(seconds || 0));\n            const min = Math.floor(s / 60);\n            const sec = s % 60;\n            if (min <= 0) return `${sec}s`;\n            return `${min} min ${String(sec).padStart(2, '0')}s`;\n        }\n\n        function startElapsedTimer() {\n            stopElapsedTimer();\n            timeTimer = setInterval(() => {\n                const elapsed = (Date.now() - processingStartedAt) / 1000;\n                loadingTime.textContent = `Tempo decorrido: ${formatTime(elapsed)}`;\n            }, 1000);\n        }\n\n        function stopElapsedTimer() {\n            if (timeTimer) {\n                clearInterval(timeTimer);\n                timeTimer = null;\n            }\n        }\n\n        function setProgress(value, text) {\n            const requested = Math.max(0, Math.min(100, Math.round(value || 0)));\n\n            // Correção do bug visual:\n            // depois do upload o painel chegava em 30%, mas o status do servidor podia voltar para 10/15%.\n            // Agora a porcentagem só anda para frente e nunca volta para trás.\n            const progress = requested >= 100 ? 100 : Math.max(lastProgressValue, requested);\n            lastProgressValue = progress;\n\n            loadingPercent.textContent = `${progress}%`;\n\n            if (loadingRing) {\n                const circumference = 213.63;\n                loadingRing.style.strokeDashoffset = String(circumference - (progress / 100) * circumference);\n            }\n\n            if (text) loadingText.textContent = text;\n\n            const elapsed = processingStartedAt ? (Date.now() - processingStartedAt) / 1000 : 0;\n            loadingTime.textContent = progress >= 100 ? `Tempo decorrido: ${formatTime(elapsed)} | concluído` : `Tempo decorrido: ${formatTime(elapsed)}`;\n        }\n\n        function uploadVideo(form) {\n            return new Promise((resolve, reject) => {\n                const xhr = new XMLHttpRequest();\n                xhr.open('POST', '/process', true);\n                xhr.responseType = 'json';\n\n                xhr.upload.onloadstart = () => setProgress(2, 'A preparar envio...');\n                xhr.upload.onprogress = (event) => {\n                    if (!event.lengthComputable) return;\n                    const p = 2 + Math.round((event.loaded / event.total) * 28);\n                    setProgress(Math.min(30, p), 'A enviar vídeo...');\n                };\n                xhr.upload.onloadend = () => setProgress(30, 'Upload concluído. Entrando na fila...');\n\n                xhr.onerror = () => reject(new Error('Falha de rede no envio. Verifique a internet e tente novamente.'));\n                xhr.onload = () => {\n                    const contentType = xhr.getResponseHeader('content-type') || '';\n                    if (!contentType.includes('application/json')) {\n                        const text = xhr.responseText || '';\n                        reject(new Error('O servidor não respondeu JSON. Faça deploy como Web Service no Render. Resposta: ' + text.slice(0, 120)));\n                        return;\n                    }\n\n                    const data = xhr.response || {};\n                    if (xhr.status < 200 || xhr.status >= 300 || !data.ok || !data.jobId) {\n                        reject(new Error(data.error || 'Erro ao iniciar processamento.'));\n                        return;\n                    }\n                    resolve(data.jobId);\n                };\n                xhr.send(form);\n            });\n        }\n\n        function renderJobLogs(logs) {\n            if (!Array.isArray(logs) || !logs.length) return;\n            logContainer.innerHTML = '';\n            const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };\n            logs.forEach(item => {\n                const line = document.createElement('div');\n                line.className = colors[item.type] || colors.info;\n                line.textContent = `[${item.time}] ${item.msg}`;\n                logContainer.appendChild(line);\n            });\n            logContainer.scrollTop = logContainer.scrollHeight;\n        }\n\n        function pollJob(jobId) {\n            return new Promise((resolve, reject) => {\n                const tick = async () => {\n                    try {\n                        const res = await fetch('/status/' + encodeURIComponent(jobId), { cache: 'no-store' });\n                        const data = await res.json();\n                        if (!res.ok || !data.ok) throw new Error(data.error || 'Falha ao consultar status.');\n\n                        setProgress(data.progress || 0, data.message || 'Processando...');\n                        renderJobLogs(data.logs);\n\n                        if (data.status === 'done') {\n                            localStorage.removeItem('silencepro_active_job');\n                            resolve(data.result);\n                            return;\n                        }\n\n                        if (data.status === 'error') {\n                            localStorage.removeItem('silencepro_active_job');\n                            reject(new Error(data.error || 'Erro no processamento.'));\n                            return;\n                        }\n\n                        setTimeout(tick, 2000);\n                    } catch (error) {\n                        reject(error);\n                    }\n                };\n                tick();\n            });\n        }\n\n        function showResult(data) {\n            downloadBtn.href = data.downloadUrl;\n            downloadBtn.download = data.fileName || 'SilencePro_video_limpo.mp4';\n            audioPreview.src = data.previewUrl || data.downloadUrl;\n            resultStats.textContent = `Original: ${data.originalSeconds}s | Limpo: ${data.finalSeconds}s | Redução: ${data.reductionPercent}%`;\n            resultPanel.classList.remove('hidden');\n        }\n\n\n        async function checkAuth() {\n            try {\n                const res = await fetch('/auth/status', { cache: 'no-store' });\n                const data = await res.json();\n                if (data.authRequired && !data.authenticated) {\n                    authOverlay.classList.remove('hidden');\n                    authOverlay.classList.add('flex');\n                    setTimeout(() => authPassword && authPassword.focus(), 100);\n                }\n            } catch (e) {}\n        }\n\n        if (authForm) {\n            authForm.addEventListener('submit', async (event) => {\n                event.preventDefault();\n                authError.classList.add('hidden');\n                try {\n                    const res = await fetch('/auth/login', {\n                        method: 'POST',\n                        headers: { 'Content-Type': 'application/json' },\n                        body: JSON.stringify({ password: authPassword.value || '' })\n                    });\n                    const data = await res.json();\n                    if (!res.ok || !data.ok) throw new Error(data.error || 'Senha incorreta.');\n                    authOverlay.classList.add('hidden');\n                    authOverlay.classList.remove('flex');\n                    authPassword.value = '';\n                } catch (error) {\n                    authError.textContent = error.message;\n                    authError.classList.remove('hidden');\n                }\n            });\n        }\n\n\n        function updateSliderUI() {\n            thresholdVal.textContent = `${thresholdInput.value} dB`;\n            durationVal.textContent = `${parseFloat(durationInput.value).toFixed(2)}s`;\n            paddingVal.textContent = `${parseFloat(paddingInput.value).toFixed(2)}s`;\n        }\n        thresholdInput.addEventListener('input', updateSliderUI);\n        durationInput.addEventListener('input', updateSliderUI);\n        paddingInput.addEventListener('input', updateSliderUI);\n\n        function resetButtons() {\n            [presetExtremo, presetAgressivo, presetNatural].forEach(btn => {\n                btn.className = 'py-2 px-1 bg-gray-800 rounded-lg text-xs font-bold transition-colors border border-gray-700 flex flex-col items-center justify-center text-center';\n            });\n        }\n        presetExtremo.addEventListener('click', () => {\n            resetButtons();\n            presetExtremo.className = 'py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -30;\n            durationInput.value = 0.04;\n            paddingInput.value = 0.02;\n            updateSliderUI();\n            log('Modo Extremo ativado.', 'info');\n        });\n        presetAgressivo.addEventListener('click', () => {\n            resetButtons();\n            presetAgressivo.className = 'py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -30;\n            durationInput.value = 0.10;\n            paddingInput.value = 0.05;\n            updateSliderUI();\n            log('Modo Viral Max ativado.', 'info');\n        });\n        presetNatural.addEventListener('click', () => {\n            resetButtons();\n            presetNatural.className = 'py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -40;\n            durationInput.value = 0.30;\n            paddingInput.value = 0.05;\n            updateSliderUI();\n            log('Modo Natural (Podcast) ativado.', 'info');\n        });\n\n        function log(msg, type = 'info') {\n            const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };\n            if (logContainer.innerHTML.includes('A aguardar')) logContainer.innerHTML = '';\n            const time = new Date().toLocaleTimeString('pt-PT', { hour12: false });\n            const line = document.createElement('div');\n            line.className = colors[type] || colors.info;\n            line.textContent = `[${time}] ${msg}`;\n            logContainer.appendChild(line);\n            logContainer.scrollTop = logContainer.scrollHeight;\n        }\n\n        function handleFile(file) {\n            if (!file) return;\n            const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];\n            const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';\n            const isVideo = file.type.startsWith('video/') || validVideoExts.includes(ext);\n            if (!isVideo) {\n                log('Formato inválido. Esta versão aceita vídeo: MP4, MOV, WEBM ou MKV.', 'error');\n                return;\n            }\n            currentFile = file;\n            fileNameEl.textContent = file.name;\n            fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';\n            fileInfoEl.classList.remove('hidden');\n            processBtn.disabled = false;\n            resultPanel.classList.add('hidden');\n            audioPreview.removeAttribute('src');\n            log(`Processando: ${file.name}`, 'info');\n        }\n\n        fileInput.addEventListener('click', (e) => { e.target.value = ''; });\n        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));\n        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });\n\n        processBtn.addEventListener('click', async () => {\n            if (!currentFile) return;\n\n            loadingOverlay.classList.remove('hidden');\n            loadingOverlay.classList.add('flex');\n            processBtn.disabled = true;\n            logContainer.innerHTML = '';\n            resultPanel.classList.add('hidden');\n            processingStartedAt = Date.now();\n            lastProgressValue = 0;\n            startElapsedTimer();\n            setProgress(0, 'A iniciar processamento...');\n\n            try {\n                const form = new FormData();\n                form.append('video', currentFile);\n                form.append('threshold', thresholdInput.value);\n                form.append('duration', durationInput.value);\n                form.append('padding', paddingInput.value);\n\n                const jobId = await uploadVideo(form);\n                localStorage.setItem('silencepro_active_job', jobId);\n                log('Upload concluído. Processando no servidor...', 'success');\n\n                const data = await pollJob(jobId);\n                setProgress(100, 'Processamento concluído!');\n                showResult(data);\n            } catch (error) {\n                console.error(error);\n                loadingText.textContent = 'Erro no processamento';\n                log(`ERRO: ${error.message}`, 'error');\n                localStorage.removeItem('silencepro_active_job');\n            } finally {\n                stopElapsedTimer();\n                setTimeout(() => {\n                    loadingOverlay.classList.add('hidden');\n                    loadingOverlay.classList.remove('flex');\n                    processBtn.disabled = false;\n                }, 500);\n            }\n        });\n\n        const savedJobId = localStorage.getItem('silencepro_active_job');\n        if (savedJobId) {\n            loadingOverlay.classList.remove('hidden');\n            loadingOverlay.classList.add('flex');\n            processBtn.disabled = true;\n            processingStartedAt = Date.now();\n            lastProgressValue = 0;\n            startElapsedTimer();\n            setProgress(30, 'Retomando processamento...');\n            log('Processamento anterior encontrado. Retomando acompanhamento...', 'info');\n\n            pollJob(savedJobId).then(data => {\n                setProgress(100, 'Processamento concluído!');\n                showResult(data);\n            }).catch(error => {\n                localStorage.removeItem('silencepro_active_job');\n                log(`ERRO: ${error.message}`, 'error');\n            }).finally(() => {\n                stopElapsedTimer();\n                setTimeout(() => {\n                    loadingOverlay.classList.add('hidden');\n                    loadingOverlay.classList.remove('flex');\n                    processBtn.disabled = false;\n                }, 500);\n            });\n        }\n    </script>\n</body>\n</html>\n";

app.get('/auth/status', (req, res) => {
  res.json({
    ok: true,
    authRequired: Boolean(ACCESS_PASSWORD),
    authenticated: isAuthenticated(req)
  });
});

app.post('/auth/login', (req, res) => {
  if (!ACCESS_PASSWORD) return res.json({ ok: true, authRequired: false });

  const password = String((req.body && req.body.password) || '');
  if (password !== ACCESS_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Senha incorreta.' });
  }

  const token = createSession();
  setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  destroySession(parseCookies(req).sp_session);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'Silence Pro MP4', ffmpeg: true }));
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

app.post('/process', upload.single('video'), async (req, res) => {
  const inputPath = req.file && req.file.path;

  try {
    if (!req.file) throw new Error('Nenhum vídeo foi enviado.');

    const threshold = Math.max(-80, Math.min(-10, Number(req.body.threshold || -30)));
    const minSilence = Math.max(0.01, Math.min(3, Number(req.body.duration || 0.10)));
    const padding = Math.max(0, Math.min(0.5, Number(req.body.padding || 0.05)));
    const originalName = req.file.originalname;

    const job = createJob();
    logJob(job, 'Upload recebido. Aguardando processamento...', 'success');

    enqueueJob(job, async (job) => {
      let outputPath = null;

      try {
        updateJob(job, { status: 'processing', progress: 15, message: 'Analisando vídeo...' });
        const info = await probe(inputPath);
        if (!info.hasVideo) throw new Error('O arquivo enviado não tem vídeo.');
        if (!info.hasAudio) throw new Error('Este vídeo não tem áudio. O corte das cenas precisa do áudio como guia.');
        if (!info.duration || !Number.isFinite(info.duration)) throw new Error('Não foi possível ler a duração do vídeo.');

        updateJob(job, { progress: 30, message: 'Detectando silêncios...' });
        logJob(job, 'Detectando silêncios...', 'info');
        const detected = await detectSilences(inputPath, threshold, minSilence);

        updateJob(job, { progress: 50, message: 'Preparando cortes...' });
        const cuts = buildCutRanges(info.duration, detected.silences, detected.openSilenceStart, padding);
        const finalSeconds = finalSecondsAfterCuts(info.duration, cuts);
        if (finalSeconds < 0.2) throw new Error('O corte ficou agressivo demais e removeria quase tudo. Reduza o volume de corte ou use Natural.');

        logJob(job, `Silêncios detectados: ${detected.silences.length + (detected.openSilenceStart !== null ? 1 : 0)}`, 'success');
        logJob(job, `Cortes aplicados no vídeo: ${cuts.length}`, 'success');

        updateJob(job, { progress: 70, message: 'Renderizando vídeo...' });
        const outputName = 'SilencePro_' + safeBaseName(originalName) + '_MP4_limpo_' + crypto.randomUUID().slice(0, 8) + '.mp4';
        outputPath = path.join(OUTPUT_DIR, outputName);
        const renderResult = await renderWithCuts(inputPath, outputPath, cuts, info.duration);

        updateJob(job, { progress: 95, message: 'Finalizando vídeo...' });
        const outInfo = await probe(outputPath).catch(() => null);
        const realFinalSeconds = outInfo && outInfo.duration ? outInfo.duration : finalSeconds;
        const reductionPercent = Math.max(0, Math.round((1 - realFinalSeconds / info.duration) * 100));

        return {
          ok: true,
          fileName: outputName,
          downloadUrl: '/download/' + encodeURIComponent(outputName),
          previewUrl: '/preview/' + encodeURIComponent(outputName),
          originalSeconds: info.duration.toFixed(1),
          finalSeconds: realFinalSeconds.toFixed(1),
          reductionPercent,
          silenceCount: detected.silences.length + (detected.openSilenceStart !== null ? 1 : 0),
          cutCount: cuts.length,
          renderMode: renderResult && renderResult.mode ? renderResult.mode : 'ok'
        };
      } catch (err) {
        if (outputPath) fsp.unlink(outputPath).catch(() => {});
        throw err;
      } finally {
        if (inputPath) fsp.unlink(inputPath).catch(() => {});
      }
    });

    res.json({ ok: true, jobId: job.id });
  } catch (err) {
    if (inputPath) fsp.unlink(inputPath).catch(() => {});
    res.status(400).json({ ok: false, error: err.message || 'Erro ao iniciar processamento.' });
  }
});

app.get('/status/:jobId', (req, res) => {
  const job = JOBS.get(String(req.params.jobId || ''));
  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Esse processamento expirou ou o servidor reiniciou. Envie o vídeo novamente.'
    });
  }

  const pos = queuePosition(job.id);
  res.json({
    ok: true,
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.status === 'queued' && pos > 1 ? `Na fila: ${pos - 1} vídeo(s) na frente` : job.message,
    logs: job.logs,
    result: job.result,
    error: job.error
  });
});

app.get('/preview/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send('Arquivo expirou. Processe novamente.');

  const stat = fs.statSync(full);
  const range = req.headers.range;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

    if (start >= stat.size || end >= stat.size) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
      return res.end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(full).pipe(res);
});

app.get('/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send('Arquivo expirou. Processe novamente.');

  // Mantido sem apagar imediatamente para evitar bug no celular.
  // A limpeza automática já apaga arquivos antigos pelo cleanOldFiles().
  res.download(full, file);
});


app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: 'Vídeo muito grande para este Render. Limite atual: ' + MAX_UPLOAD_MB + ' MB.' });
  if (err) return res.status(400).json({ ok: false, error: err.message || 'Erro inesperado.' });
  next();
});

app.listen(PORT, () => console.log('Silence Pro MP4 rodando na porta ' + PORT));
