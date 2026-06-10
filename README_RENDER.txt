Silence Pro - Render com vídeo

CORREÇÃO IMPORTANTE:
Esta versão corrige o erro ENOENT /app/index.html.
Agora o server.js já tem a tela principal embutida como segurança, e o Dockerfile também copia todos os arquivos.

Como subir no Render:
1. Apague/substitua os arquivos antigos do repositório.
2. Envie TODOS os arquivos desta pasta: Dockerfile, server.js, index.html, package.json, render.yaml e README_RENDER.txt.
3. No Render, clique em Manual Deploy > Clear build cache & deploy.
4. Aguarde terminar e abra a URL principal.

Se aparecer deploy antigo, use Clear build cache & deploy.
