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
const FFMPEG_CRF = process.env.FFMPEG_CRF || '17';
const COPY_MAX_SEGMENTS = Number(process.env.COPY_MAX_SEGMENTS || 24);
const TURBO_COPY_MODE = String(process.env.TURBO_COPY_MODE || '1') !== '0';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

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
    cb(new Error('Formato inválido. Esta versão gera MP4 único. Envie MP4, MOV, WEBM ou MKV.'));
  }
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => {
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

function runBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    const stdoutChunks = [];
    let stderr = '';
    child.stdout.on('data', d => stdoutChunks.push(d));
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
      else {
        const err = new Error((stderr || 'Erro desconhecido no FFmpeg.').slice(-3500));
        err.code = code;
        reject(err);
      }
    });
  });
}

async function detectOriginalAudioCuts(inputPath, durationSec, thresholdDb, minSilenceSec, paddingSec) {
  // Usa a MESMA lógica do arquivo original: RMS em janelas de 10ms,
  // threshold em dB, silêncio mínimo e margem natural exatamente como estão no painel.
  // Não altera preset, não aumenta threshold e não muda a margem por conta própria.
  const sampleRate = 16000;
  const { stdout } = await runBuffer('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', inputPath,
    '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 'f32le', 'pipe:1'
  ]);

  const totalSamples = Math.floor(stdout.length / 4);
  if (!totalSamples) throw new Error('Não foi possível extrair o áudio do vídeo para mapear os cortes.');

  const thresholdAmp = Math.pow(10, Number(thresholdDb) / 20);
  const minSilenceSamples = Math.max(1, Math.floor(Number(minSilenceSec) * sampleRate));
  const paddingSamples = Math.max(0, Math.floor(Number(paddingSec) * sampleRate));
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.01));

  let isSilence = false;
  let silenceStart = 0;
  let currentKeepStart = 0;
  const keepSamples = [];
  let silenceCount = 0;

  for (let i = 0; i < totalSamples; i += windowSize) {
    let sum = 0;
    let count = 0;
    const end = Math.min(totalSamples, i + windowSize);
    for (let sample = i; sample < end; sample++) {
      const v = stdout.readFloatLE(sample * 4);
      sum += v * v;
      count++;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));

    if (rms < thresholdAmp) {
      if (!isSilence) {
        isSilence = true;
        silenceStart = i;
      }
    } else {
      if (isSilence) {
        const silenceSamples = i - silenceStart;
        if (silenceSamples >= minSilenceSamples) {
          silenceCount++;
          let endKeep = silenceStart + paddingSamples;
          if (endKeep > totalSamples) endKeep = totalSamples;

          let startKeep = currentKeepStart - paddingSamples;
          if (startKeep < 0) startKeep = 0;

          if (endKeep > startKeep) keepSamples.push({ start: startKeep, end: endKeep });
          currentKeepStart = i;
        }
        isSilence = false;
      }
    }
  }

  // Mesmo comportamento do original: salva a última parte útil.
  let finalStart = currentKeepStart - paddingSamples;
  if (finalStart < 0) finalStart = 0;
  const finalEnd = totalSamples;
  if (finalEnd > finalStart) keepSamples.push({ start: finalStart, end: finalEnd });

  // Mescla blocos sobrepostos sem mudar as configurações do painel.
  keepSamples.sort((a, b) => a.start - b.start);
  const mergedKeep = [];
  for (const r of keepSamples) {
    if (!mergedKeep.length || r.start > mergedKeep[mergedKeep.length - 1].end) mergedKeep.push({ ...r });
    else mergedKeep[mergedKeep.length - 1].end = Math.max(mergedKeep[mergedKeep.length - 1].end, r.end);
  }

  const keep = mergedKeep.map(r => ({
    start: Math.max(0, r.start / sampleRate),
    end: Math.min(durationSec, r.end / sampleRate)
  })).filter(r => r.end - r.start >= 0.025);

  const cuts = [];
  let cursor = 0;
  for (const r of keep) {
    if (r.start > cursor + 0.025) cuts.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < durationSec - 0.025) cuts.push({ start: cursor, end: durationSec });

  const finalSeconds = keep.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
  const removedSeconds = Math.max(0, durationSec - finalSeconds);
  return { keep, cuts, silenceCount, finalSeconds, removedSeconds };
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
  return keep.filter(r => r.end - r.start >= 0.025);
}

async function renderNoCuts(inputPath, outputPath) {
  // Sem cortes: copia rápido e mantém qualidade original.
  await run('ffmpeg', [
    '-hide_banner', '-y', '-nostdin', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c', 'copy', '-movflags', '+faststart', outputPath
  ]);
}

async function renderWithCutsReencode(inputPath, outputPath, cuts, duration) {
  if (!cuts.length) return renderNoCuts(inputPath, outputPath);

  const keep = buildKeepRanges(duration, cuts);
  if (!keep.length) throw new Error('O corte ficou agressivo demais e removeria todo o vídeo.');

  const scriptPath = path.join(ROOT_TMP, crypto.randomUUID() + '-filter.txt');
  let filter = '';
  const parts = [];
  keep.forEach((r, i) => {
    const st = Math.max(0, r.start).toFixed(3);
    const en = Math.max(0, r.end).toFixed(3);
    filter += `[0:v]trim=start=${st}:end=${en},setpts=PTS-STARTPTS[v${i}];\n`;
    filter += `[0:a]atrim=start=${st}:end=${en},asetpts=PTS-STARTPTS[a${i}];\n`;
    parts.push(`[v${i}][a${i}]`);
  });
  filter += `${parts.join('')}concat=n=${keep.length}:v=1:a=1[v][a]`;

  await fsp.writeFile(scriptPath, filter, 'utf8');
  try {
    await run('ffmpeg', [
      '-hide_banner', '-y', '-nostdin', '-i', inputPath,
      '-filter_complex_script', scriptPath,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', FFMPEG_PRESET, '-crf', FFMPEG_CRF,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', '-threads', '0', outputPath
    ]);
  } finally {
    fsp.unlink(scriptPath).catch(() => {});
  }
}

async function renderWithCutsCopy(inputPath, outputPath, cuts, duration) {
  if (!cuts.length) return renderNoCuts(inputPath, outputPath);
  const keep = buildKeepRanges(duration, cuts);
  if (!keep.length) throw new Error('O corte ficou agressivo demais e removeria todo o vídeo.');
  if (keep.length > COPY_MAX_SEGMENTS) throw new Error('Muitos cortes para stream copy rápido; usando HQ de uma passada.');

  const workDir = path.join(ROOT_TMP, crypto.randomUUID() + '-parts');
  await fsp.mkdir(workDir, { recursive: true });
  const listPath = path.join(workDir, 'concat.txt');
  const partFiles = [];
  try {
    for (let i = 0; i < keep.length; i++) {
      const r = keep[i];
      const start = Math.max(0, r.start).toFixed(3);
      const len = Math.max(0.03, r.end - r.start).toFixed(3);
      const part = path.join(workDir, 'part_' + String(i).padStart(4, '0') + '.mp4');
      partFiles.push(part);
      await run('ffmpeg', [
        '-hide_banner', '-y', '-nostdin',
        '-ss', start, '-i', inputPath, '-t', len,
        '-map', '0:v:0', '-map', '0:a:0',
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts', part
      ]);
    }
    await fsp.writeFile(listPath, partFiles.map(f => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
    await run('ffmpeg', [
      '-hide_banner', '-y', '-nostdin',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', outputPath
    ]);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}


async function ensureFinalHasVideo(outputPath) {
  const outInfo = await probe(outputPath);
  if (!outInfo.hasVideo) throw new Error('MP4 final saiu sem trilha de vídeo. Recriando em modo compatível.');
  if (!outInfo.hasAudio) throw new Error('MP4 final saiu sem trilha de áudio. Recriando em modo compatível.');
  if (!outInfo.duration || outInfo.duration < 0.1) throw new Error('MP4 final inválido. Recriando em modo compatível.');
  return outInfo;
}

async function renderWithCuts(inputPath, outputPath, cuts, duration) {
  let mode = 'HQ compatível';
  if (TURBO_COPY_MODE) {
    try {
      await renderWithCutsCopy(inputPath, outputPath, cuts, duration);
      return { mode: cuts.length ? 'Qualidade original rápida' : 'Cópia original sem cortes' };
    } catch (err) {
      console.warn('Modo original rápido não usado:', err.message);
      await fsp.unlink(outputPath).catch(() => {});
      mode = 'HQ de uma passada';
    }
  }
  await renderWithCutsReencode(inputPath, outputPath, cuts, duration);
  return { mode };
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

const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"pt-PT\" class=\"dark\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>Silence Pro by Leinad | Removedor de Sil\u00eancio</title>\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script src=\"https://unpkg.com/lucide@latest\"></script>\n    <!-- Motor LameJS para codifica\u00e7\u00e3o real do MP3 -->\n    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js\"></script>\n    <script>\n        tailwind.config = {\n            darkMode: 'class',\n            theme: {\n                extend: {\n                    colors: {\n                        gray: {\n                            850: '#1f2937',\n                            900: '#111827',\n                            950: '#030712',\n                        }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        ::-webkit-scrollbar { width: 8px; }\n        ::-webkit-scrollbar-track { background: #111827; }\n        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }\n        ::-webkit-scrollbar-thumb:hover { background: #4b5563; }\n        .glass-panel {\n            background: rgba(31, 41, 55, 0.7);\n            backdrop-filter: blur(10px);\n            border: 1px solid rgba(75, 85, 99, 0.4);\n        }\n    </style>\n</head>\n<body class=\"bg-gray-950 text-gray-100 min-h-screen flex flex-col font-sans selection:bg-blue-500 selection:text-white\">\n\n    <header class=\"border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50\">\n        <div class=\"max-w-5xl mx-auto px-4 h-16 flex items-center justify-between\">\n            <div class=\"flex items-center gap-3\">\n                <i data-lucide=\"scissors\" class=\"text-blue-500 w-6 h-6\"></i>\n                <div class=\"flex items-center\">\n                    <span class=\"font-bold text-xl tracking-tight\">Silence <span class=\"text-blue-500\">Pro</span></span>\n                    <span class=\"ml-3 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full border border-gray-700 shadow-sm\">by Leinad</span>\n                </div>\n            </div>\n            <div class=\"text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block\">Motor MP3 + Zero-Crossing Otimizado</div>\n        </div>\n    </header>\n\n    <main class=\"flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6\">\n        \n        <div class=\"md:col-span-1 space-y-6\">\n            \n            <div id=\"drop-zone\" class=\"glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden\">\n                <input type=\"file\" id=\"audio-input\" accept=\"audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.webm,.mkv\" class=\"absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10\">\n                <div class=\"flex flex-col items-center gap-3 pointer-events-none\">\n                    <div class=\"w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform\">\n                        <i data-lucide=\"upload-cloud\" class=\"text-blue-400 w-6 h-6\"></i>\n                    </div>\n                    <div>\n                        <p class=\"font-medium text-gray-200\">Arraste o seu \u00e1udio</p>\n                        <p class=\"text-xs text-gray-400 mt-1\">ou toque para procurar</p>\n                        <div class=\"mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2\">\n                            <p>MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG e FLAC.</p>\n                        </div>\n                    </div>\n                </div>\n                <div id=\"file-info\" class=\"hidden mt-4 pt-4 border-t border-gray-700 text-sm text-left\">\n                    <div class=\"flex items-center gap-2 text-green-400 mb-1\">\n                        <i data-lucide=\"check-circle\" class=\"w-4 h-4\"></i>\n                        <span class=\"font-medium truncate\" id=\"file-name\">processando...</span>\n                    </div>\n                    <span class=\"text-gray-400 text-xs\" id=\"file-size\">0 MB</span>\n                </div>\n            </div>\n\n            <div class=\"glass-panel rounded-2xl p-6 space-y-5\">\n                <div class=\"flex items-center justify-between mb-2\">\n                    <h3 class=\"font-semibold text-lg flex items-center gap-2\">\n                        <i data-lucide=\"sliders\" class=\"w-5 h-5 text-gray-400\"></i>\n                        Ajustes de Corte\n                    </h3>\n                </div>\n\n                <div class=\"space-y-3 pb-4 border-b border-gray-800\">\n                    <label class=\"text-sm text-gray-300 font-medium\">Estrat\u00e9gia de Reten\u00e7\u00e3o</label>\n                    <div class=\"grid grid-cols-3 gap-2\">\n                        <button type=\"button\" id=\"preset-extremo\" class=\"py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center\">\n                            <span>\ud83d\ude80 Extremo</span>\n                            <span class=\"font-normal text-[9px] text-gray-200\">(Corte seco)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-agressivo\" class=\"py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900\">\n                            <span>\ud83d\udd25 Viral Max</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Liso, sem ru\u00eddo)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-natural\" class=\"py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center\">\n                            <span>\ud83c\udf99\ufe0f Natural</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Podcast)</span>\n                        </button>\n                    </div>\n                </div>\n\n                <div class=\"space-y-2 pt-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Volume de corte (dB)</label>\n                        <span id=\"threshold-val\" class=\"font-mono text-blue-400\">-30 dB</span>\n                    </div>\n                    <input type=\"range\" id=\"threshold\" min=\"-80\" max=\"-10\" value=\"-30\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n\n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Sil\u00eancio m\u00ednimo (seg)</label>\n                        <span id=\"duration-val\" class=\"font-mono text-blue-400\">0.10s</span>\n                    </div>\n                    <input type=\"range\" id=\"duration\" min=\"0.01\" max=\"3\" step=\"0.01\" value=\"0.10\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n                \n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Margem natural (seg)</label>\n                        <span id=\"padding-val\" class=\"font-mono text-blue-400\">0.05s</span>\n                    </div>\n                    <input type=\"range\" id=\"padding\" min=\"0\" max=\"0.5\" step=\"0.01\" value=\"0.05\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n            </div>\n\n            <button id=\"process-btn\" disabled class=\"w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]\">\n                <i data-lucide=\"zap\" class=\"w-5 h-5\"></i>\n                Remover Sil\u00eancios\n            </button>\n        </div>\n\n        <div class=\"md:col-span-2 flex flex-col gap-6\">\n            \n            <div class=\"glass-panel rounded-2xl p-6 flex-1 flex flex-col relative\">\n                <h3 class=\"font-semibold text-lg flex items-center gap-2 mb-4\">\n                    <i data-lucide=\"activity\" class=\"w-5 h-5 text-gray-400\"></i>\n                    Estado do Processamento\n                </h3>\n                \n                <div id=\"log-container\" class=\"flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2\">\n                    <div class=\"text-gray-600\">A aguardar \u00e1udio...</div>\n                </div>\n\n                <div id=\"loading-overlay\" class=\"hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10\">\n                    <div class=\"w-16 h-16 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin mb-4\"></div>\n                    <p class=\"font-medium text-lg animate-pulse\" id=\"loading-text\">Removendo sil\u00eancios...</p>\n                </div>\n            </div>\n\n            <div id=\"result-panel\" class=\"glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]\">\n                <div class=\"flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4\">\n                    <div class=\"text-center sm:text-left\">\n                        <h3 class=\"font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1\">\n                            <i data-lucide=\"party-popper\" class=\"w-6 h-6\"></i>\n                            MP4 Pronto a Usar!\n                        </h3>\n                        <p class=\"text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1\" id=\"result-stats\">Calculando redu\u00e7\u00e3o...</p>\n                    </div>\n                    \n                    <a id=\"download-btn\" href=\"#\" download=\"audio_viral_limpo.mp3\" class=\"w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer\">\n                        <i data-lucide=\"download\" class=\"w-6 h-6\"></i>\n                        BAIXAR MP4\n                    </a>\n                </div>\n                <div class=\"mt-6 pt-4 border-t border-gray-700\">\n                    <audio id=\"audio-preview\" controls class=\"w-full rounded-lg bg-gray-800\"></audio>\n                </div>\n            </div>\n\n        </div>\n    </main>\n\n    <footer class=\"w-full text-center pb-8 pt-4\">\n        <p class=\"text-[11px] text-gray-500 font-medium tracking-widest uppercase\">\"Que Ele cres\u00e7a e eu diminua.\" <span class=\"text-gray-600 ml-1\">- Jo\u00e3o 3:30</span></p>\n    </footer>\n\n    <script>\n        lucide.createIcons();\n\n        const fileInput = document.getElementById('audio-input');\n        const dropZone = document.getElementById('drop-zone');\n        const fileNameEl = document.getElementById('file-name');\n        const fileSizeEl = document.getElementById('file-size');\n        const fileInfoEl = document.getElementById('file-info');\n        const processBtn = document.getElementById('process-btn');\n        \n        const thresholdInput = document.getElementById('threshold');\n        const durationInput = document.getElementById('duration');\n        const paddingInput = document.getElementById('padding');\n        \n        const thresholdVal = document.getElementById('threshold-val');\n        const durationVal = document.getElementById('duration-val');\n        const paddingVal = document.getElementById('padding-val');\n        \n        const logContainer = document.getElementById('log-container');\n        const loadingOverlay = document.getElementById('loading-overlay');\n        const resultPanel = document.getElementById('result-panel');\n        const resultStats = document.getElementById('result-stats');\n        const downloadBtn = document.getElementById('download-btn');\n        const videoPreview = document.getElementById('audio-preview');\n\n        const presetExtremo = document.getElementById('preset-extremo');\n        const presetAgressivo = document.getElementById('preset-agressivo');\n        const presetNatural = document.getElementById('preset-natural');\n\n        let currentFile = null;\n        let audioContext = null;\n\n        function updateSliderUI() {\n            thresholdVal.textContent = `${thresholdInput.value} dB`;\n            durationVal.textContent = `${Number(durationInput.value).toFixed(2)}s`;\n            paddingVal.textContent = `${Number(paddingInput.value).toFixed(2)}s`;\n        }\n\n        thresholdInput.addEventListener('input', updateSliderUI);\n        durationInput.addEventListener('input', updateSliderUI);\n        paddingInput.addEventListener('input', updateSliderUI);\n\n        function resetButtons() {\n            [presetExtremo, presetAgressivo, presetNatural].forEach(btn => {\n                btn.className = \"py-2 px-1 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs font-bold transition-colors border border-gray-700 flex flex-col items-center justify-center text-center\";\n            });\n        }\n\n        // CONFIGURA\u00c7\u00c3O EXTREMO (Agressiva TikTok)\n        presetExtremo.addEventListener('click', () => {\n            resetButtons();\n            presetExtremo.className = \"py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900\";\n            thresholdInput.value = -30;  \n            durationInput.value = 0.04;  \n            paddingInput.value = 0.02;   \n            updateSliderUI();\n            log('Modo Extremo ativado.', 'info');\n        });\n\n        // CONFIGURA\u00c7\u00c3O VIRAL MAX\n        presetAgressivo.addEventListener('click', () => {\n            resetButtons();\n            presetAgressivo.className = \"py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900\";\n            thresholdInput.value = -30;  \n            durationInput.value = 0.10;  \n            paddingInput.value = 0.05;   \n            updateSliderUI();\n            log('Modo Viral Max ativado.', 'info');\n        });\n\n        // CONFIGURA\u00c7\u00c3O PODCAST (Conversa longa)\n        presetNatural.addEventListener('click', () => {\n            resetButtons();\n            presetNatural.className = \"py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900\";\n            thresholdInput.value = -40;  \n            durationInput.value = 0.30;  \n            paddingInput.value = 0.05;   \n            updateSliderUI();\n            log('Modo Natural (Podcast) ativado.', 'info');\n        });\n\n        function log(msg, type = 'info') {\n            const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };\n            if (logContainer.innerHTML.includes('A aguardar')) logContainer.innerHTML = '';\n            const time = new Date().toLocaleTimeString('pt-PT', { hour12: false });\n            const line = document.createElement('div');\n            line.className = colors[type];\n            line.innerHTML = `<span class=\"text-gray-600\">[${time}]</span> ${msg}`;\n            logContainer.appendChild(line);\n            logContainer.scrollTop = logContainer.scrollHeight;\n        }\n\n        function handleFile(file) {\n            if (!file) return;\n\n            const validExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];\n            const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];\n            const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';\n            const isAudio = file.type.startsWith('audio/') || validExts.includes(ext);\n            const isVideo = file.type.startsWith('video/') || validVideoExts.includes(ext);\n\n            if (!isAudio && !isVideo) {\n                log('Formato inv\u00e1lido. Use \u00e1udios como MP3, WAV, M4A, AAC, OGG ou FLAC, ou v\u00eddeos como MP4, MOV, WEBM ou MKV.', 'error');\n                return;\n            }\n\n            currentFile = file;\n            fileNameEl.textContent = file.name;\n            fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';\n            fileInfoEl.classList.remove('hidden');\n            processBtn.disabled = false;\n            log(`${isVideo ? 'V\u00eddeo selecionado para extrair \u00e1udio' : 'Processando'}: ${file.name}`, 'info');\n            resultPanel.classList.add('hidden');\n        }\n\n        fileInput.addEventListener('click', (e) => { e.target.value = ''; });\n        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));\n        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });\n\n        // MOTOR PRINCIPAL DE PROCESSAMENTO NO SERVIDOR RENDER\n        processBtn.addEventListener('click', async () => {\n            if (!currentFile) return;\n\n            loadingOverlay.classList.remove('hidden');\n            loadingOverlay.classList.add('flex');\n            processBtn.disabled = true;\n            logContainer.innerHTML = '';\n            resultPanel.classList.add('hidden');\n\n            try {\n                log('A ligar o motor de \u00e1udio...', 'info');\n\n                const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];\n                const ext = currentFile.name.includes('.') ? currentFile.name.substring(currentFile.name.lastIndexOf('.')).toLowerCase() : '';\n                const isVideo = currentFile.type.startsWith('video/') || validVideoExts.includes(ext);\n                if (!isVideo) {\n                    throw new Error('Esta vers\u00e3o do Render gera MP4 \u00fanico. Envie um v\u00eddeo MP4, MOV, WEBM ou MKV.');\n                }\n\n                const form = new FormData();\n                form.append('video', currentFile);\n                form.append('threshold', thresholdInput.value);\n                form.append('duration', durationInput.value);\n                form.append('padding', paddingInput.value);\n\n                log('A enviar para o servidor FFmpeg...', 'info');\n                const endpoint = new URL('/process', window.location.origin).href;\n                const res = await fetch(endpoint, {\n                    method: 'POST',\n                    body: form,\n                    cache: 'no-store',\n                    headers: { 'X-Silence-Pro-Version': 'smart-hq-video-certo-v2' }\n                });\n\n                const contentType = res.headers.get('content-type') || '';\n                if (!contentType.includes('application/json')) {\n                    const text = await res.text();\n                    throw new Error('O servidor respondeu uma p\u00e1gina antiga em vez de JSON. Atualize a p\u00e1gina, limpe o cache do navegador e fa\u00e7a Manual Deploy \u2192 Clear build cache & deploy no Render. Resposta: ' + text.slice(0, 100));\n                }\n\n                const data = await res.json();\n                if (!res.ok || !data.ok) throw new Error(data.error || 'Erro ao processar v\u00eddeo.');\n\n                log(`Sil\u00eancios detectados: ${data.silenceCount}`, 'success');\n                log(`Cortes aplicados no v\u00eddeo: ${data.cutCount}`, 'success');\n                log(`Modo usado: ${data.mode}`, 'success');\n                log('Pronto! Processando embalado a v\u00e1cuo.', 'success');\n\n                const downloadUrl = new URL(data.downloadUrl, window.location.origin).href;\n                downloadBtn.href = downloadUrl;\n                downloadBtn.download = data.fileName || `SilencePro_${currentFile.name.replace(/\\.[^/.]+$/, '')}.mp4`;\n                videoPreview.src = downloadUrl;\n                videoPreview.load();\n                resultStats.textContent = `Original: ${data.originalSeconds}s | Limpo: ${data.finalSeconds}s | Redu\u00e7\u00e3o: ${data.reductionPercent}%`;\n\n                loadingOverlay.classList.add('hidden');\n                loadingOverlay.classList.remove('flex');\n                resultPanel.classList.remove('hidden');\n                processBtn.disabled = false;\n\n            } catch (error) {\n                console.error(error);\n                log(`ERRO CR\u00cdTICO: ${error.message}`, 'error');\n                loadingOverlay.classList.add('hidden');\n                loadingOverlay.classList.remove('flex');\n                processBtn.disabled = false;\n            }\n        });\n    \n    </script>\n</body>\n</html>\n";

app.get('/health', (req, res) => res.json({ ok: true, service: 'Silence Pro MP4 Smart HQ Original Logic', ffmpeg: true, mode: 'mp4_video_audio_original_audio_algorithm' }));
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

async function processVideo(req, res) {
  const inputPath = req.file && req.file.path;
  let outputPath = null;
  try {
    if (!req.file) throw new Error('Nenhum vídeo foi enviado.');
    const threshold = Math.max(-80, Math.min(-10, Number(req.body.threshold || -30)));
    const minSilence = Math.max(0.01, Math.min(3, Number(req.body.duration || 0.10)));
    const padding = Math.max(0, Math.min(0.5, Number(req.body.padding || 0.05)));

    const info = await probe(inputPath);
    if (!info.hasVideo) throw new Error('O arquivo enviado não tem vídeo.');
    if (!info.hasAudio) throw new Error('Este vídeo não tem áudio. O corte das cenas precisa do áudio como guia.');
    if (!info.duration || !Number.isFinite(info.duration)) throw new Error('Não foi possível ler a duração do vídeo.');

    const detection = await detectOriginalAudioCuts(inputPath, info.duration, threshold, minSilence, padding);
    const cuts = detection.cuts;
    const finalSeconds = detection.finalSeconds;
    const removedSeconds = detection.removedSeconds;
    if (finalSeconds < 0.2) throw new Error('O corte ficou agressivo demais e removeria quase tudo. Reduza o volume de corte ou use Natural.');

    const outputName = 'SilencePro_' + safeBaseName(req.file.originalname) + '_MP4_limpo_' + crypto.randomUUID().slice(0, 8) + '.mp4';
    outputPath = path.join(OUTPUT_DIR, outputName);
    let rendered = await renderWithCuts(inputPath, outputPath, cuts, info.duration);

    // Proteção principal: nunca entregar arquivo só com áudio.
    // Se o modo rápido/copy gerar um MP4 sem vídeo por causa de codec/keyframe,
    // apaga e recria em modo HQ compatível, que sempre monta vídeo + áudio juntos.
    try {
      await ensureFinalHasVideo(outputPath);
    } catch (verifyErr) {
      console.warn('Verificação do MP4 falhou:', verifyErr.message);
      await fsp.unlink(outputPath).catch(() => {});
      await renderWithCutsReencode(inputPath, outputPath, cuts, info.duration);
      await ensureFinalHasVideo(outputPath);
      rendered = { mode: 'HQ compatível com vídeo garantido' };
    }

    const reductionPercent = Math.max(0, Math.round((1 - finalSeconds / info.duration) * 100));
    res.json({
      ok: true,
      fileName: outputName,
      downloadUrl: '/download/' + encodeURIComponent(outputName),
      originalSeconds: info.duration.toFixed(1),
      finalSeconds: finalSeconds.toFixed(1),
      reductionPercent,
      silenceCount: detection.silenceCount,
      cutCount: cuts.length,
      removedSeconds: removedSeconds.toFixed(2),
      mode: rendered.mode + ' + lógica original do áudio'
    });
  } catch (err) {
    if (outputPath) fsp.unlink(outputPath).catch(() => {});
    res.status(400).json({ ok: false, error: err.message || 'Erro ao processar vídeo.' });
  } finally {
    if (inputPath) fsp.unlink(inputPath).catch(() => {});
  }
}

app.post('/process', upload.single('video'), processVideo);
app.post('/api/process', upload.single('video'), processVideo);

app.get('/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).type('text').send('Arquivo expirou. Processe novamente.');
  res.download(full, file);
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: 'Vídeo muito grande para este Render. Limite atual: ' + MAX_UPLOAD_MB + ' MB.' });
  if (err) return res.status(400).json({ ok: false, error: err.message || 'Erro inesperado.' });
  next();
});

app.all('*', (req, res) => {
  if (req.method === 'GET') return res.type('html').send(INDEX_HTML);
  res.status(404).json({ ok: false, error: 'Rota não encontrada neste servidor.' });
});

app.listen(PORT, () => console.log('Silence Pro MP4 Smart HQ Original Logic rodando na porta ' + PORT));
