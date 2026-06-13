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

## Versão sem fila

Esta versão voltou para a estrutura direta anterior:
upload -> processar -> retornar resultado.

Foi removido o carregamento de fila/status que mostrava mensagens como:
"Na fila: 1 vídeo(s) na frente".

As configurações dos cortes foram mantidas.

## Modo Turbo para vídeos longos

Esta versão adiciona uma opção de velocidade de entrega:

- Turbo: força 30 FPS, reduz resolução pelo maior lado para 960px, CRF 30 e áudio AAC 128k. É a opção mais rápida para Render.
- Rápido: força 30 FPS, maior lado 1280px, CRF 26 e áudio AAC 160k.
- Qualidade Alta: mantém resolução original e usa a qualidade padrão.

As configurações de corte foram mantidas. O modo Turbo mexe na renderização/saída para acelerar vídeos longos.

## Ultra Turbo corrigido

Esta versão muda o modo Turbo para um caminho mais rápido no Render:

- usa filtro select/aselect em vez de muitos trim/concat;
- força 30 FPS;
- reduz maior lado para 720px;
- usa CRF 32;
- áudio AAC 96k.

Use Ultra Turbo quando o objetivo for entregar rápido. Para melhor imagem, use Rápido ou Qualidade Alta.

## Modo Relâmpago

Esta versão corrige a lentidão do Ultra Turbo.

No modo Relâmpago, o sistema tenta cortar por cópia (`-c copy`) sem reencodar o vídeo inteiro. Isso é muito mais rápido no Render e mantém a qualidade original.

Observação: por cortar sem reencode, alguns cortes podem ser um pouco menos precisos dependendo dos keyframes do vídeo. Se precisar de corte mais perfeito, use Rápido ou Qualidade Alta.

## Relâmpago Seguro

Corrige a repetição/gagueira de áudio do modo Relâmpago.

Agora o sistema:
- mantém o vídeo em `copy` para preservar velocidade e qualidade;
- recodifica apenas o áudio em AAC para limpar timestamps;
- usa `aresample=async=1:first_pts=0` para reduzir repetição/gagueira.

Esse modo continua muito mais rápido que reencodar o vídeo inteiro.

## Relâmpago Keyframe

Este modo mantém a velocidade do `copy`, mas evita o bug de cena/áudio repetindo.

Como funciona:
- detecta os keyframes do vídeo;
- ajusta os cortes para keyframes seguros;
- copia o vídeo sem reencodar;
- recodifica apenas o áudio para corrigir timestamps.

Vantagem: muito rápido no Render e mais seguro que copy bruto.
Limite: como só corta em keyframes, pode sobrar um pedacinho de silêncio em alguns pontos.
