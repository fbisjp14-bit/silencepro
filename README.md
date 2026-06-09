# Silence Pro MP4 by Leinad

Versão atualizada para Render/Web Service + Docker.

Alterações desta versão:
- Porcentagem de carregamento de 0% a 100% no centro do círculo.
- Processamento por job em segundo plano no servidor depois que o upload termina.
- Rota `/status/:id` para acompanhar o progresso.
- Recuperação automática do último processamento ao reabrir a página enquanto o job ainda existe no servidor.
- Mantido o padrão Viral Max e as configurações de corte existentes.
- Renderização continua com modo anti-gago e anti-chiado.
- Otimização de acompanhamento de progresso com FFmpeg usando `-progress pipe:1`.

Observação importante:
Se fechar a página antes do upload terminar, o envio pode ser cancelado. Depois que o upload termina e o servidor cria o job, o processamento continua no Render e a página tenta recuperar pelo navegador enquanto o job não expirar.
