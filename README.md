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
- Painel visual e textos principais mantidos como no arquivo original.
- Processamento otimizado: detecção de silêncio em áudio mono 16 kHz e renderização por blocos preservados.
- O resultado continua sendo MP4 único com áudio e vídeo juntos.


## Anti-clonagem no Render

Esta versão bloqueia uso do motor fora dos domínios autorizados.

No Render, em Environment, configure:

```env
ALLOWED_ORIGINS=https://silencepro.pages.dev,https://silencepro-sqo1.onrender.com
RATE_LIMIT_MAX=12
RATE_LIMIT_WINDOW_MS=60000
```

Se usar domínio próprio:

```env
ALLOWED_ORIGINS=https://silencepro.pages.dev,https://silencepro-sqo1.onrender.com,https://seudominio.com
```

Observação: qualquer pessoa ainda pode copiar a aparência do site pelo navegador. Esta proteção impede que uma cópia use o backend/motor do Silence Pro.


## Proteção reforçada perto de 90%

Para ativar a proteção extra no Render, configure em Environment:

```env
ALLOWED_ORIGINS=https://silencepro.pages.dev,https://silencepro-sqo1.onrender.com
ACCESS_PASSWORD=coloque-uma-senha-forte-aqui
SESSION_SECRET=coloque-uma-chave-grande-aleatoria-aqui
RATE_LIMIT_MAX=8
RATE_LIMIT_WINDOW_MS=60000
```

Se usar domínio próprio:

```env
ALLOWED_ORIGINS=https://silencepro.pages.dev,https://silencepro-sqo1.onrender.com,https://seudominio.com
```

O `ACCESS_PASSWORD` ativa uma tela de senha antes de usar o motor. Sem essa variável, o site continua aberto, mas mantém CORS, Origin/Referer, headers e rate limit.

Importante: a aparência do front-end ainda pode ser copiada pelo navegador. A proteção reforçada protege principalmente o motor/backend do Render.


## Ajuste desta versão

A fila foi removida. O sistema mantém as mesmas rotas `/process` e `/status`, mas o processamento inicia imediatamente após o upload.


## Ajuste de velocidade desta versão

O modo turbo automático foi ativado por padrão:

```env
FAST_COPY_MODE=1
FFMPEG_THREADS=2
```

Ele tenta uma renderização muito mais rápida primeiro. Se o corte rápido não reduzir corretamente, o sistema volta para o modo preciso anti-gago/anti-chiado.

Para voltar ao modo mais pesado e preciso, configure no Render:

```env
FAST_COPY_MODE=0
```
