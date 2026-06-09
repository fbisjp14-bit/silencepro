# Silence Pro MP4 único para Render — Smart HQ Vídeo Certo

Versão corrigida para manter o painel original e entregar MP4 final com vídeo + áudio juntos.

## Substitua estes 4 arquivos no GitHub

- Dockerfile
- package.json
- server.js
- README.md

## Configuração no Render

Use **Web Service + Docker**. Depois faça:

**Manual Deploy → Clear build cache & deploy**

Teste o servidor em:

`/health`

Se aparecer JSON com `ok:true` e `Silence Pro MP4 Smart HQ Video Certo`, o backend está certo.

## O que faz

- Recebe vídeo MP4, MOV, WEBM ou MKV.
- Detecta silêncio/respiração pelo áudio com FFmpeg.
- Corta as cenas do vídeo seguindo o áudio.
- Entrega um MP4 único final.
- Verifica se o resultado tem vídeo + áudio antes de liberar.
- Painel original preservado; ajuste apenas no bloco final para mostrar MP4/BAIXAR MP4 e prévia em vídeo.
- Tenta preservar qualidade original quando possível; se não der, usa HQ rápido.

## Importante

No Render grátis, vídeos grandes podem demorar ou falhar por limite de CPU/RAM. Para testar, use primeiro vídeos curtos.
