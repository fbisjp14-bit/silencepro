const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = __dirname;
const WORK = path.join(ROOT, 'work');
const OUT = path.join(ROOT, 'outputs');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const upload = multer({
  dest: WORK,
  limits: { fileSize: 450 * 1024 * 1024 }
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    if (p.stdout) p.stdout.on('data', d => stdout += d.toString());
    if (p.stderr) p.stderr.on('data', d => stderr += d.toString());
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}\n${stderr.slice(-5000)}`));
    });
  });
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Não consegui ler a duração do vídeo.');
  return d;
}

async function extractPcm(file) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    const chunks = [];
    let err = '';
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('Falha ao extrair áudio do vídeo. ' + err.slice(-1500)));
    });
  });
}

function dbFromFrame(buf, start, samples) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const idx = start + i * 2;
    if (idx + 1 >= buf.length) break;
    const s = buf.readInt16LE(idx) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples) || 0;
  return 20 * Math.log10(rms + 1e-9);
}

function detectSegmentsFromPcm(pcm, duration, cfg) {
  const sr = 16000;
  const frameSec = 0.02;
  const frameSamples = Math.floor(sr * frameSec);
  const totalFrames = Math.floor(pcm.length / 2 / frameSamples);
  const threshold = cfg.threshold;
  const minSilenceFrames = Math.max(1, Math.round(cfg.minSilence / frameSec));
  const pad = cfg.padding;

  // Leitura de volume por janelas. Suavização simples para não cortar vogal final.
  const speechRaw = new Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    const db = dbFromFrame(pcm, f * frameSamples * 2, frameSamples);
    speechRaw[f] = db >= threshold;
  }

  // Fecha buracos muito pequenos dentro da fala.
  const speech = speechRaw.slice();
  let i = 0;
  while (i < totalFrames) {
    if (speech[i]) { i++; continue; }
    const start = i;
    while (i < totalFrames && !speech[i]) i++;
    const len = i - start;
    if (len < minSilenceFrames) {
      for (let j = start; j < i; j++) speech[j] = true;
    }
  }

  // Remove ruídos/falhas de fala muito curtas.
  const minSpeechFrames = Math.max(2, Math.round(0.06 / frameSec));
  i = 0;
  while (i < totalFrames) {
    if (!speech[i]) { i++; continue; }
    const start = i;
    while (i < totalFrames && speech[i]) i++;
    const len = i - start;
    if (len < minSpeechFrames) {
      for (let j = start; j < i; j++) speech[j] = false;
    }
  }

  const segments = [];
  i = 0;
  while (i < totalFrames) {
    while (i < totalFrames && !speech[i]) i++;
    if (i >= totalFrames) break;
    let start = i * frameSec;
    while (i < totalFrames && speech[i]) i++;
    let end = Math.min(duration, i * frameSec);
    start = Math.max(0, start - pad);
    end = Math.min(duration, end + pad);
    if (end - start >= 0.08) segments.push([start, end]);
  }

  // Une segmentos que ficaram quase colados por causa da margem.
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] <= 0.03) last[1] = Math.max(last[1], seg[1]);
    else merged.push(seg);
  }
  return merged;
}

function scoreSegments(segments, duration) {
  const kept = segments.reduce((a, [s, e]) => a + Math.max(0, e - s), 0);
  const reduction = duration > 0 ? (duration - kept) / duration : 0;
  return { kept, reduction, count: segments.length };
}

function chooseBestSegments(pcm, duration, inputCfg) {
  const base = Number(inputCfg.threshold);
  const tries = [...new Set([base, base + 3, base + 6, base + 9, base + 12, -25, -22, -20, -18, -16, -14])]
    .filter(v => v <= -10 && v >= -80)
    .sort((a, b) => a - b);

  let best = null;
  for (const th of tries) {
    const segs = detectSegmentsFromPcm(pcm, duration, { ...inputCfg, threshold: th });
    const sc = scoreSegments(segs, duration);
    // Escolhe o primeiro corte que de fato reduz, sem destruir mais de 75% do vídeo.
    const valid = sc.count > 0 && sc.reduction >= 0.015 && sc.reduction <= 0.75;
    const item = { threshold: th, segments: segs, ...sc, valid };
    if (!best) best = item;
    if (valid) {
      // Preferimos redução real, mas sem criar milhares de cortes.
      if (!best.valid || item.reduction > best.reduction || (Math.abs(item.reduction - best.reduction) < 0.03 && item.count < best.count)) best = item;
    }
  }

  if (!best || best.segments.length === 0) {
    return { threshold: inputCfg.threshold, segments: [[0, duration]], kept: duration, reduction: 0, count: 1, valid: false };
  }
  return best;
}

function buildConcatFilter(segments) {
  const parts = [];
  segments.forEach(([s, e], idx) => {
    parts.push(`[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v${idx}]`);
    parts.push(`[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${idx}]`);
  });
  let concatInputs = '';
  segments.forEach((_, idx) => concatInputs += `[v${idx}][a${idx}]`);
  parts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return parts.join(';');
}

async function cutAccurate(input, output, segments) {
  const filter = buildConcatFilter(segments);
  const args = [
    '-hide_banner', '-y', '-i', input,
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-threads', '1', output
  ];
  await run('ffmpeg', args, { timeout: 1000 * 60 * 20 });
}

async function cutFallbackCopy(input, output, segments, jobDir) {
  const listPath = path.join(jobDir, 'list.txt');
  const lines = [];
  for (let i = 0; i < segments.length; i++) {
    const [s, e] = segments[i];
    const segPath = path.join(jobDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', s.toFixed(3), '-to', e.toFixed(3), '-i', input, '-c', 'copy', '-avoid_negative_ts', 'make_zero', segPath]);
    lines.push(`file '${segPath.replace(/'/g, "'\\''")}'`);
  }
  await fsp.writeFile(listPath, lines.join('\n'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output]);
}

async function makeCleanMp3(input, output, segments) {
  const filter = segments.map(([s, e], idx) => `[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${idx}]`).join(';') + ';' + segments.map((_, idx) => `[a${idx}]`).join('') + `concat=n=${segments.length}:v=0:a=1[outa]`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex', filter, '-map', '[outa]', '-c:a', 'libmp3lame', '-b:a', '192k', output]);
}

app.get('/', (req, res) => res.type('html').send(HTML));
app.use('/outputs', express.static(OUT));

app.post('/api/process', upload.single('file'), async (req, res) => {
  const id = uuidv4();
  const jobDir = path.join(WORK, id);
  await fsp.mkdir(jobDir, { recursive: true });
  const input = path.join(jobDir, 'input.mp4');
  const outMp4 = path.join(OUT, `${id}_silencepro.mp4`);
  const outMp3 = path.join(OUT, `${id}_audio_limpo.mp3`);
  try {
    if (!req.file) throw new Error('Nenhum arquivo enviado.');
    await fsp.rename(req.file.path, input);

    const threshold = Math.max(-80, Math.min(-10, Number(req.body.threshold ?? -30)));
    const minSilence = Math.max(0.03, Math.min(3, Number(req.body.minSilence ?? 0.10)));
    const padding = Math.max(0, Math.min(0.5, Number(req.body.padding ?? 0.05)));

    const duration = await probeDuration(input);
    const pcm = await extractPcm(input);
    let best = chooseBestSegments(pcm, duration, { threshold, minSilence, padding });
    let segments = best.segments;

    // Segurança: se surgirem cortes demais no Render Free, aumenta a margem de união aos poucos.
    const maxAccurate = 120;
    if (segments.length > 220) {
      const merged = [];
      const mergeGap = 0.18;
      for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (last && seg[0] - last[1] <= mergeGap) last[1] = seg[1];
        else merged.push(seg.slice());
      }
      segments = merged;
    }

    if (segments.length === 0) segments = [[0, duration]];
    const finalScore = scoreSegments(segments, duration);

    // Gera MP3 limpo usando os mesmos cortes. Se falhar, não impede o MP4.
    try { await makeCleanMp3(input, outMp3, segments); } catch (_) {}

    if (segments.length <= maxAccurate) {
      try {
        await cutAccurate(input, outMp4, segments);
      } catch (e) {
        await cutFallbackCopy(input, outMp4, segments, jobDir);
      }
    } else {
      await cutFallbackCopy(input, outMp4, segments, jobDir);
    }

    res.json({
      ok: true,
      mp4: `/outputs/${path.basename(outMp4)}`,
      mp3: fs.existsSync(outMp3) ? `/outputs/${path.basename(outMp3)}` : null,
      original: duration,
      final: finalScore.kept,
      reduction: finalScore.reduction,
      scenes: segments.length,
      thresholdUsed: best.threshold,
      message: finalScore.reduction < 0.01 ? 'O vídeo quase não tinha silêncio detectável nesse volume. Aumente o volume de corte para -25 dB ou -20 dB para cortar mais.' : 'Corte concluído.'
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message || 'Erro desconhecido no processamento.' });
  } finally {
    setTimeout(() => fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {}), 1000 * 60 * 5);
  }
});

setInterval(async () => {
  try {
    const files = await fsp.readdir(OUT);
    const now = Date.now();
    for (const file of files) {
      const p = path.join(OUT, file);
      const st = await fsp.stat(p);
      if (now - st.mtimeMs > 1000 * 60 * 60 * 2) await fsp.unlink(p).catch(() => {});
    }
  } catch (_) {}
}, 1000 * 60 * 30);

app.listen(PORT, () => console.log(`Silence Pro rodando na porta ${PORT}`));

const HTML = `<!DOCTYPE html>
<html lang="pt-PT" class="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silence Pro by Leinad | Removedor de Silêncio</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest"></script>
<script>tailwind.config={darkMode:'class',theme:{extend:{colors:{gray:{850:'#1f2937',900:'#111827',950:'#030712'}}}}}</script>
<style>::-webkit-scrollbar{width:8px}::-webkit-scrollbar-track{background:#111827}::-webkit-scrollbar-thumb{background:#374151;border-radius:4px}.glass-panel{background:rgba(31,41,55,.7);backdrop-filter:blur(10px);border:1px solid rgba(75,85,99,.4)}</style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen flex flex-col font-sans selection:bg-blue-500 selection:text-white">
<header class="border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-50"><div class="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between"><div class="flex items-center gap-3"><i data-lucide="scissors" class="text-blue-500 w-6 h-6"></i><div class="flex items-center"><span class="font-bold text-xl tracking-tight">Silence <span class="text-blue-500">Pro</span></span><span class="ml-3 text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full border border-gray-700 shadow-sm">by Leinad</span></div></div><div class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-1 rounded hidden sm:block">Render + FFmpeg</div></div></header>
<main class="flex-1 max-w-5xl mx-auto px-4 py-8 w-full grid grid-cols-1 md:grid-cols-3 gap-6">
<div class="md:col-span-1 space-y-6">
<div id="drop-zone" class="glass-panel rounded-2xl p-6 text-center border-dashed border-2 border-gray-700 hover:border-blue-500 transition-colors cursor-pointer group relative overflow-hidden"><input type="file" id="audio-input" accept="video/*,.mp4,.mov,.webm,.mkv" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"><div class="flex flex-col items-center gap-3 pointer-events-none"><div class="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center group-hover:scale-110 transition-transform"><i data-lucide="upload-cloud" class="text-blue-400 w-6 h-6"></i></div><div><p class="font-medium text-gray-200">Selecione o seu vídeo</p><p class="text-xs text-gray-400 mt-1">MP4, MOV, WEBM ou MKV</p><div class="mt-3 text-[11px] leading-relaxed text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-3 py-2"><p>O resultado sai em MP4 único com áudio e cenas cortadas juntos.</p></div></div></div><div id="file-info" class="hidden mt-4 pt-4 border-t border-gray-700 text-sm text-left"><div class="flex items-center gap-2 text-green-400 mb-1"><i data-lucide="check-circle" class="w-4 h-4"></i><span class="font-medium truncate" id="file-name">processando...</span></div><span class="text-gray-400 text-xs" id="file-size">0 MB</span></div></div>
<div class="glass-panel rounded-2xl p-6 space-y-5"><div class="flex items-center justify-between mb-2"><h3 class="font-semibold text-lg flex items-center gap-2"><i data-lucide="sliders" class="w-5 h-5 text-gray-400"></i>Ajustes de Corte</h3></div><div class="space-y-3 pb-4 border-b border-gray-800"><label class="text-sm text-gray-300 font-medium">Estratégia de Retenção</label><div class="grid grid-cols-3 gap-2"><button type="button" id="preset-extremo" class="py-2 px-1 bg-gray-800 hover:bg-red-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-red-500 flex flex-col items-center justify-center text-center"><span>🚀 Extremo</span><span class="font-normal text-[9px] text-gray-200">(Corte seco)</span></button><button type="button" id="preset-agressivo" class="py-2 px-1 bg-blue-600 rounded-lg text-xs font-bold transition-colors border border-blue-500 flex flex-col items-center justify-center text-center ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-900"><span>🔥 Viral Max</span><span class="font-normal text-[9px] text-gray-300">(Padrão MP3)</span></button><button type="button" id="preset-natural" class="py-2 px-1 bg-gray-800 hover:bg-green-600 rounded-lg text-xs font-bold transition-colors border border-gray-700 hover:border-green-500 flex flex-col items-center justify-center text-center"><span>🎙️ Natural</span><span class="font-normal text-[9px] text-gray-300">(Podcast)</span></button></div></div>
<div class="space-y-2 pt-2"><div class="flex justify-between text-sm"><label class="text-gray-300">Volume de corte (dB)</label><span id="threshold-val" class="font-mono text-blue-400">-30 dB</span></div><input type="range" id="threshold" min="-80" max="-10" value="-30" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"></div>
<div class="space-y-2"><div class="flex justify-between text-sm"><label class="text-gray-300">Silêncio mínimo (seg)</label><span id="duration-val" class="font-mono text-blue-400">0.10s</span></div><input type="range" id="duration" min="0.01" max="3" step="0.01" value="0.10" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"></div>
<div class="space-y-2"><div class="flex justify-between text-sm"><label class="text-gray-300">Margem natural (seg)</label><span id="padding-val" class="font-mono text-blue-400">0.05s</span></div><input type="range" id="padding" min="0" max="0.5" step="0.01" value="0.05" class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"></div></div>
<button id="process-btn" disabled class="w-full py-4 rounded-xl font-bold text-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.2)]"><i data-lucide="zap" class="w-5 h-5"></i>Remover Silêncios</button>
</div>
<div class="md:col-span-2 flex flex-col gap-6"><div class="glass-panel rounded-2xl p-6 flex-1 flex flex-col relative"><h3 class="font-semibold text-lg flex items-center gap-2 mb-4"><i data-lucide="activity" class="w-5 h-5 text-gray-400"></i>Estado do Processamento</h3><div id="log-container" class="flex-1 bg-gray-900 rounded-xl p-4 font-mono text-sm text-gray-400 overflow-y-auto max-h-[300px] border border-gray-800 space-y-2"><div class="text-gray-600">A aguardar vídeo...</div></div><div id="loading-overlay" class="hidden absolute inset-0 bg-gray-900/80 backdrop-blur-sm rounded-2xl flex-col items-center justify-center z-10"><div class="w-16 h-16 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin mb-4"></div><p class="font-medium text-lg animate-pulse" id="loading-text">Removendo silêncios...</p></div></div>
<div id="result-panel" class="glass-panel rounded-2xl p-6 hidden ring-2 ring-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.15)]"><div class="text-center"><h3 class="font-bold text-xl text-blue-400 flex items-center justify-center gap-2 mb-2"><i data-lucide="party-popper" class="w-6 h-6"></i>MP4 Pronto!</h3><p class="text-sm font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded inline-block mt-1" id="result-stats">Calculando redução...</p><p class="text-xs text-gray-400 mt-2" id="result-message"></p><a id="download-btn" href="#" download="video_silencepro.mp4" class="mt-5 w-full px-8 py-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition-all transform hover:scale-[1.02] shadow-lg cursor-pointer"><i data-lucide="download" class="w-6 h-6"></i>BAIXAR MP4 CORTADO</a></div><div class="mt-6 pt-4 border-t border-gray-700"><video id="video-preview" controls playsinline class="w-full rounded-lg bg-black max-h-[520px]"></video></div></div>
</div></main><footer class="w-full text-center pb-8 pt-4"><p class="text-[11px] text-gray-500 font-medium tracking-widest uppercase">"Que Ele cresça e eu diminua." <span class="text-gray-600 ml-1">- João 3:30</span></p></footer>
<script>
lucide.createIcons();
const fileInput=document.getElementById('audio-input'),fileNameEl=document.getElementById('file-name'),fileSizeEl=document.getElementById('file-size'),fileInfoEl=document.getElementById('file-info'),processBtn=document.getElementById('process-btn'),thresholdInput=document.getElementById('threshold'),durationInput=document.getElementById('duration'),paddingInput=document.getElementById('padding'),thresholdVal=document.getElementById('threshold-val'),durationVal=document.getElementById('duration-val'),paddingVal=document.getElementById('padding-val'),logContainer=document.getElementById('log-container'),loadingOverlay=document.getElementById('loading-overlay'),resultPanel=document.getElementById('result-panel'),resultStats=document.getElementById('result-stats'),resultMessage=document.getElementById('result-message'),downloadBtn=document.getElementById('download-btn'),videoPreview=document.getElementById('video-preview');
let currentFile=null;
function log(msg,type='info'){const colors={info:'text-gray-300',ok:'text-green-400',warn:'text-yellow-300',err:'text-red-400'};const d=document.createElement('div');d.className=colors[type]||colors.info;d.textContent='['+new Date().toLocaleTimeString()+'] '+msg;logContainer.appendChild(d);logContainer.scrollTop=logContainer.scrollHeight;}
function updateSliderUI(){thresholdVal.textContent=thresholdInput.value+' dB';durationVal.textContent=Number(durationInput.value).toFixed(2)+'s';paddingVal.textContent=Number(paddingInput.value).toFixed(2)+'s'}
[thresholdInput,durationInput,paddingInput].forEach(i=>i.addEventListener('input',updateSliderUI));
function preset(th,dur,pad){thresholdInput.value=th;durationInput.value=dur;paddingInput.value=pad;updateSliderUI()}
document.getElementById('preset-extremo').onclick=()=>preset(-25,0.06,0.02);document.getElementById('preset-agressivo').onclick=()=>preset(-30,0.10,0.05);document.getElementById('preset-natural').onclick=()=>preset(-40,0.30,0.10);
fileInput.addEventListener('change',e=>{currentFile=e.target.files[0];if(!currentFile)return;fileInfoEl.classList.remove('hidden');fileNameEl.textContent=currentFile.name;fileSizeEl.textContent=(currentFile.size/1024/1024).toFixed(2)+' MB';processBtn.disabled=false;resultPanel.classList.add('hidden');logContainer.innerHTML='';log('Vídeo carregado: '+currentFile.name,'ok')});
processBtn.addEventListener('click',async()=>{if(!currentFile)return;loadingOverlay.classList.remove('hidden');loadingOverlay.classList.add('flex');processBtn.disabled=true;resultPanel.classList.add('hidden');log('A enviar vídeo para o servidor FFmpeg...','warn');const fd=new FormData();fd.append('file',currentFile);fd.append('threshold',thresholdInput.value);fd.append('minSilence',durationInput.value);fd.append('padding',paddingInput.value);try{const r=await fetch('/api/process',{method:'POST',body:fd});const data=await r.json();if(!data.ok)throw new Error(data.error||'Erro ao processar.');log('Corte concluído. Cenas preservadas: '+data.scenes,'ok');log('Threshold usado: '+data.thresholdUsed+' dB','ok');const pct=Math.round((data.reduction||0)*100);resultStats.textContent='Original: '+data.original.toFixed(1)+'s | Final: '+data.final.toFixed(1)+'s | Redução: '+pct+'% | Cenas: '+data.scenes;resultMessage.textContent=data.message||'';downloadBtn.href=data.mp4;videoPreview.src=data.mp4;resultPanel.classList.remove('hidden')}catch(err){log('ERRO CRÍTICO: '+err.message,'err');alert('Erro: '+err.message)}finally{loadingOverlay.classList.add('hidden');loadingOverlay.classList.remove('flex');processBtn.disabled=false}});
updateSliderUI();
</script></body></html>`;
