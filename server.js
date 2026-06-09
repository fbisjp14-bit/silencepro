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
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || '2';
// Desligado por padrão para evitar bug de repetição/gagueira causado por cortes sem reencode em keyframes.
const FAST_COPY_MODE = String(process.env.FAST_COPY_MODE || '0') === '1';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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

async function detectSilences(inputPath, thresholdDb, minSilenceSec) {
  // MODO EQUILIBRADO / PADRÃO ORIGINAL:
  // Usa exatamente a sensibilidade que vem do painel. Não força -25dB.
  // Isso evita detectar respirações muito pequenas como silêncio e gerar cortes demais.
  const effectiveThreshold = Math.max(-80, Math.min(-10, Number(thresholdDb) || -30));
  const effectiveMinSilence = Math.max(0.01, Math.min(3, Number(minSilenceSec) || 0.10));

  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', inputPath,
    '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000',
    '-af', 'highpass=f=80,lowpass=f=9000,silencedetect=n=' + effectiveThreshold + 'dB:d=' + effectiveMinSilence,
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
  const margin = Math.max(0, Math.min(0.25, Number(paddingSec) || 0));
  for (const s of ranges) {
    // Padrão mais fiel ao original:
    // o padding preserva um pequeno respiro antes/depois da fala, em vez de comer mais fala.
    // Isso reduz cortes extras e deixa o resultado menos picotado.
    const rawStart = Math.max(0, Math.min(max, Number(s.start)));
    const rawEnd = Math.max(0, Math.min(max, Number(s.end)));
    const rawLen = rawEnd - rawStart;
    let start = Math.max(0, Math.min(max, rawStart + margin));
    let end = Math.max(0, Math.min(max, rawEnd - margin));

    // Se o silêncio é curto, não cria corte minúsculo demais.
    // Cortes pequenos causam sensação de falha/chiado e aumentam o contador sem melhorar o vídeo.
    if (end - start >= 0.060) {
      cuts.push({ start, end });
    } else if (rawLen >= 0.140) {
      // fallback suave: remove só o miolo da pausa, preservando bordas naturais.
      const centerPad = Math.min(rawLen * 0.35, margin || 0.025);
      start = Math.max(0, rawStart + centerPad);
      end = Math.min(max, rawEnd - centerPad);
      if (end - start >= 0.060) cuts.push({ start, end });
    }
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
  return keep.filter(r => r.end - r.start >= 0.060);
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
      '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-threads', FFMPEG_THREADS, outputPath
    ]);
  } finally {
    fsp.unlink(filterPath).catch(() => {});
  }
}


async function renderDropSelect(inputPath, outputPath, cuts, duration) {
  // MODO ESTÁVEL:
  // Usa um único filtro select/aselect para evitar gráficos gigantes do FFmpeg.
  // Isso reduz travamentos em vídeos grandes ou com muitos cortes, mantendo reencode em CRF para preservar qualidade.
  const expr = buildDropExpression(cuts);
  await run('ffmpeg', [
    '-hide_banner', '-y', '-nostdin', '-i', inputPath,
    '-vf', `select='${expr}',setpts=N/FRAME_RATE/TB`,
    '-af', `aselect='${expr}',asetpts=N/SR/TB,aresample=async=1:first_pts=0,alimiter=limit=0.98`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', FFMPEG_PRESET, '-crf', FFMPEG_CRF,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-threads', FFMPEG_THREADS, outputPath
  ]);
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

  // Muitos cortes podem criar um filter_complex grande demais e fazer o Render parar.
  // Acima desse limite, usa o modo estável direto.
  if (cuts.length > Number(process.env.MAX_PRECISE_CUTS || 160)) {
    await renderDropSelect(inputPath, outputPath, cuts, duration);
    return { mode: 'stable-select' };
  }

  try {
    await renderPreciseSelect(inputPath, outputPath, cuts, duration);
    return { mode: 'precise-anti-gago-anti-chiado' };
  } catch (e) {
    // Fallback: se o FFmpeg travar no modo preciso, tenta o modo estável antes de desistir.
    fsp.unlink(outputPath).catch(() => {});
    await renderDropSelect(inputPath, outputPath, cuts, duration);
    return { mode: 'stable-fallback' };
  }
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

const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"pt-PT\" class=\"dark\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>Silence Pro by Leinad | Removedor de Silêncio</title>\n    <script src=\"https://cdn.tailwindcss.com\"></script>\n    <script src=\"https://unpkg.com/lucide@latest\"></script>\n    <!-- Motor LameJS para codificação real do MP3 -->\n    <script src=\"https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js\"></script>\n    <script>\n        tailwind.config = {\n            darkMode: 'class',\n            theme: {\n                extend: {\n                    colors: {\n                        gray: {\n                            850: '#1f2937',\n                            900: '#111827',\n                            950: '#030712',\n                        }\n                    }\n                }\n            }\n        }\n    </script>\n    <style>\n        ::-webkit-scrollbar { width: 8px; }\n        ::-webkit-scrollbar-track { background: #111827; }\n        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }\n        ::-webkit-scrollbar-thumb:hover { background: #4b5563; }\n        .glass-panel {\n            background: rgba(31, 41, 55, 0.7);\n            backdrop-filter: blur(10px);\n            border: 1px solid rgba(75, 85, 99, 0.4);\n        }\n    </style>\n</head>\n<body class=\"bg-gray-950 text-gray-100 min-h-screen flex flex-col font-sans selection:bg-blue-500 selection:text-white\">\n\n    <header class=\"border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50\">\n        <div class=\"max-w-5xl mx-auto px-4 h-16 flex items-center justify-between\">\n            <div class=\"flex items-center gap-3\">\n                <i data-lucide=\"scissors\" class=\"text-blue-500 w-6 h-6\"></i>\n                <div class=\"flex items-center\">\n                    <span class=\"font-bold text-xl tracking-tight\">Silence <span class=\"text-blue-500\">Pro</span></span>\n                    <span class=\"ml-3 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full border border-gray-700 shadow-sm\">by Leinad</span>\n                </div>\n            </div>\n            <div class=\"text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block\">Motor MP3 + Zero-Crossing Otimizado</div>\n        </div>\n    </header>\n\n    <main class=\"flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6\">\n        \n        <div class=\"md:col-span-1 space-y-6\">\n            \n            <div id=\"drop-zone\" class=\"glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden\">\n                <input type=\"file\" id=\"audio-input\" accept=\"video/*,.mp4,.mov,.webm,.mkv\" class=\"absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10\">\n                <div class=\"flex flex-col items-center gap-3 pointer-events-none\">\n                    <div class=\"w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform\">\n                        <i data-lucide=\"upload-cloud\" class=\"text-blue-400 w-6 h-6\"></i>\n                    </div>\n                    <div>\n                        <p class=\"font-medium text-gray-200\">Arraste o seu áudio</p>\n                        <p class=\"text-xs text-gray-400 mt-1\">ou toque para procurar</p>\n                        <div class=\"mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2\">\n                            <p>MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG e FLAC.</p>\n                        </div>\n                    </div>\n                </div>\n                <div id=\"file-info\" class=\"hidden mt-4 pt-4 border-t border-gray-700 text-sm text-left\">\n                    <div class=\"flex items-center gap-2 text-green-400 mb-1\">\n                        <i data-lucide=\"check-circle\" class=\"w-4 h-4\"></i>\n                        <span class=\"font-medium truncate\" id=\"file-name\">processando...</span>\n                    </div>\n                    <span class=\"text-gray-400 text-xs\" id=\"file-size\">0 MB</span>\n                </div>\n            </div>\n\n            <div class=\"glass-panel rounded-2xl p-6 space-y-5\">\n                <div class=\"flex items-center justify-between mb-2\">\n                    <h3 class=\"font-semibold text-lg flex items-center gap-2\">\n                        <i data-lucide=\"sliders\" class=\"w-5 h-5 text-gray-400\"></i>\n                        Ajustes de Corte\n                    </h3>\n                </div>\n\n                <div class=\"space-y-3 pb-4 border-b border-gray-800\">\n                    <label class=\"text-sm text-gray-300 font-medium\">Estratégia de Retenção</label>\n                    <div class=\"grid grid-cols-3 gap-2\">\n                        <button type=\"button\" id=\"preset-extremo\" class=\"py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center\">\n                            <span>🚀 Extremo</span>\n                            <span class=\"font-normal text-[9px] text-gray-200\">(Corte seco)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-agressivo\" class=\"py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900\">\n                            <span>🔥 Viral Max</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Liso, sem ruído)</span>\n                        </button>\n                        <button type=\"button\" id=\"preset-natural\" class=\"py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center\">\n                            <span>🎙️ Natural</span>\n                            <span class=\"font-normal text-[9px] text-gray-300\">(Podcast)</span>\n                        </button>\n                    </div>\n                </div>\n\n                <div class=\"space-y-2 pt-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Volume de corte (dB)</label>\n                        <span id=\"threshold-val\" class=\"font-mono text-blue-400\">-30 dB</span>\n                    </div>\n                    <input type=\"range\" id=\"threshold\" min=\"-80\" max=\"-10\" value=\"-30\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n\n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Silêncio mínimo (seg)</label>\n                        <span id=\"duration-val\" class=\"font-mono text-blue-400\">0.10s</span>\n                    </div>\n                    <input type=\"range\" id=\"duration\" min=\"0.01\" max=\"3\" step=\"0.01\" value=\"0.10\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n                \n                <div class=\"space-y-2\">\n                    <div class=\"flex justify-between text-sm\">\n                        <label class=\"text-gray-300\">Margem natural (seg)</label>\n                        <span id=\"padding-val\" class=\"font-mono text-blue-400\">0.05s</span>\n                    </div>\n                    <input type=\"range\" id=\"padding\" min=\"0\" max=\"0.5\" step=\"0.01\" value=\"0.05\" class=\"w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500\">\n                </div>\n            </div>\n\n            <button id=\"process-btn\" disabled class=\"w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]\">\n                <i data-lucide=\"zap\" class=\"w-5 h-5\"></i>\n                Remover Silêncios\n            </button>\n        </div>\n\n        <div class=\"md:col-span-2 flex flex-col gap-6\">\n            \n            <div class=\"glass-panel rounded-2xl p-6 flex-1 flex flex-col relative\">\n                <h3 class=\"font-semibold text-lg flex items-center gap-2 mb-4\">\n                    <i data-lucide=\"activity\" class=\"w-5 h-5 text-gray-400\"></i>\n                    Estado do Processamento\n                </h3>\n                \n                <div id=\"log-container\" class=\"flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2\">\n                    <div class=\"text-gray-600\">A aguardar áudio...</div>\n                </div>\n\n                <div id=\"loading-overlay\" class=\"hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10\">\n                    <div class=\"relative w-20 h-20 mb-4\">\n                        <div class=\"absolute inset-0 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin\"></div>\n                        <div id=\"progress-percent\" class=\"absolute inset-0 flex items-center justify-center text-sm font-black text-white\">0%</div>\n                    </div>\n                    <p class=\"font-medium text-lg animate-pulse\" id=\"loading-text\">Removendo silêncios...</p>\n                    <p class=\"text-xs text-blue-300 mt-2 font-mono\" id=\"eta-text\">Tempo estimado: calculando...</p>\n                </div>\n            </div>\n\n            <div id=\"result-panel\" class=\"glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]\">\n                <div class=\"flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4\">\n                    <div class=\"text-center sm:text-left\">\n                        <h3 class=\"font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1\">\n                            <i data-lucide=\"party-popper\" class=\"w-6 h-6\"></i>\n                            MP3 Pronto a Usar!\n                        </h3>\n                        <p class=\"text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1\" id=\"result-stats\">Calculando redução...</p>\n                    </div>\n                    \n                    <a id=\"download-btn\" href=\"#\" download=\"video_viral_limpo.mp4\" class=\"w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer\">\n                        <i data-lucide=\"download\" class=\"w-6 h-6\"></i>\n                        BAIXAR MP4\n                    </a>\n                </div>\n                <div class=\"mt-6 pt-4 border-t border-gray-700\">\n                    <video id=\"audio-preview\" controls class=\"w-full rounded-lg bg-black max-h-[430px]\"></video>\n                </div>\n            </div>\n\n        </div>\n    </main>\n\n    <footer class=\"w-full text-center pb-8 pt-4\">\n        <p class=\"text-[11px] text-gray-500 font-medium tracking-widest uppercase\">\"Que Ele cresça e eu diminua.\" <span class=\"text-gray-600 ml-1\">- João 3:30</span></p>\n    </footer>\n\n    <script>\n        lucide.createIcons();\n\n        const fileInput = document.getElementById('audio-input');\n        const dropZone = document.getElementById('drop-zone');\n        const fileNameEl = document.getElementById('file-name');\n        const fileSizeEl = document.getElementById('file-size');\n        const fileInfoEl = document.getElementById('file-info');\n        const processBtn = document.getElementById('process-btn');\n        const thresholdInput = document.getElementById('threshold');\n        const durationInput = document.getElementById('duration');\n        const paddingInput = document.getElementById('padding');\n        const thresholdVal = document.getElementById('threshold-val');\n        const durationVal = document.getElementById('duration-val');\n        const paddingVal = document.getElementById('padding-val');\n        const logContainer = document.getElementById('log-container');\n        const loadingOverlay = document.getElementById('loading-overlay');\n        const progressPercent = document.getElementById('progress-percent');\n        const etaText = document.getElementById('eta-text');\n        const resultPanel = document.getElementById('result-panel');\n        const resultStats = document.getElementById('result-stats');\n        const downloadBtn = document.getElementById('download-btn');\n        const audioPreview = document.getElementById('audio-preview');\n        const presetExtremo = document.getElementById('preset-extremo');\n        const presetAgressivo = document.getElementById('preset-agressivo');\n        const presetNatural = document.getElementById('preset-natural');\n\n        let currentFile = null;\n        let progressTimer = null;\n        let progressStartedAt = 0;\n        let estimatedTotalSeconds = 120;\n\n        function updateSliderUI() {\n            thresholdVal.textContent = `${thresholdInput.value} dB`;\n            durationVal.textContent = `${parseFloat(durationInput.value).toFixed(2)}s`;\n            paddingVal.textContent = `${parseFloat(paddingInput.value).toFixed(2)}s`;\n        }\n        thresholdInput.addEventListener('input', updateSliderUI);\n        durationInput.addEventListener('input', updateSliderUI);\n        paddingInput.addEventListener('input', updateSliderUI);\n\n        function resetButtons() {\n            [presetExtremo, presetAgressivo, presetNatural].forEach(btn => {\n                btn.className = 'py-2 px-1 bg-gray-800 rounded-lg text-xs font-bold transition-colors border border-gray-700 flex flex-col items-center justify-center text-center';\n            });\n        }\n        presetExtremo.addEventListener('click', () => {\n            resetButtons();\n            presetExtremo.className = 'py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -30;\n            durationInput.value = 0.04;\n            paddingInput.value = 0.02;\n            updateSliderUI();\n            log('Modo Extremo ativado.', 'info');\n        });\n        presetAgressivo.addEventListener('click', () => {\n            resetButtons();\n            presetAgressivo.className = 'py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -30;\n            durationInput.value = 0.10;\n            paddingInput.value = 0.05;\n            updateSliderUI();\n            log('Modo Viral Max ativado.', 'info');\n        });\n        presetNatural.addEventListener('click', () => {\n            resetButtons();\n            presetNatural.className = 'py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900';\n            thresholdInput.value = -40;\n            durationInput.value = 0.30;\n            paddingInput.value = 0.05;\n            updateSliderUI();\n            log('Modo Natural (Podcast) ativado.', 'info');\n        });\n\n        function log(msg, type = 'info') {\n            const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-gray-300', warn: 'text-gray-300' };\n            if (logContainer.innerHTML.includes('A aguardar')) logContainer.innerHTML = '';\n            const time = new Date().toLocaleTimeString('pt-PT', { hour12: false });\n            const line = document.createElement('div');\n            line.className = colors[type] || colors.info;\n            line.textContent = `[${time}] ${msg}`;\n            logContainer.appendChild(line);\n            logContainer.scrollTop = logContainer.scrollHeight;\n        }\n\n        function handleFile(file) {\n            if (!file) return;\n            const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];\n            const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';\n            const isVideo = file.type.startsWith('video/') || validVideoExts.includes(ext);\n            if (!isVideo) {\n                log('Formato não aceito. Esta versão aceita vídeo: MP4, MOV, WEBM ou MKV.', 'error');\n                return;\n            }\n            currentFile = file;\n            fileNameEl.textContent = file.name;\n            fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';\n            fileInfoEl.classList.remove('hidden');\n            processBtn.disabled = false;\n            resultPanel.classList.add('hidden');\n            audioPreview.removeAttribute('src');\n            log(`Processando: ${file.name}`, 'info');\n        }\n\n        fileInput.addEventListener('click', (e) => { e.target.value = ''; });\n        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));\n        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });\n        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });\n\n        function formatEta(seconds) {\n            const s = Math.max(0, Math.round(seconds));\n            const m = Math.floor(s / 60);\n            const r = s % 60;\n            if (m <= 0) return `${r}s`;\n            return `${m} min ${String(r).padStart(2, '0')}s`;\n        }\n\n        function setProgress(percent) {\n            const safe = Math.max(0, Math.min(100, Math.round(percent)));\n            if (progressPercent) progressPercent.textContent = `${safe}%`;\n        }\n\n        function startProgress(fileSize) {\n            clearInterval(progressTimer);\n            progressStartedAt = Date.now();\n            const mb = fileSize ? fileSize / (1024 * 1024) : 100;\n            estimatedTotalSeconds = Math.max(45, Math.min(420, Math.round(40 + (mb * 0.35))));\n            setProgress(0);\n            if (etaText) etaText.textContent = `Tempo estimado: ${formatEta(estimatedTotalSeconds)}`;\n\n            progressTimer = setInterval(() => {\n                const elapsed = (Date.now() - progressStartedAt) / 1000;\n                const ratio = Math.min(0.98, elapsed / estimatedTotalSeconds);\n                const percent = Math.min(92, Math.round(92 * (1 - Math.pow(1 - ratio, 1.8))));\n                setProgress(percent);\n                const remaining = Math.max(5, estimatedTotalSeconds - elapsed);\n                if (etaText) etaText.textContent = `Tempo estimado: ${formatEta(remaining)}`;\n            }, 650);\n        }\n\n        function finishProgress() {\n            clearInterval(progressTimer);\n            setProgress(100);\n            if (etaText) etaText.textContent = 'Tempo estimado: finalizando...';\n        }\n\n        function stopProgress() {\n            clearInterval(progressTimer);\n        }\n\n        function friendlyErrorMessage(error, data) {\n            const msg = String((data && data.error) || (error && error.message) || '').trim();\n            const code = data && data.code;\n            if (code === 'NO_CUTS' || /silêncios suficientes|silencios suficientes|não foram encontrados cortes/i.test(msg)) {\n                return 'Esse vídeo já parece estar sem pausas suficientes para cortar. Use Extremo ou aumente a sensibilidade e tente novamente.';\n            }\n            if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg) || (error && error.name === 'TypeError')) {\n                return 'O servidor demorou mais que o normal. Aguarde alguns segundos e toque em Remover Silêncios novamente.';\n            }\n            if (/backend não respondeu JSON|Unexpected token|JSON/i.test(msg)) {\n                return 'O servidor ainda está preparando o processamento. Aguarde alguns segundos e tente novamente.';\n            }\n            if (/file size|LIMIT_FILE_SIZE|muito grande/i.test(msg)) {\n                return msg || 'Esse vídeo está muito grande para o servidor atual.';\n            }\n            if (/áudio|audio|duração|video|vídeo|formato|agressivo/i.test(msg)) return msg;\n            return 'O processamento demorou mais que o normal. Aguarde alguns segundos e tente novamente.';\n        }\n\n        async function waitForJob(jobId) {\n            let temporaryFailures = 0;\n            while (true) {\n                try {\n                    const res = await fetch('/status/' + encodeURIComponent(jobId), { cache: 'no-store' });\n                    const job = await res.json().catch(() => null);\n                    if (!res.ok || !job || !job.ok) {\n                        temporaryFailures++;\n                        if (temporaryFailures < 30) {\n                            if (etaText) etaText.textContent = 'Tempo estimado: finalizando...';\n                            await new Promise(resolve => setTimeout(resolve, 2000));\n                            continue;\n                        }\n                        throw new Error((job && job.error) || 'O processamento demorou mais que o normal.');\n                    }\n                    temporaryFailures = 0;\n\n                    if (typeof job.progress === 'number') setProgress(job.progress);\n                    if (etaText) {\n                        if (job.status === 'done') etaText.textContent = 'Tempo estimado: pronto';\n                        else if (job.eta) etaText.textContent = `Tempo estimado: ${job.eta}`;\n                    }\n\n                    if (job.status === 'done') return job;\n                    if (job.status === 'error') {\n                        const err = new Error(job.error || 'O processamento demorou mais que o normal.');\n                        err.job = job;\n                        throw err;\n                    }\n                } catch (e) {\n                    temporaryFailures++;\n                    if (temporaryFailures < 30) {\n                        if (etaText) etaText.textContent = 'Tempo estimado: finalizando...';\n                        await new Promise(resolve => setTimeout(resolve, 2000));\n                        continue;\n                    }\n                    throw e;\n                }\n                await new Promise(resolve => setTimeout(resolve, 1500));\n            }\n        }\n\n        processBtn.addEventListener('click', async () => {\n            if (!currentFile) return;\n            loadingOverlay.classList.remove('hidden');\n            loadingOverlay.classList.add('flex');\n            processBtn.disabled = true;\n            logContainer.innerHTML = '';\n            resultPanel.classList.add('hidden');\n\n            try {\n                startProgress(currentFile.size);\n                log('Removendo silêncios...', 'info');\n                const form = new FormData();\n                form.append('video', currentFile);\n                form.append('threshold', thresholdInput.value);\n                form.append('duration', durationInput.value);\n                form.append('padding', paddingInput.value);\n\n                const res = await fetch('/process', { method: 'POST', body: form });\n                const contentType = res.headers.get('content-type') || '';\n                if (!contentType.includes('application/json')) {\n                    const text = await res.text();\n                    throw new Error('O servidor ainda está preparando o processamento.');\n                }\n                const startData = await res.json();\n                if (!res.ok || !startData.ok) {\n                    const friendly = friendlyErrorMessage(null, startData);\n                    log(friendly, 'info');\n                    return;\n                }\n\n                stopProgress();\n                const data = startData.jobId ? await waitForJob(startData.jobId) : startData;\n                finishProgress();\n\n                log(`Silêncios detectados: ${data.silenceCount}`, 'success');\n                log(`Cortes aplicados no vídeo: ${data.cutCount}`, 'success');\n                log('Pronto! Processando embalado a vácuo.', 'success');\n\n                downloadBtn.href = data.downloadUrl;\n                downloadBtn.download = data.fileName || 'SilencePro_video_limpo.mp4';\n                audioPreview.src = data.downloadUrl;\n                resultStats.textContent = `Original: ${data.originalSeconds}s | Limpo: ${data.finalSeconds}s | Redução: ${data.reductionPercent}%`;\n                resultPanel.classList.remove('hidden');\n            } catch (error) {\n                const data = error && error.job ? error.job : null;\n                log(friendlyErrorMessage(error, data), 'info');\n            } finally {\n                stopProgress();\n                loadingOverlay.classList.add('hidden');\n                loadingOverlay.classList.remove('flex');\n                processBtn.disabled = false;\n            }\n        });\n    </script>\n</body>\n</html>\n";


const JOBS = new Map();
const JOB_TTL_MS = 1000 * 60 * 60;
const PROCESS_QUEUE = [];
let queueRunning = false;

function updateQueuePositions() {
  PROCESS_QUEUE.forEach((job, index) => {
    setJob(job.jobId, {
      status: 'queued',
      progress: 1,
      eta: 'aguardando...',
      message: index === 0 ? 'Aguardando o processamento atual terminar...' : 'Na fila de processamento...'
    });
  });
}

function enqueueVideoJob(job) {
  PROCESS_QUEUE.push(job);
  updateQueuePositions();
  setImmediate(runNextQueuedJob);
}

async function runNextQueuedJob() {
  if (queueRunning) return;
  const job = PROCESS_QUEUE.shift();
  updateQueuePositions();
  if (!job) return;

  queueRunning = true;
  try {
    await processVideoJob(job.jobId, job.inputPath, job.originalName, job.fileSize, job.threshold, job.minSilence, job.padding);
  } finally {
    queueRunning = false;
    setImmediate(runNextQueuedJob);
  }
}


function setJob(jobId, patch) {
  const old = JOBS.get(jobId) || {};
  JOBS.set(jobId, { ...old, ...patch, updatedAt: Date.now() });
}

function friendlyServerError(err) {
  const msg = String(err && err.message ? err.message : 'Processamento interrompido.');
  const code = err && err.code ? err.code : 'PROCESS_ERROR';
  if (code === 'NO_CUTS' || /silêncios suficientes|silencios suficientes|não foram encontrados cortes/i.test(msg)) {
    return { code: 'NO_CUTS', error: 'Esse vídeo já parece estar sem pausas suficientes para cortar. Use Extremo ou aumente a sensibilidade e tente novamente.' };
  }
  if (/agressivo|removeria/i.test(msg)) {
    return { code: 'TOO_AGGRESSIVE', error: 'O corte ficou agressivo demais e removeria quase tudo. Use Viral Max ou Natural, ou aumente a margem natural.' };
  }
  if (/não tem áudio|nao tem audio|sem áudio|sem audio/i.test(msg)) {
    return { code: 'NO_AUDIO', error: 'Esse vídeo não tem áudio. Para remover cenas de silêncio, o áudio precisa existir.' };
  }
  if (/duração|duracao/i.test(msg)) {
    return { code: 'BAD_DURATION', error: 'A duração desse vídeo não foi lida corretamente. Tente converter para MP4 e enviar novamente.' };
  }
  if (/Invalid data|moov atom|corrupt|End of file/i.test(msg)) {
    return { code: 'BAD_FILE', error: 'Esse vídeo parece estar corrompido ou incompleto. Tente exportar novamente e enviar outro arquivo.' };
  }
  return { code, error: 'O processamento demorou mais que o normal. Tente novamente em alguns segundos.' };
}

function etaFromProgress(startedAt, progress) {
  const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
  const p = Math.max(1, Math.min(99, Number(progress) || 1));
  const total = elapsed / (p / 100);
  const remaining = Math.max(1, total - elapsed);
  const m = Math.floor(remaining / 60);
  const s = Math.round(remaining % 60);
  if (p >= 92) return 'finalizando...';
  if (m <= 0) return `${s}s`;
  return `${m} min ${String(s).padStart(2, '0')}s`;
}

async function processVideoJob(jobId, inputPath, originalName, fileSize, threshold, minSilence, padding) {
  let outputPath = null;
  let renderTimer = null;
  const startedAt = Date.now();
  try {
    setJob(jobId, { status: 'processing', progress: 3, message: 'Removendo silêncios...', eta: 'calculando...' });

    const info = await probe(inputPath);
    setJob(jobId, { progress: 10, eta: etaFromProgress(startedAt, 10) });
    if (!info.hasVideo) throw new Error('O arquivo enviado não tem vídeo.');
    if (!info.hasAudio) throw new Error('Este vídeo não tem áudio. O corte das cenas precisa do áudio como guia.');
    if (!info.duration || !Number.isFinite(info.duration)) throw new Error('A duração desse vídeo não foi lida corretamente.');

    const detected = await detectSilences(inputPath, threshold, minSilence);
    setJob(jobId, { progress: 24, eta: etaFromProgress(startedAt, 24) });

    const cuts = buildCutRanges(info.duration, detected.silences, detected.openSilenceStart, padding);
    if (!cuts.length) {
      const e = new Error('Esse vídeo já parece estar sem pausas suficientes para cortar. Use Extremo ou aumente a sensibilidade e tente novamente.');
      e.code = 'NO_CUTS';
      throw e;
    }

    const finalSeconds = finalSecondsAfterCuts(info.duration, cuts);
    if (finalSeconds < 0.2) {
      const e = new Error('O corte ficou agressivo demais e removeria quase tudo. Reduza o volume de corte ou use Natural.');
      e.code = 'TOO_AGGRESSIVE';
      throw e;
    }

    const outputName = 'SilencePro_' + safeBaseName(originalName) + '_MP4_limpo_' + crypto.randomUUID().slice(0, 8) + '.mp4';
    outputPath = path.join(OUTPUT_DIR, outputName);
    setJob(jobId, { progress: 30, eta: etaFromProgress(startedAt, 30) });

    const mb = fileSize ? fileSize / (1024 * 1024) : 100;
    const renderEstimateMs = Math.max(90000, Math.min(900000, (70 + mb * 0.9) * 1000));
    const renderStartedAt = Date.now();
    renderTimer = setInterval(() => {
      const elapsed = Date.now() - renderStartedAt;
      const ratio = Math.min(0.995, elapsed / renderEstimateMs);
      const progress = Math.min(97, 30 + Math.round(67 * (1 - Math.pow(1 - ratio, 1.55))));
      setJob(jobId, { progress, eta: etaFromProgress(startedAt, progress), message: 'Removendo silêncios...' });
    }, 1200);

    const renderResult = await renderWithCuts(inputPath, outputPath, cuts, info.duration);
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = null;
    setJob(jobId, { progress: 98, eta: 'finalizando...' });

    const outInfo = await probe(outputPath).catch(() => null);
    const realFinalSeconds = outInfo && outInfo.duration ? outInfo.duration : finalSeconds;
    const reductionPercent = Math.max(0, Math.round((1 - realFinalSeconds / info.duration) * 100));
    setJob(jobId, {
      status: 'done',
      progress: 100,
      eta: 'pronto',
      message: 'Pronto para baixar.',
      fileName: outputName,
      downloadUrl: '/download/' + encodeURIComponent(outputName),
      originalSeconds: info.duration.toFixed(1),
      finalSeconds: realFinalSeconds.toFixed(1),
      reductionPercent,
      silenceCount: detected.silences.length + (detected.openSilenceStart !== null ? 1 : 0),
      cutCount: cuts.length,
      renderMode: renderResult && renderResult.mode ? renderResult.mode : 'ok'
    });
  } catch (err) {
    if (renderTimer) clearInterval(renderTimer);
    if (outputPath) fsp.unlink(outputPath).catch(() => {});
    const friendly = friendlyServerError(err);
    setJob(jobId, { status: 'error', progress: 0, eta: '', message: friendly.error, code: friendly.code, error: friendly.error });
  } finally {
    if (inputPath) fsp.unlink(inputPath).catch(() => {});
  }
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'Silence Pro MP4', ffmpeg: true }));
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

app.post('/process', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Nenhum vídeo foi enviado.');
    const threshold = Math.max(-80, Math.min(-10, Number(req.body.threshold || -30)));
    const minSilence = Math.max(0.01, Math.min(3, Number(req.body.duration || 0.10)));
    const padding = Math.max(0, Math.min(0.5, Number(req.body.padding || 0.05)));
    const jobId = crypto.randomUUID();
    JOBS.set(jobId, {
      ok: true,
      jobId,
      status: 'queued',
      progress: 1,
      eta: 'aguardando...',
      message: 'Na fila de processamento...',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    res.json({ ok: true, jobId, statusUrl: '/status/' + encodeURIComponent(jobId) });
    enqueueVideoJob({
      jobId,
      inputPath: req.file.path,
      originalName: req.file.originalname,
      fileSize: req.file.size,
      threshold,
      minSilence,
      padding
    });
  } catch (err) {
    const friendly = friendlyServerError(err);
    res.status(400).json({ ok: false, code: friendly.code, error: friendly.error });
  }
});

app.get('/status/:jobId', (req, res) => {
  const jobId = String(req.params.jobId || '');
  const job = JOBS.get(jobId);
  if (!job) return res.status(404).json({ ok: false, code: 'JOB_NOT_FOUND', error: 'Esse processamento ficou aberto por muito tempo. Envie o vídeo novamente.' });
  res.json({ ok: true, ...job });
});

app.get('/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send('Arquivo ficou disponível por tempo limitado. Processe novamente.');

  res.download(full, file, (err) => {
    if (err) {
      console.error('Falha ao entregar download:', err.message);
      return;
    }

    fs.unlink(full, (unlinkErr) => {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error('Falha ao apagar arquivo baixado:', unlinkErr.message);
      }
    });
  });
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, code: 'LIMIT_FILE_SIZE', error: 'Vídeo muito grande para este Render. Limite atual: ' + MAX_UPLOAD_MB + ' MB.' });
  if (err) return res.status(400).json({ ok: false, code: err.code || 'REQUEST_ERROR', error: 'Solicitação não aceita. Confira o arquivo e tente novamente.' });
  next();
});

app.listen(PORT, () => console.log('Silence Pro MP4 rodando na porta ' + PORT));
