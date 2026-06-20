# Silence Pro MP4 Único para Render

Versão feita para vídeo: aceita MP4, MOV, WEBM e MKV, detecta silêncio/respiração pelo áudio e corta as cenas do vídeo no mesmo ponto. O resultado é um MP4 único, com áudio e vídeo juntos.

## Arquivos para substituir no GitHub

Substitua estes 4 arquivos no repositório:

```text
Dockerfile
package.json
server.js
README.md
```

## Como subir no Render grátis

1. Crie ou abra seu repositório no GitHub.
2. Apague os arquivos antigos que tiverem o mesmo nome.
3. Envie estes 4 arquivos.
4. No Render, crie um novo **Web Service**.
5. Conecte o repositório.
6. Escolha ambiente **Docker**.
7. Clique em **Deploy**.

O Render vai instalar o FFmpeg dentro do Docker e iniciar o site automaticamente.

## Como funciona

- O usuário envia um vídeo.
- O servidor usa FFmpeg para detectar silêncios pelo áudio.
- As partes silenciosas são removidas.
- O vídeo é cortado junto com o áudio.
- O app entrega um MP4 final único.

## Observações importantes

- Esta versão não entrega MP3 separado.
- Vídeos sem áudio não podem ser processados, porque os cortes são guiados pelo áudio.
- No Render grátis, vídeos muito grandes podem falhar por limite de memória, disco ou tempo do plano gratuito. Para melhor estabilidade, use vídeos curtos/médios.
- O modo padrão ao abrir é **Viral Max**.
