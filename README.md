# Silence Pro MP4 único para Render - com transcrição por link

Esta versão mantém o painel visual principal do Silence Pro e processa vídeo no backend com FFmpeg.

## O que faz

- Aceita MP4, MOV, WEBM e MKV.
- Usa o áudio do vídeo para detectar silêncio.
- Remove o silêncio/respiração baixa do áudio.
- Remove as cenas do vídeo no mesmo ponto.
- Entrega um MP4 único com áudio e vídeo juntos.
- Adiciona menu de 3 pontos no canto superior.
- No menu, adiciona **Transcrição de vídeo por link**.
- A transcrição por link tenta usar legendas/auto-legendas quando existirem e, se não houver, usa IA local no Render.
- Suporta links públicos de plataformas aceitas pelo yt-dlp, incluindo YouTube, TikTok, Facebook e Instagram.

## Como subir no Render

Use como **Web Service**, não como Static Site.

Configuração recomendada:

- Environment: Docker
- Branch: main
- Root Directory: vazio, se os arquivos estiverem na raiz
- Plan: Free ou superior

Depois de substituir os arquivos no GitHub, faça:

1. Render > seu serviço
2. Manual Deploy
3. Clear build cache & deploy

Se aparecer erro dizendo que recebeu `<!DOCTYPE html>`, o site ainda está como Static Site ou o Render está usando cache/arquivos antigos.

## Arquivos necessários

Substitua na raiz do GitHub:

```text
Dockerfile
package.json
package-lock.json
server.js
README.md
requirements.txt
transcribe_link.py
```

## Observações importantes

- Render grátis tem limite de CPU, memória e tempo. Transcrição por IA em vídeo grande pode demorar ou falhar.
- Links privados, bloqueados por login, região ou proteção da plataforma podem não funcionar.
- Para melhorar qualidade da transcrição, altere a variável de ambiente `TRANSCRIBE_MODEL` para `base` ou `small`, mas isso usa mais memória e demora mais.
- O padrão é `tiny`, mais leve para Render.
