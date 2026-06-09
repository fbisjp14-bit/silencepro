# Silence Pro MP4 único para Render — Smart HQ

Versão para Render com foco em **qualidade + velocidade**.

## O que faz

- Aceita vídeo.
- Usa o áudio como guia dos cortes.
- Remove silêncio/respiração baixa.
- Remove as cenas do vídeo no mesmo ponto dos cortes do áudio.
- Entrega um único MP4 final com áudio e vídeo juntos.
- Não entrega MP3 separado.
- Mantém o painel visual do Silence Pro.

## Motor Smart HQ

1. Primeiro tenta o modo rápido sem recomprimir o vídeo (`stream copy`), preservando a qualidade original quando o codec permite.
2. Se o vídeo não permitir corte por cópia, cai automaticamente no modo compatível com qualidade alta.
3. O fallback usa `libx264`, `preset ultrafast` e `CRF 17`, priorizando velocidade sem destruir a qualidade visual.

## Deploy no Render

Substitua na raiz do GitHub:

```text
Dockerfile
package.json
server.js
README.md
```

Depois faça:

```text
Manual Deploy -> Clear build cache & deploy
```

Teste o backend:

```text
/health
```

Se retornar JSON com `ok: true`, está correto.
