FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js README.md ./

ENV NODE_ENV=production
ENV PORT=10000
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=20

EXPOSE 10000

CMD ["node", "server.js"]
