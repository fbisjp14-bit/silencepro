# Silence Pro MP4 único para Render - modo partes

Esta versão mantém a estrutura visual original do Silence Pro, continua processando no backend com FFmpeg e agora adiciona um modo novo para testar vídeos divididos em partes.

## O que faz

- Aceita MP4, MOV, WEBM e MKV.
- Usa o áudio do vídeo para detectar silêncio.
- Remove o silêncio/respiração baixa do áudio.
- Remove as cenas do vídeo no mesmo ponto.
- Entrega um MP4 único com áudio e vídeo juntos.
- Mantém o modo antigo: **Vídeo único**.
- Adiciona o modo novo: **Partes**.
- No modo Partes, você seleciona vários vídeos curtos, o sistema processa um por vez e depois junta tudo em um MP4 final para download.
- Não gera MP3 separado.

## Como usar o modo Partes

1. Corte o vídeo grande em partes menores antes de enviar.
2. Renomeie os arquivos em ordem, por exemplo:

```text
parte-01.mp4
parte-02.mp4
parte-03.mp4
parte-04.mp4
```

3. Abra o Silence Pro.
4. Clique em **Partes**.
5. Selecione todos os arquivos.
6. Clique em **Processar Partes e Unir**.
7. O sistema vai processar uma parte por vez e, no final, gerar um MP4 final unido.

## Tamanho recomendado das partes

Para Render grátis ou PC fraco:

- Vídeo leve: 5 a 10 minutos por parte.
- Vídeo pesado: 3 a 5 minutos por parte.
- Vídeo 4K: melhor converter para 1080p antes ou dividir em partes menores.

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
package-lock.json
server.js
README.md
```

## Observação importante

O modo Partes reduz a chance de erro porque cada upload/render fica menor. Ele não garante que o tempo total será muito menor, porque ainda precisa processar cada parte e unir tudo no final.

## Ajuste desta versão

- Painel visual e textos principais mantidos como no arquivo original.
- Novo seletor: **Vídeo único** ou **Partes**.
- Backend com nova rota `/merge` para unir os MP4 processados.
- O sistema continua bloqueando processamento paralelo para evitar travamento no Render grátis.
- Resultado final continua sendo MP4 único com áudio e vídeo juntos.
