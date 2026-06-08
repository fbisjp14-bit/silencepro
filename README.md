# Silence Pro - MP3 limpo + MP4 cortado

Versão para Render/Railway com backend Node + FFmpeg.

Fluxo novo:

1. Envia vídeo MP4/MOV/WEBM/MKV.
2. O servidor detecta silêncio pelo áudio.
3. Gera um MP3 limpo separado, com corte mais agressivo.
4. Gera um MP4 cortado separado, removendo cenas de silêncio/respiração com corte mais seguro.
5. Entrega dois botões: Baixar MP3 limpo e Baixar MP4 cortado.

Deploy no Render:

New -> Web Service -> conectar repositório -> Environment Docker -> Free -> Deploy.
