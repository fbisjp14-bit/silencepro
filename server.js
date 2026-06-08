const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'silencepro_uploads'), limits: { fileSize: 600 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

const INDEX_HTML = `<!DOCTYPE html>
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
            <div class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block">Motor MP3 + Zero-Crossing Otimizado</div>
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
                    <div class="text-gray-600">A aguardar áudio ou vídeo...</div>
                </div>

                <div id="loading-overlay" class="hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10">
                    <div class="w-16 h-16 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin mb-4"></div>
                    <p class="font-medium text-lg animate-pulse" id="loading-text">Removendo silêncios...</p>
                </div>
            </div>

            <div id="result-panel" class="glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
                <div class="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4">
                    <div class="text-center sm:text-left">
                        <h3 class="font-bold text-xl text-blue-400 flex items-center justify-center sm:justify-start gap-2 mb-1">
                            <i data-lucide="party-popper" class="w-6 h-6"></i>
                            MP3 Pronto a Usar!
                        </h3>
                        <p class="text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1" id="result-stats">Calculando redução...</p>
                    </div>
                    
                    <a id="download-btn" href="#" download="audio_viral_limpo.mp3" class="w-full sm:w-auto px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-105 shadow-lg cursor-pointer">
                        <i data-lucide="download" class="w-6 h-6"></i>
                        BAIXAR MP3
                    </a>
                </div>
                <div class="mt-6 pt-4 border-t border-gray-700">
                    <audio id="audio-preview" controls class="w-full rounded-lg bg-gray-800"></audio>
                    <video id="video-preview" controls playsinline class="hidden w-full rounded-lg bg-black mt-2 max-h-[420px]"></video>
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
        const resultPanel = document.getElementById('result-panel');
        const resultStats = document.getElementById('result-stats');
        const downloadBtn = document.getElementById('download-btn');
        const audioPreview = document.getElementById('audio-preview');
        const videoPreview = document.getElementById('video-preview');

        const presetExtremo = document.getElementById('preset-extremo');
        const presetAgressivo = document.getElementById('preset-agressivo');
        const presetNatural = document.getElementById('preset-natural');

        let currentFile = null;
        let audioContext = null;
        let currentMode = "viral";

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

        // CONFIGURAÇÃO EXTREMO (Agressiva TikTok)
        presetExtremo.addEventListener('click', () => {
            resetButtons();
            presetExtremo.className = "py-2 px-1 bg-red-600 rounded-lg text-xs font-bold transition-colors border border-red-500 flex flex-col items-center justify-center text-center ring-2 ring-red-500 ring-offset-2 ring-offset-gray-900";
            currentMode = 'extremo';
            thresholdInput.value = -30;  
            durationInput.value = 0.04;  
            paddingInput.value = 0.02;   
            updateSliderUI();
            log('Modo Extremo ativado.', 'info');
        });

        // CONFIGURAÇÃO VIRAL MAX
        presetAgressivo.addEventListener('click', () => {
            resetButtons();
            presetAgressivo.className = "py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900";
            currentMode = 'viral';
            thresholdInput.value = -30;  
            durationInput.value = 0.10;  
            paddingInput.value = 0.05;   
            updateSliderUI();
            log('Modo Viral Max ativado.', 'info');
        });

        // CONFIGURAÇÃO PODCAST (Conversa longa)
        presetNatural.addEventListener('click', () => {
            resetButtons();
            presetNatural.className = "py-2 px-1 bg-green-600 rounded-lg text-xs font-bold transition-colors border border-green-500 flex flex-col items-center justify-center text-center ring-2 ring-green-500 ring-offset-2 ring-offset-gray-900";
            currentMode = 'natural';
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
            line.className = colors[type];
            line.innerHTML = \`<span class="text-gray-600">[\${time}]</span> \${msg}\`;
            logContainer.appendChild(line);
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        function handleFile(file) {
            if (!file) return;

            const validExts = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
            const validVideoExts = ['.mp4', '.mov', '.webm', '.mkv'];
            const ext = file.name.includes('.') ? file.name.substring(file.name.lastIndexOf('.')).toLowerCase() : '';
            const isAudio = file.type.startsWith('audio/') || validExts.includes(ext);
            const isVideo = file.type.startsWith('video/') || validVideoExts.includes(ext);

            if (!isAudio && !isVideo) {
                log('Formato inválido. Use áudios como MP3, WAV, M4A, AAC, OGG ou FLAC, ou vídeos como MP4, MOV, WEBM ou MKV.', 'error');
                return;
            }

            currentFile = file;
            fileNameEl.textContent = file.name;
            fileSizeEl.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
            fileInfoEl.classList.remove('hidden');
            processBtn.disabled = false;
            log(\`\${isVideo ? 'Vídeo selecionado para extrair áudio' : 'Processando'}: \${file.name}\`, 'info');
            resultPanel.classList.add('hidden');
        }

        fileInput.addEventListener('click', (e) => { e.target.value = ''; });
        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-blue-500', 'bg-gray-800/50'); });
        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); });
        dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('border-blue-500', 'bg-gray-800/50'); handleFile(e.dataTransfer.files[0]); });

        // MOTOR PRINCIPAL DE PROCESSAMENTO (ÁUDIO ORIGINAL + VÍDEO MP4)
        processBtn.addEventListener('click', async () => {
            if (!currentFile) return;

            loadingOverlay.classList.remove('hidden');
            loadingOverlay.classList.add('flex');
            processBtn.disabled = true;
            logContainer.innerHTML = '';
            resultPanel.classList.add('hidden');
            audioPreview.classList.remove('hidden');
            videoPreview.classList.add('hidden');
            videoPreview.removeAttribute('src');

            try {
                log('A ligar o motor de áudio...', 'info');
                if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }

                const ext = currentFile.name.includes('.') ? currentFile.name.substring(currentFile.name.lastIndexOf('.')).toLowerCase() : '';
                const isVideo = currentFile.type.startsWith('video/') || ['.mp4', '.mov', '.webm', '.mkv'].includes(ext);

                if (isVideo) {
                    // Para vídeo, NÃO decodifica no navegador do celular. Isso pesava e podia travar.
                    // O servidor Render faz toda a análise e o corte com FFmpeg.
                    log('Vídeo detectado. O áudio e os cortes serão analisados no servidor.', 'info');
                    await processVideoMP4();
                } else {
                    log('A extrair a onda sonora do arquivo...', 'info');
                    const arrayBuffer = await currentFile.arrayBuffer();

                    log('A mapear decibéis...', 'info');
                    const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
                    const sampleRate = buffer.sampleRate;
                    const channelData = buffer.getChannelData(0);

                    const thresholdDB = parseFloat(thresholdInput.value);
                    const minSilenceSec = parseFloat(durationInput.value);
                    const paddingSec = parseFloat(paddingInput.value);

                    const keepRegions = detectKeepRegions(channelData, sampleRate, thresholdDB, minSilenceSec, paddingSec);
                    log('Foram preservados ' + keepRegions.length + ' blocos vitais de fala.', 'success');
                    await processAudioMP3(channelData, sampleRate, keepRegions);
                }

                loadingOverlay.classList.add('hidden');
                loadingOverlay.classList.remove('flex');
                resultPanel.classList.remove('hidden');
                processBtn.disabled = false;

            } catch (error) {
                console.error(error);
                log(\`ERRO CRÍTICO: \${error && error.message ? error.message : 'Não foi possível processar.'}\`, 'error');
                loadingOverlay.classList.add('hidden');
                loadingOverlay.classList.remove('flex');
                processBtn.disabled = false;
            }
        });

        function detectKeepRegions(channelData, sampleRate, thresholdDB, minSilenceSec, paddingSec) {
            const thresholdAmp = Math.pow(10, thresholdDB / 20);
            const minSilenceSamples = minSilenceSec * sampleRate;
            const paddingSamples = Math.floor(paddingSec * sampleRate);
            const windowSize = Math.max(256, Math.floor(sampleRate * 0.01));
            let isSilence = false;
            let silenceStart = 0;
            let currentKeepStart = 0;
            const keepRegions = [];

            log('A caçar blocos de silêncio morto...', 'info');

            for (let i = 0; i < channelData.length; i += windowSize) {
                let sum = 0;
                let count = 0;
                for (let j = 0; j < windowSize && (i + j) < channelData.length; j++) {
                    const v = channelData[i + j];
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
                            let startKeep = Math.max(0, currentKeepStart - paddingSamples);
                            let endKeep = Math.min(channelData.length, silenceStart + paddingSamples);
                            if (endKeep > startKeep) keepRegions.push({ start: startKeep, end: endKeep });
                            currentKeepStart = i;
                        }
                        isSilence = false;
                    }
                }
            }

            let finalStart = Math.max(0, currentKeepStart - paddingSamples);
            if (channelData.length > finalStart) keepRegions.push({ start: finalStart, end: channelData.length });
            return mergeSmallRegions(keepRegions, sampleRate);
        }

        function mergeSmallRegions(regions, sampleRate) {
            if (!regions.length) return regions;
            const minSegmentSamples = Math.floor(sampleRate * 0.55); // evita microcortes em vídeo
            const mergeGapSamples = Math.floor(sampleRate * 0.35);   // junta falas muito próximas
            const merged = [];

            for (const region of regions) {
                const last = merged[merged.length - 1];
                if (!last) {
                    merged.push({ ...region });
                    continue;
                }
                const gap = region.start - last.end;
                const lastLen = last.end - last.start;
                const thisLen = region.end - region.start;

                if (gap <= mergeGapSamples || lastLen < minSegmentSamples || thisLen < minSegmentSamples) {
                    last.end = Math.max(last.end, region.end);
                } else {
                    merged.push({ ...region });
                }
            }
            return merged;
        }

        async function processAudioMP3(channelData, sampleRate, keepRegions) {
            log('A renderizar novo MP3...', 'warn');

            const mp3encoder = new lamejs.Mp3Encoder(1, sampleRate, 128);
            const mp3Data = [];
            const sampleBlockSize = 1152;
            let totalProcessedSamples = 0;

            for (const region of keepRegions) {
                let i = region.start;
                while (i < region.end) {
                    const end = Math.min(i + sampleBlockSize, region.end);
                    const chunkLength = end - i;
                    const pcm16 = new Int16Array(chunkLength);

                    for (let j = 0; j < chunkLength; j++) {
                        const s = Math.max(-1, Math.min(1, channelData[i + j]));
                        pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    const mp3buf = mp3encoder.encodeBuffer(pcm16);
                    if (mp3buf.length > 0) mp3Data.push(mp3buf);
                    i += sampleBlockSize;
                    totalProcessedSamples += chunkLength;
                }
            }

            const mp3buf = mp3encoder.flush();
            if (mp3buf.length > 0) mp3Data.push(mp3buf);

            const blob = new Blob(mp3Data, { type: 'audio/mp3' });
            const url = URL.createObjectURL(blob);

            downloadBtn.href = url;
            downloadBtn.download = \`SilencePro_\${currentFile.name.replace(/\\.[^/.]+$/, '')}.mp3\`;
            downloadBtn.innerHTML = '<i data-lucide="download" class="w-6 h-6"></i> BAIXAR MP3';
            audioPreview.src = url;
            audioPreview.classList.remove('hidden');
            videoPreview.classList.add('hidden');

            const origSec = (channelData.length / sampleRate).toFixed(1);
            const newSec = (totalProcessedSamples / sampleRate).toFixed(1);
            const percent = Math.round((1 - (totalProcessedSamples / channelData.length)) * 100);
            resultStats.textContent = \`Original: \${origSec}s | Limpo: \${newSec}s | Redução: \${percent}%\`;
            document.querySelector('#result-panel h3').innerHTML = '<i data-lucide="party-popper" class="w-6 h-6"></i> MP3 Pronto a Usar!';
            lucide.createIcons();
            log('MP3 pronto!', 'success');
        }

        async function processVideoMP4() {
            log('A enviar vídeo para o servidor FFmpeg...', 'warn');
            log('Agora o corte de vídeo não roda mais no navegador do celular. Quem corta é o servidor.', 'info');

            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('threshold', thresholdInput.value);
            formData.append('duration', durationInput.value);
            formData.append('padding', paddingInput.value);
            formData.append('mode', currentMode);

            let response;
            try {
                response = await fetch('/api/process', {
                    method: 'POST',
                    body: formData
                });
            } catch (e) {
                throw new Error('A conexão com o servidor caiu durante o envio/processamento. Aguarde 20 segundos e tente de novo com MP4 curto em 720p.');
            }

            if (!response.ok) {
                let msg = 'Não foi possível processar o vídeo no servidor.';
                try {
                    const data = await response.json();
                    if (data && data.error) msg = data.error;
                } catch (_) {
                    try { msg = await response.text(); } catch (_) {}
                }
                throw new Error(msg);
            }

            const blob = await response.blob();
            if (!blob || blob.size < 1024) {
                throw new Error('O servidor retornou um vídeo vazio. Tente outro MP4 ou use corte menos agressivo.');
            }

            const url = URL.createObjectURL(blob);
            downloadBtn.href = url;
            downloadBtn.download = \`SilencePro_\${currentFile.name.replace(/\\.[^/.]+$/, '')}.mp4\`;
            downloadBtn.innerHTML = '<i data-lucide="download" class="w-6 h-6"></i> BAIXAR MP4';
            audioPreview.classList.add('hidden');
            audioPreview.removeAttribute('src');
            videoPreview.src = url;
            videoPreview.classList.remove('hidden');

            let statsText = 'MP4 pronto para baixar.';
            const rawStats = response.headers.get('X-SilencePro-Stats');
            if (rawStats) {
                try {
                    const stats = JSON.parse(decodeURIComponent(rawStats));
                    const percent = Math.round((1 - (stats.final / stats.original)) * 100);
                    statsText = \`Original: \${stats.original.toFixed(1)}s | Limpo: \${stats.final.toFixed(1)}s | Cenas: \${stats.scenes} | Redução: \${percent}%\`;
                } catch (_) {}
            }
            resultStats.textContent = statsText;
            document.querySelector('#result-panel h3').innerHTML = '<i data-lucide="party-popper" class="w-6 h-6"></i> MP4 Pronto a Usar!';
            lucide.createIcons();
            log('MP4 pronto para baixar!', 'success');
        }

    </script>
</body>
</html>
`;
app.get('/', (req, res) => res.type('html').send(INDEX_HTML));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'Silence Pro', ffmpeg: true }));




function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}\n${stderr.slice(-3000)}`));
    });
  });
}

async function getDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file]);
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Não foi possível ler a duração do arquivo.');
  return d;
}

function parseSilences(stderr) {
  const starts = [];
  const ranges = [];
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    if (s) starts.push(parseFloat(s[1]));
    const e = line.match(/silence_end:\s*([0-9.]+)/);
    if (e) {
      const start = starts.length ? starts.pop() : 0;
      const end = parseFloat(e[1]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) ranges.push({ start, end });
    }
  }
  return ranges;
}

function buildKeepRegions(duration, silences, padding) {
  let cursor = 0;
  const keep = [];
  for (const s of silences) {
    const keepStart = Math.max(0, cursor);
    const keepEnd = Math.max(0, s.start + padding);
    if (keepEnd - keepStart > 0.12) keep.push({ start: keepStart, end: Math.min(duration, keepEnd) });
    cursor = Math.max(cursor, s.end - padding);
  }
  if (duration - cursor > 0.12) keep.push({ start: Math.max(0, cursor), end: duration });
  return keep;
}

function reduceRegionsToMax(regions, maxScenes) {
  let out = regions.map(r => ({ ...r }));
  while (out.length > maxScenes) {
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const gap = out[i + 1].start - out[i].end;
      if (gap < bestGap) { bestGap = gap; bestIndex = i; }
    }
    out[bestIndex].end = Math.max(out[bestIndex].end, out[bestIndex + 1].end);
    out.splice(bestIndex + 1, 1);
  }
  return out;
}

function mergeRegions(regions, mode) {
  // Render Free tem pouca RAM. Para funcionar de verdade no celular, o servidor não pode tentar
  // montar 100, 200 ou 1000 microcortes. Ele junta pausas pequenas em cenas maiores.
  const minScene = mode === 'extremo' ? 0.45 : mode === 'natural' ? 1.0 : 0.75;
  const mergeGap = mode === 'extremo' ? 0.35 : mode === 'natural' ? 0.85 : 0.60;
  const maxScenes = mode === 'extremo' ? 18 : mode === 'natural' ? 12 : 15;
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (!last) { merged.push({ ...r }); continue; }
    const gap = r.start - last.end;
    const small = (last.end - last.start) < minScene || (r.end - r.start) < minScene;
    if (gap <= mergeGap || small) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let out = merged.filter(r => r.end - r.start > 0.20);
  let gap = mergeGap;
  while (out.length > maxScenes && gap <= 12) {
    const next = [];
    for (const r of out) {
      const last = next[next.length - 1];
      if (!last || r.start - last.end > gap) next.push({ ...r });
      else last.end = Math.max(last.end, r.end);
    }
    out = next;
    gap += 0.8;
  }
  if (out.length > maxScenes) out = reduceRegionsToMax(out, maxScenes);
  return out.filter(r => r.end - r.start > 0.20);
}

function ffmpegFilter(regions) {
  const parts = [];
  const labels = [];
  regions.forEach((r, i) => {
    parts.push(`[0:v]trim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${regions.length}:v=1:a=1[v][a]`);
  return parts.join(';');
}

function safeName(name) {
  return String(name || 'video').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.[^.]+$/, '');
}


function clampNumber(n, min, max, fallback) {
  n = Number(n);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function copyWholeVideo(input, output) {
  try {
    await run('ffmpeg', ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', output]);
  } catch (_) {
    await run('ffmpeg', ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '34', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output]);
  }
}

async function cutByStreamCopy(input, regions, tmpDir, output) {
  const listPath = path.join(tmpDir, 'concat.txt');
  const segmentPaths = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const seg = path.join(tmpDir, `seg_${String(i).padStart(3, '0')}.mp4`);
    const dur = Math.max(0.15, r.end - r.start);
    await run('ffmpeg', [
      '-y', '-hide_banner',
      '-ss', r.start.toFixed(3),
      '-i', input,
      '-t', dur.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      seg
    ]);
    const st = await fsp.stat(seg).catch(() => null);
    if (st && st.size > 1024) segmentPaths.push(seg);
  }
  if (!segmentPaths.length) throw new Error('Não foi possível criar segmentos do vídeo.');
  await fsp.writeFile(listPath, segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await run('ffmpeg', ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output]);
}

async function cutByReencode(input, regions, output) {
  const filter = ffmpegFilter(regions);
  await run('ffmpeg', [
    '-y', '-hide_banner', '-i', input,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '36', '-threads', '1',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    output
  ]);
}

app.post('/api/process', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'silencepro_job_'));
  const input = path.join(tmpDir, 'input');
  const output = path.join(tmpDir, 'saida.mp4');
  try {
    await fsp.rename(file.path, input);

    const threshold = clampNumber(req.body.threshold, -80, -10, -35);
    const requestedDurationSilence = clampNumber(req.body.duration, 0.01, 3, 0.3);
    const padding = clampNumber(req.body.padding, 0, 0.5, 0.05);
    const mode = String(req.body.mode || 'viral');

    const duration = await getDuration(input);

    const durationSilence = Math.max(requestedDurationSilence, mode === 'extremo' ? 0.22 : mode === 'natural' ? 0.35 : 0.28);
    const detect = await run('ffmpeg', ['-hide_banner', '-i', input, '-af', `silencedetect=noise=${threshold}dB:d=${durationSilence}`, '-f', 'null', '-']);
    const silences = parseSilences(detect.stderr);
    let regions = mergeRegions(buildKeepRegions(duration, silences, padding), mode);
    if (!regions.length) regions = [{ start: 0, end: duration }];

    regions = reduceRegionsToMax(regions, mode === 'natural' ? 6 : 8);

    const realCutSeconds = duration - regions.reduce((a, r) => a + (r.end - r.start), 0);
    const noRealCut = realCutSeconds < 0.35 || (regions.length === 1 && regions[0].start <= 0.05 && regions[0].end >= duration - 0.05);

    if (noRealCut) {
      await copyWholeVideo(input, output);
    } else {
      try {
        await cutByStreamCopy(input, regions, tmpDir, output);
      } catch (copyErr) {
        regions = reduceRegionsToMax(regions, 4);
        try {
          await cutByReencode(input, regions, output);
        } catch (encodeErr) {
          await copyWholeVideo(input, output);
          regions = [{ start: 0, end: duration }];
        }
      }
    }

    const newDur = regions.reduce((a, r) => a + (r.end - r.start), 0);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="SilencePro_${safeName(req.file.originalname)}.mp4"`);
    res.setHeader('X-SilencePro-Stats', encodeURIComponent(JSON.stringify({ original: duration, final: newDur, scenes: regions.length, silences: silences.length })));
    fs.createReadStream(output).pipe(res);
    res.on('finish', async () => { await fsp.rm(tmpDir, { recursive: true, force: true }); });
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    if (file && file.path) await fsp.rm(file.path, { force: true }).catch(() => {});
    res.status(500).json({ error: err.message || 'Erro ao processar vídeo.' });
  }
});


app.listen(PORT, () => console.log(`Silence Pro rodando na porta ${PORT}`));
