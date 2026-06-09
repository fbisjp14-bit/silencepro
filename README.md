# Silence Pro MP4 único para Render — Smart HQ Video Garantido

Versão corrigida para Render com painel original preservado.

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

Se aparecer JSON com `ok:true`, o backend está certo.

## O que faz

- Recebe vídeo MP4, MOV, WEBM ou MKV.
- Detecta silêncio/respiração pelo áudio com FFmpeg.
- Corta as cenas do vídeo seguindo o áudio.
- Entrega um MP4 único final.
- Mantém painel original do Silence Pro sem trocar os textos principais.
- Usa no-cache para evitar o problema de o navegador carregar arquivos antigos.
- Tenta preservar qualidade original quando possível; se não der, usa HQ rápido.

## Importante

No Render grátis, vídeos muito grandes podem demorar ou falhar por limite de CPU/RAM. Para testar, use primeiro vídeos curtos.


## Correção desta versão

Esta versão verifica o arquivo final com ffprobe antes de liberar o download. Se o modo rápido gerar MP4 sem trilha de vídeo em algum codec, o servidor recria automaticamente em modo HQ compatível para entregar vídeo + áudio juntos.
