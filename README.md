# Silence Pro MP4 único para Render — Lógica Original do Áudio

Versão corrigida mantendo o painel original e os presets originais.

## Substitua estes 4 arquivos no GitHub

- Dockerfile
- package.json
- server.js
- README.md

## O que foi corrigido

- Mantém os valores padrão do painel original.
- Não muda automaticamente threshold, duração ou margem.
- Usa a mesma lógica do áudio original: RMS em janelas de 10ms.
- O áudio vira mapa de corte e o vídeo segue os mesmos cortes.
- Entrega MP4 único final com vídeo + áudio juntos.
- Verifica o arquivo final antes de liberar.

## Render

Use Web Service + Docker. Depois faça:

Manual Deploy → Clear build cache & deploy

Teste:

/health
