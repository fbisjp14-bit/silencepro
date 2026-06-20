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
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 700);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '-' + safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = ['.mp4', '.mov', '.webm', '.mkv'];
    if ((file.mimetype || '').startsWith('video/') || allowed.includes(ext)) return cb(null, true);
    cb(new Error('Formato inválido. Envie vídeo MP4, MOV, WEBM ou MKV.'));
  }
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error((stderr || stdout || 'Erro desconhecido').slice(-5000));
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function probe(inputPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath
  ]);
  const data = JSON.parse(stdout);
  const duration = Number(data.format && data.format.duration ? data.format.duration : 0);
  const hasAudio = (data.streams || []).some(s => s.codec_type === 'audio');
  const hasVideo = (data.streams || []).some(s => s.codec_type === 'video');
  return { duration, hasAudio, hasVideo };
}

async function detectSilences(inputPath, thresholdDb, minSilenceSec) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-i', inputPath,
    '-vn',
    '-af', 'silencedetect=n=' + thresholdDb + 'dB:d=' + minSilenceSec,
    '-f', 'null',
    '-'
  ]);

  const silences = [];
  let currentStart = null;
  const lines = stderr.split(/\r?\n/);

  for (const line of lines) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) currentStart = Number(start[1]);

    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && currentStart !== null) {
      silences.push({ start: currentStart, end: Number(end[1]) });
      currentStart = null;
    }
  }

  return { silences, openSilenceStart: currentStart };
}

function buildKeepSegments(duration, silences, openSilenceStart, paddingSec) {
  const segments = [];
  let currentKeepStart = 0;

  const safeDuration = Math.max(0, duration || 0);
  const allSilences = [...silences];
  if (openSilenceStart !== null && openSilenceStart !== undefined) {
    allSilences.push({ start: openSilenceStart, end: safeDuration });
  }

  for (const s of allSilences) {
    const silenceStart = Math.max(0, Math.min(s.start, safeDuration));
    const silenceEnd = Math.max(0, Math.min(s.end, safeDuration));
    if (silenceEnd <= silenceStart) continue;

    const start = Math.max(0, currentKeepStart - paddingSec);
    const end = Math.min(safeDuration, silenceStart + paddingSec);
    if (end - start >= 0.035) segments.push({ start, end });
    currentKeepStart = silenceEnd;
  }

  const finalStart = Math.max(0, currentKeepStart - paddingSec);
  if (safeDuration - finalStart >= 0.035) segments.push({ start: finalStart, end: safeDuration });

  const merged = [];
  for (const seg of segments) {
    if (!merged.length || seg.start > merged[merged.length - 1].end + 0.015) {
      merged.push({ start: seg.start, end: seg.end });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    }
  }

  return merged.filter(seg => seg.end > seg.start && seg.end - seg.start >= 0.035);
}

async function renderSegments(inputPath, outputPath, segments) {
  if (!segments.length) throw new Error('O áudio ficou sem blocos de fala detectáveis. Reduza o volume de corte ou use o modo Natural.');

  const scriptPath = path.join(ROOT_TMP, crypto.randomUUID() + '-filter.txt');
  const parts = [];

  segments.forEach((seg, index) => {
    const start = seg.start.toFixed(3);
    const end = seg.end.toFixed(3);
    parts.push('[0:v]trim=start=' + start + ':end=' + end + ',setpts=PTS-STARTPTS[v' + index + ']');
    parts.push('[0:a]atrim=start=' + start + ':end=' + end + ',asetpts=PTS-STARTPTS[a' + index + ']');
  });

  let concatInputs = '';
  for (let i = 0; i < segments.length; i++) concatInputs += '[v' + i + '][a' + i + ']';
  parts.push(concatInputs + 'concat=n=' + segments.length + ':v=1:a=1[outv][outa]');

  await fsp.writeFile(scriptPath, parts.join(';\n'), 'utf8');

  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-nostdin',
      '-i', inputPath,
      '-filter_complex_script', scriptPath,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      outputPath
    ]);
  } finally {
    fsp.unlink(scriptPath).catch(() => {});
  }
}

async function normalizeOnly(inputPath, outputPath) {
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostdin',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath
  ]);
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

function page() {
  return `<!DOCTYPE html>
<html lang="pt-PT" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Silence Pro by Leinad | Removedor de Silêncio em Vídeo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { colors: { gray: { 850: '#1f2937', 900: '#111827', 950: '#030712' } } } }
    };
  </script>
  <style>
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #111827; }
    ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
    .glass-panel { background: rgba(31, 41, 55, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(75, 85, 99, 0.4); }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen flex flex-col font-sans selection:bg-blue-500 selection:text-white">
  <header class="border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50">
    <div class="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <i data-lucide="scissors" class="text-blue-500 w-6 h-6"></i>
        <div class="flex items-center">
          <span class="font-bold text-xl tracking-tight">Silence <span class="text-blue-500">Pro</span></span>
          <span class="ml-3 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full border border-gray-700 shadow-sm">by Leinad</span>
        </div>
      </div>
      <div class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block">Motor MP4 + FFmpeg + Cortes por Áudio</div>
    </div>
  </header>

  <main class="flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="md:col-span-1 space-y-6">
      <div id="drop-zone" class="glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden">
        <input type="file" id="video-input" accept="video/*,.mp4,.mov,.webm,.mkv" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
        <div class="flex flex-col items-center gap-3 pointer-events-none">
          <div class="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform">
            <i data-lucide="upload-cloud" class="text-blue-400 w-6 h-6"></i>
          </div>
          <div>
            <p class="font-medium text-gray-200">Arraste o seu vídeo</p>
            <p class="text-xs text-gray-400 mt-1">ou toque para procurar</p>
            <div class="mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2">
              <p>MP4, MOV, WEBM e MKV.</p>
              <p class="mt-1 text-blue-300">O corte do vídeo obedece o silêncio do áudio.</p>
            </div>
          </div>
        </div>
        <div id="file-info" class="hidden mt-4 pt-4 border-t border-gray-700 text-sm text-left">
          <div class="flex items-center gap-2 text-green-400 mb-1">
            <i data-lucide="check-circle" class="w-4 h-4"></i>
            <span class="font-medium truncate" id="file-name">processando...</span>
          </div>
          <span class="text-gray-400 text-xs" id="file-size">0 MB</span>
        </div>
      </div>

      <div class="glass-panel rounded-2xl p-6 space-y-5">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-semibold text-lg flex items-center gap-2"><i data-lucide="sliders" class="w-5 h-5 text-gray-400"></i>Ajustes de Corte</h3>
        </div>

        <div class="space-y-3 pb-4 border-b border-gray-800">
          <label class="text-sm text-gray-300 font-medium">Estratégia de Retenção</label>
          <div class="grid grid-cols-3 gap-2">
            <button type="button" id="preset-extremo" class="py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center">
              <span>🚀 Extremo</span><span class="font-normal text-[9px] text-gray-200">(Corte seco)</span>
            </button>
            <button type="button" id="preset-agressivo" class="py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900">
              <span>🔥 Viral Max</span><span class="font-normal text-[9px] text-gray-300">(Padrão)</span>
            </button>
            <button type="button" id="preset-natural" class="py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center">
              <span>🎙️ Natural</span><span class="font-normal text-[9px] text-gray-300">(Podcast)</span>
            </button>
          </div>
        </div>

        <div class="space-y-2 pt-2">
          <div class="flex justify-between text-sm"><label class="text-gray-300">Volume de corte (dB)</label><span id="threshold-val" class="font-mono text-blue-400">-30 dB</span></div>
          <input type="range" id="threshold" min="-80" max="-10" value="-30" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
        </div>
        <div class="space-y-2">
          <div class="flex justify-between text-sm"><label class="text-gray-300">Silêncio mínimo (seg)</label><span id="duration-val" class="font-mono text-blue-400">0.10s</span></div>
          <input type="range" id="duration" min="0.01" max="3" step="0.01" value="0.10" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
        </div>
        <div class="space-y-2">
          <div class="flex justify-between text-sm"><label class="text-gray-300">Margem natural (seg)</label><span id="padding-val" class="font-mono text-blue-400">0.05s</span></div>
          <input type="range" id="padding" min="0" max="0.5" step="0.01" value="0.05" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
        </div>
      </div>

      <button id="process-btn" disabled class="w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]">
        <i data-lucide="zap" class="w-5 h-5"></i> Remover Silêncios do Vídeo
      </button>
    </div>

    <div class="md:col-span-2 flex flex-col gap-6">
      <div class="glass-panel rounded-2xl p-6 flex-1 flex flex-col relative">
        <h3 class="font-semibold text-lg flex items-center gap-2 mb-4"><i data-lucide="activity" class="w-5 h-5 text-gray-400"></i>Estado do Processamento</h3>
        <div id="log-container" class="flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2"><div class="text-gray-600">A aguardar vídeo...</div></div>
        <div id="loading-overlay" class="hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10 px-6 text-center">
          <div class="w-16 h-16 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin mb-4"></div>
          <p class="font-medium text-lg animate-pulse" id="loading-text">Cortando vídeo pelo áudio...</p>
          <p class="text-xs text-gray-400 mt-2">Não feche a página até o MP4 ficar pronto.</p>
        </div>
      </div>

      <div id="result-panel" class="glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
        <div class="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4">
          <div class="text-center sm:text-left">
            <h3 class="font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1"><i data-lucide="party-popper" class="w-6 h-6"></i>MP4 Pronto a Usar!</h3>
            <p class="text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1" id="result-stats">Calculando redução...</p>
          </div>
          <a id="download-btn" href="#" download="SilencePro_video_limpo.mp4" class="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer">
            <i data-lucide="download" class="w-6 h-6"></i> BAIXAR MP4
          </a>
        </div>
        <div class="mt-6 pt-4 border-t border-gray-700">
          <video id="video-preview" controls class="w-full rounded-lg bg-black max-h-[430px]"></video>
        </div>
      </div>
    </div>
  </main>

  <footer class="w-full text-center pb-8 pt-4">
    <p class="text-[11px] text-gray-500 font-medium tracking-widest uppercase">"Que Ele cresça e eu diminua." <span class="text-gray-600 ml-1">- João 3:30</span></p>
  </footer>

  <script>
    lucide.createIcons();
    const fileInput = document.getElementById('video-input');
    const dropZone = document.getElementById('drop-zone');
    const fileNameEl = document.getElementById('file-name');
    const fileSizeEl = document.getElementById('file-size');
    const fileInfoEl = document.getElementById('file-info');
    const processBtn = document.getElementById('process-btn');
    const thresholdInput = document.getElementById('threshold');
    const durationInput = document.getElementById('duration');
    const paddingInput = document.getElementById('padding');
    const thresholdVal = document.getElementById('threshold-val');
    const durationVal = document.getElementById('duration-val');
    const paddingVal = document.getElementById('padding-val');
    const logContainer = document.getElementById('log-container');
    const loadingOverlay = document.getElementById('loading-overlay');
    const resultPanel = document.getElementById('result-panel');
    const resultStats = document.getElementById('result-stats');
    const downloadBtn = document.getElementById('download-btn');
    const videoPreview = document.getElementById('video-preview');
    const presetExtremo = document.getElementById('preset-extremo');
    const presetAgressivo = document.getElementById('preset-agressivo');
    const presetNatural = document.getElementById('preset-natural');
    let currentFile = null;

    function updateSliderUI() {
      thresholdVal.textContent = thresholdInput.value + ' dB';
      durationVal.textContent = Number(durationInput.value).toFixed(2) + 's';
      paddingVal.textContent = Number(paddingInput.value).toFixed(2) + 's';
    }
    thresholdInput.addEventListener('input', updateSliderUI);
    durationInput.addEventListener('input', updateSliderUI);
    paddingInput.addEventListener('input', updateSliderUI);

    function resetButtons() {
      [presetExtremo, presetAgressivo, presetNatural].forEach(function(btn) {
        btn.className = 'py-2 px-1 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs font-bold transition-colors border border-gray-700 flex flex-col items-center justify-center text-center';
      });
    }
    presetExtremo.addEventListener('click', function() {
      resetButtons();
      presetExtremo.className = 'py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900';
      thresholdInput.value = -30; durationInput.value = 0.04; paddingInput.value = 0.02; updateSliderUI(); log('Modo Extremo ativado.', 'info');
    });
    presetAgressivo.addEventListener('click', function() {
      resetButtons();
      presetAgressivo.className = 'py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900';
      thresholdInput.value = -30; durationInput.value = 0.10; paddingInput.value = 0.05; updateSliderUI(); log('Modo Viral Max ativado.', 'info');
    });
    presetNatural.addEventListener('click', function() {
      resetButtons();
      presetNatural.className = 'py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900';
      thresholdInput.value = -40; durationInput.value = 0.30; paddingInput.value = 0.05; updateSliderUI(); log('Modo Natural ativado.', 'info');
    });

    function log(msg, type) {
      type = type || 'info';
      const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };
      if (logContainer.innerHTML.indexOf('A aguardar') !== -1) logContainer.innerHTML = '';
      const time = new Date().toLocaleTimeString('pt-PT', { hour12: false });
      const line = document.createElement('div');
      line.className = colors[type] || colors.info;
      line.innerHTML = '<span class="text-gray-600">[' + time + ']</span> ' + msg;
      logContainer.appendChild(line);
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    function handleFile(file) {
      if (!file) return;
      const valid = ['.mp4', '.mov', '.webm', '.mkv'];
      const name = file.name || '';
      const ext = name.indexOf('.') >= 0 ? name.substring(name.lastIndexOf('.')).toLowerCase() : '';
      const isVideo = (file.type || '').startsWith('video/') || valid.indexOf(ext) !== -1;
      if (!isVideo) { log('Formato inválido. Envie MP4, MOV, WEBM ou MKV.', 'error'); return; }
      currentFile = file;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
      fileInfoEl.classList.remove('hidden');
      processBtn.disabled = false;
      resultPanel.classList.add('hidden');
      videoPreview.removeAttribute('src');
      log('Vídeo selecionado: ' + file.name, 'info');
    }

    fileInput.addEventListener('click', function(e) { e.target.value = ''; });
    fileInput.addEventListener('change', function(e) { handleFile(e.target.files[0]); });
    dropZone.addEventListener('dragover', function(e) { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });
    dropZone.addEventListener('dragleave', function() { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });
    dropZone.addEventListener('drop', function(e) { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });

    processBtn.addEventListener('click', async function() {
      if (!currentFile) return;
      loadingOverlay.classList.remove('hidden'); loadingOverlay.classList.add('flex');
      processBtn.disabled = true; resultPanel.classList.add('hidden'); logContainer.innerHTML = '';
      log('A enviar vídeo para o motor FFmpeg...', 'info');
      log('O áudio vai guiar os cortes das cenas.', 'info');

      try {
        const form = new FormData();
        form.append('video', currentFile);
        form.append('threshold', thresholdInput.value);
        form.append('duration', durationInput.value);
        form.append('padding', paddingInput.value);
        const res = await fetch('/process', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Erro ao processar vídeo.');

        log('Silêncios detectados: ' + data.silenceCount, 'success');
        log('Blocos de vídeo preservados: ' + data.segmentCount, 'success');
        log('MP4 único criado com áudio e vídeo juntos.', 'success');

        downloadBtn.href = data.downloadUrl;
        downloadBtn.download = data.fileName || 'SilencePro_video_limpo.mp4';
        videoPreview.src = data.downloadUrl;
        resultStats.textContent = 'Original: ' + data.originalSeconds + 's | Limpo: ' + data.finalSeconds + 's | Redução: ' + data.reductionPercent + '%';
        resultPanel.classList.remove('hidden');
      } catch (err) {
        log('ERRO: ' + err.message, 'error');
      } finally {
        loadingOverlay.classList.add('hidden'); loadingOverlay.classList.remove('flex'); processBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => res.type('html').send(page()));

app.post('/process', upload.single('video'), async (req, res) => {
  const inputPath = req.file && req.file.path;
  let outputPath = null;
  try {
    if (!req.file) throw new Error('Nenhum vídeo foi enviado.');

    const threshold = Math.max(-80, Math.min(-10, Number(req.body.threshold || -30)));
    const minSilence = Math.max(0.01, Math.min(3, Number(req.body.duration || 0.10)));
    const padding = Math.max(0, Math.min(0.5, Number(req.body.padding || 0.05)));

    const info = await probe(inputPath);
    if (!info.hasVideo) throw new Error('O arquivo enviado não tem faixa de vídeo.');
    if (!info.hasAudio) throw new Error('Este vídeo não tem áudio. Não dá para cortar cenas guiadas por silêncio.');
    if (!info.duration || !Number.isFinite(info.duration)) throw new Error('Não foi possível ler a duração do vídeo.');

    const detected = await detectSilences(inputPath, threshold, minSilence);
    const segments = buildKeepSegments(info.duration, detected.silences, detected.openSilenceStart, padding);

    const originalBase = path.parse(req.file.originalname).name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'video';
    const id = crypto.randomUUID();
    const outputName = 'SilencePro_' + originalBase + '_MP4_limpo_' + id.slice(0, 8) + '.mp4';
    outputPath = path.join(OUTPUT_DIR, outputName);

    if (segments.length === 1 && segments[0].start <= 0.02 && segments[0].end >= info.duration - 0.02) {
      await normalizeOnly(inputPath, outputPath);
    } else {
      await renderSegments(inputPath, outputPath, segments);
    }

    const finalSeconds = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const reductionPercent = Math.max(0, Math.round((1 - finalSeconds / info.duration) * 100));

    res.json({
      ok: true,
      fileName: outputName,
      downloadUrl: '/download/' + encodeURIComponent(outputName),
      originalSeconds: info.duration.toFixed(1),
      finalSeconds: finalSeconds.toFixed(1),
      reductionPercent,
      silenceCount: detected.silences.length + (detected.openSilenceStart !== null ? 1 : 0),
      segmentCount: segments.length
    });
  } catch (err) {
    if (outputPath) fsp.unlink(outputPath).catch(() => {});
    res.status(400).json({ ok: false, error: err.message || 'Erro ao processar vídeo.' });
  } finally {
    if (inputPath) fsp.unlink(inputPath).catch(() => {});
  }
});

app.get('/download/:file', async (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).send('Arquivo não encontrado ou expirado. Processe o vídeo novamente.');
  res.download(full, file);
});

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'Vídeo muito grande para este servidor. Limite atual: ' + MAX_UPLOAD_MB + ' MB.' });
  }
  if (err) return res.status(400).json({ ok: false, error: err.message || 'Erro inesperado.' });
  next();
});

app.listen(PORT, () => {
  console.log('Silence Pro MP4 rodando na porta ' + PORT);
});
