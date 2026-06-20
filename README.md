# Silence Pro API para usar com Lovable

Esta versão mantém o motor pesado no Render:

- Node/Express
- FFmpeg instalado via Docker
- Upload de vídeo
- Corte de silêncio guiado pelo áudio
- Retorno de MP4 final
- CORS liberado para o frontend do Lovable
- `downloadUrl` absoluto para funcionar fora do domínio do Render
- `/health` para testar se a API está online

## Variáveis no Render

Opcional, mas recomendado:

```txt
MAX_UPLOAD_MB=700
ALLOWED_ORIGINS=https://SEU-PROJETO.lovable.app,https://SEU-DOMINIO.com
```

Se deixar `ALLOWED_ORIGINS` sem configurar, a API permite qualquer origem (`*`). Para testar é mais fácil, mas para produção é melhor colocar só o domínio do Lovable.

## Rotas

### `GET /health`
Confirma que a API está online.

### `POST /process`
Recebe `multipart/form-data`:

- `video`: arquivo MP4/MOV/WEBM/MKV
- `threshold`: volume de corte em dB, exemplo `-30`
- `duration`: silêncio mínimo, exemplo `0.10`
- `padding`: margem natural, exemplo `0.05`

Retorna JSON:

```json
{
  "ok": true,
  "fileName": "SilencePro_video_MP4_limpo_abcd1234.mp4",
  "downloadUrl": "https://seu-render.onrender.com/download/arquivo.mp4",
  "originalSeconds": "30.0",
  "finalSeconds": "22.5",
  "reductionPercent": 25,
  "silenceCount": 12,
  "segmentCount": 13
}
```
