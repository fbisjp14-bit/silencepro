FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js README.md ./

ENV NODE_ENV=production
ENV PORT=10000
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=17
ENV COPY_MAX_SEGMENTS=24

EXPOSE 10000
CMD ["npm", "start"]
