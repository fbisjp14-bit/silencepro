# Silence Pro MP4 único para Render - corrigido

Esta versão mantém o painel visual do Silence Pro e processa vídeo no backend com FFmpeg.

## O que faz

- Aceita MP4, MOV, WEBM e MKV.
- Usa o áudio do vídeo para detectar silêncio.
- Remove o silêncio/respiração baixa do áudio.
- Remove as cenas do vídeo no mesmo ponto.
- Entrega um MP4 único com áudio e vídeo juntos.
- Não gera MP3 separado.

## Como subir no Render

Use como **Web Service**, não como Static Site.

Configuração recomendada:

- Environment: Docker
- Branch: main
- Root Directory: vazio, se os arquivos estiverem na raiz
- Plan: Free

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
server.js
README.md
```

## Observação

Render grátis tem limite de CPU, memória e tempo. Para vídeos muito grandes, o processamento pode demorar ou falhar por limite do plano. Esta versão usa `ultrafast` para renderizar mais rápido.


## Ajuste desta versão
- Fila de espera removida: o processamento começa direto após o upload.
- Painel visual e textos principais mantidos como no arquivo original.
- Processamento otimizado: detecção de silêncio em áudio mono 16 kHz e renderização por blocos preservados.
- O resultado continua sendo MP4 único com áudio e vídeo juntos.
