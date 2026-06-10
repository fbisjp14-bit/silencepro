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

const EMBEDDED_INDEX_HTML = `<!DOCTYPE html>
<html lang="pt-PT" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Silence Pro by Leinad | Removedor de Silêncio</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <!-- Motor LameJS para codificação real do MP3 -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        gray: {
                            850: '#1f2937',
                            900: '#111827',
                            950: '#030712',
                        }
                    }
                }
            }
        }
    </script>
    <style>
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #111827; }
        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
        .glass-panel {
            background: rgba(31, 41, 55, 0.7);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(75, 85, 99, 0.4);
        }
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
            <div class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block">Motor Render + FFmpeg</div>
        </div>
    </header>

    <main class="flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6">
        
        <div class="md:col-span-1 space-y-6">
            
            <div id="drop-zone" class="glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden">
                <input type="file" id="audio-input" accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.mov,.webm,.mkv" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10">
                <div class="flex flex-col items-center gap-3 pointer-events-none">
                    <div class="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <i data-lucide="upload-cloud" class="text-blue-400 w-6 h-6"></i>
                    </div>
                    <div>
                        <p class="font-medium text-gray-200">Arraste o seu áudio ou vídeo</p>
                        <p class="text-xs text-gray-400 mt-1">ou toque para procurar</p>
                        <div class="mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2">
                            <p>MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG e FLAC.</p>
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
                    <h3 class="font-semibold text-lg flex items-center gap-2">
                        <i data-lucide="sliders" class="w-5 h-5 text-gray-400"></i>
                        Ajustes de Corte
                    </h3>
                </div>

                <div class="space-y-3 pb-4 border-b border-gray-800">
                    <label class="text-sm text-gray-300 font-medium">Estratégia de Retenção</label>
                    <div class="grid grid-cols-3 gap-2">
                        <button type="button" id="preset-extremo" class="py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center">
                            <span>🚀 Extremo</span>
                            <span class="font-normal text-[9px] text-gray-200">(Corte seco)</span>
                        </button>
                        <button type="button" id="preset-agressivo" class="py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900">
                            <span>🔥 Viral Max</span>
                            <span class="font-normal text-[9px] text-gray-300">(Liso, sem ruído)</span>
                        </button>
                        <button type="button" id="preset-natural" class="py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center">
                            <span>🎙️ Natural</span>
                            <span class="font-normal text-[9px] text-gray-300">(Podcast)</span>
                        </button>
                    </div>
                </div>

                <div class="space-y-2 pt-2">
                    <div class="flex justify-between text-sm">
                        <label class="text-gray-300">Volume de corte (dB)</label>
                        <span id="threshold-val" class="font-mono text-blue-400">-30 dB</span>
                    </div>
                    <input type="range" id="threshold" min="-80" max="-10" value="-30" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500">
                </div>

                <div class="space-y-2">
                    <div class="flex justify-between text-sm">
                        <label class="text-gray-300">Silêncio mínimo (seg)</label>
                        <span id="duration-val" class="font-mono text-blue-400">0.10s</span>
                    </div>
                    <input type="range" id="duration" min="0.01" max="3" step="0.01" value="0.10" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500">
                </div>
                
                <div class="space-y-2">
                    <div class="flex justify-between text-sm">
                        <label class="text-gray-300">Margem natural (seg)</label>
                        <span id="padding-val" class="font-mono text-blue-400">0.05s</span>
                    </div>
                    <input type="range" id="padding" min="0" max="0.5" step="0.01" value="0.05" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500">
                </div>
            </div>

            <button id="process-btn" disabled class="w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]">
                <i data-lucide="zap" class="w-5 h-5"></i>
                Remover Silêncios
            </button>
        </div>

        <div class="md:col-span-2 flex flex-col gap-6">
            
            <div class="glass-panel rounded-2xl p-6 flex-1 flex flex-col relative">
                <h3 class="font-semibold text-lg flex items-center gap-2 mb-4">
                    <i data-lucide="activity" class="w-5 h-5 text-gray-400"></i>
                    Estado do Processamento
                </h3>
                
                <div id="log-container" class="flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2">
                    <div class="text-gray-600">A aguardar arquivo...</div>
                </div>

                <div id="loading-overlay" class="hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10">
                    <div class="relative w-16 h-16 mb-4 flex items-center justify-center">
                        <div class="absolute inset-0 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin"></div>
                        <span id="loading-percent" class="relative z-10 text-sm font-black text-blue-100">0%</span>
                    </div>
                    <p class="font-medium text-lg animate-pulse" id="loading-text">Removendo silêncios...</p>
                </div>
            </div>

            <div id="result-panel" class="glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
                <div class="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4">
                    <div class="text-center sm:text-left">
                        <h3 class="font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1">
                            <i data-lucide="party-popper" class="w-6 h-6"></i>
                            Arquivo Pronto a Usar!
                        </h3>
                        <p class="text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1" id="result-stats">Calculando redução...</p>
                    </div>
                    
                    <a id="download-btn" href="#" download="audio_viral_limpo.mp3" class="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer">
                        <i data-lucide="download" class="w-6 h-6"></i>
                        BAIXAR
                    </a>
                </div>
                <div class="mt-6 pt-4 border-t border-gray-700">
                    <audio id="audio-preview" controls class="w-full rounded-lg bg-gray-800 hidden"></audio>
                    <video id="video-preview" controls class="w-full rounded-lg bg-gray-800 hidden max-h-[420px]"></video>
                </div>
            </div>

        </div>
    </main>

    <footer class="w-full text-center pb-8 pt-4">
        <p class="text-[11px] text-gray-500 font-medium tracking-widest uppercase">"Que Ele cresça e eu diminua." <span class="text-gray-600 ml-1">- João 3:30</span></p>
    </footer>

    <script>
        lucide.createIcons();

        const fileInput = document.getElementById('audio-input');
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
        const loadingPercent = document.getElementById('loading-percent');
        const loadingText = document.getElementById('loading-text');
        const resultPanel = document.getElementById('result-panel');
        const resultStats = document.getElementById('result-stats');
        const downloadBtn = document.getElementById('download-btn');
        const audioPreview = document.getElementById('audio-preview');
        const videoPreview = document.getElementById('video-preview');

        const presetExtremo = document.getElementById('preset-extremo');
        const presetAgressivo = document.getElementById('preset-agressivo');
        const presetNatural = document.getElementById('preset-natural');

        let currentFile = null;
        let pollTimer = null;

        function updateSliderUI() {
            thresholdVal.textContent = \`\${thresholdInput.value} dB\`;
            durationVal.textContent = \`\${Number(durationInput.value).toFixed(2)}s\`;
            paddingVal.textContent = \`\${Number(paddingInput.value).toFixed(2)}s\`;
        }

        thresholdInput.addEventListener('input', updateSliderUI);
        durationInput.addEventListener('input', updateSliderUI);
        paddingInput.addEventListener('input', updateSliderUI);

        function resetButtons() {
            [presetExtremo, presetAgressivo, presetNatural].forEach(btn => {
                btn.className = "py-2 px-1 bg-gray-800 hover:bg-gray-700 rounded-lg text-xs font-bold transition-colors border border-gray-700 flex flex-col items-center justify-center text-center";
            });
        }

        presetExtremo.addEventListener('click', () => {
            resetButtons();
            presetExtremo.className = "py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900";
            thresholdInput.value = -30;
            durationInput.value = 0.04;
            paddingInput.value = 0.02;
            updateSliderUI();
            log('Modo Extremo ativado.', 'info');
        });

        presetAgressivo.addEventListener('click', () => {
            resetButtons();
            presetAgressivo.className = "py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900";
            thresholdInput.value = -30;
            durationInput.value = 0.10;
            paddingInput.value = 0.05;
            updateSliderUI();
            log('Modo Viral Max ativado.', 'info');
        });

        presetNatural.addEventListener('click', () => {
            resetButtons();
            presetNatural.className = "py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900";
            thresholdInput.value = -40;
            durationInput.value = 0.30;
            paddingInput.value = 0.05;
            updateSliderUI();
            log('Modo Natural (Podcast) ativado.', 'info');
        });

        function log(msg, type = 'info') {
            const colors = { info: 'text-gray-300', success: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400' };
            if (logContainer.innerHTML.includes('A aguardar')) logContainer.innerHTML = '';
            const time = new Date().toLocaleTimeString('pt-PT', { hour12: false });
            const line = document.createElement('div');
            line.className = colors[type] || colors.info;
            line.innerHTML = \`<span class="text-gray-600">[\${time}]</span> \${msg}\`;
            logContainer.appendChild(line);
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        function setLoadingPercent(value) {
            const safeValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
            loadingPercent.textContent = \`\${safeValue}%\`;
        }

        function handleFile(file) {
            if (!file) return;

            const validExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
            const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];
            const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
            const isAudio = file.type.startsWith('audio/') || validExts.includes(ext);
            const isVideo = file.type.startsWith('video/') || validVideoExts.includes(ext);

            if (!isAudio && !isVideo) {
                log('Formato inválido. Use MP4, MOV, WEBM, MKV, MP3, WAV, M4A, AAC, OGG ou FLAC.', 'error');
                return;
            }

            currentFile = file;
            fileNameEl.textContent = file.name;
            fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
            fileInfoEl.classList.remove('hidden');
            processBtn.disabled = false;
            log(\`\${isVideo ? 'Vídeo selecionado' : 'Áudio selecionado'}: \${file.name}\`, 'info');
            resultPanel.classList.add('hidden');
            audioPreview.classList.add('hidden');
            videoPreview.classList.add('hidden');
        }

        fileInput.addEventListener('click', (e) => { e.target.value = ''; });
        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });
        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });

        async function startPolling(jobId) {
            clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                try {
                    const res = await fetch(\`/status/\${jobId}\`);
                    const job = await res.json();
                    if (!job.ok) throw new Error(job.error || 'Falha no processamento.');

                    setLoadingPercent(job.progress || 0);
                    loadingText.textContent = job.message || 'Removendo silêncios...';

                    if (job.logs && job.logs.length) {
                        const last = job.logs[job.logs.length - 1];
                        if (!logContainer.dataset.lastLog || logContainer.dataset.lastLog !== last) {
                            logContainer.dataset.lastLog = last;
                            log(last, job.status === 'error' ? 'error' : 'info');
                        }
                    }

                    if (job.status === 'done') {
                        clearInterval(pollTimer);
                        setLoadingPercent(100);
                        loadingOverlay.classList.add('hidden');
                        loadingOverlay.classList.remove('flex');
                        processBtn.disabled = false;

                        const fileUrl = \`/download/\${encodeURIComponent(job.outputFile)}\`;
                        downloadBtn.href = fileUrl;
                        downloadBtn.download = job.downloadName || job.outputFile;
                        resultStats.textContent = job.stats || 'Silêncios removidos com sucesso.';

                        if (job.mediaType === 'video') {
                            videoPreview.src = fileUrl;
                            videoPreview.classList.remove('hidden');
                            audioPreview.classList.add('hidden');
                        } else {
                            audioPreview.src = fileUrl;
                            audioPreview.classList.remove('hidden');
                            videoPreview.classList.add('hidden');
                        }

                        resultPanel.classList.remove('hidden');
                        log('Arquivo pronto para baixar.', 'success');
                    }

                    if (job.status === 'error') {
                        throw new Error(job.error || 'Erro ao remover silêncios.');
                    }
                } catch (err) {
                    clearInterval(pollTimer);
                    loadingOverlay.classList.add('hidden');
                    loadingOverlay.classList.remove('flex');
                    processBtn.disabled = false;
                    log(\`ERRO: \${err.message}\`, 'error');
                }
            }, 1200);
        }

        processBtn.addEventListener('click', async () => {
            if (!currentFile) return;

            clearInterval(pollTimer);
            loadingOverlay.classList.remove('hidden');
            loadingOverlay.classList.add('flex');
            setLoadingPercent(0);
            loadingText.textContent = 'Enviando arquivo para o Render...';
            processBtn.disabled = true;
            logContainer.innerHTML = '';
            resultPanel.classList.add('hidden');

            try {
                const formData = new FormData();
                formData.append('file', currentFile);
                formData.append('threshold', thresholdInput.value);
                formData.append('duration', durationInput.value);
                formData.append('padding', paddingInput.value);

                const res = await fetch('/process', { method: 'POST', body: formData });
                const data = await res.json();
                if (!res.ok || !data.ok) throw new Error(data.error || 'Não foi possível iniciar o processamento.');

                setLoadingPercent(3);
                log('Arquivo recebido. O servidor começou a remover os silêncios.', 'success');
                startPolling(data.jobId);
            } catch (err) {
                loadingOverlay.classList.add('hidden');
                loadingOverlay.classList.remove('flex');
                processBtn.disabled = false;
                log(\`ERRO: \${err.message}\`, 'error');
            }
        });

        updateSliderUI();
    </script>
</body>
</html>
`;


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

app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.type('html').send(EMBEDDED_INDEX_HTML);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Silence Pro Render' });
});

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
