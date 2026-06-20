FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv python3-pip ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python3 -m venv /opt/transcriber \
  && /opt/transcriber/bin/pip install --upgrade pip setuptools wheel \
  && /opt/transcriber/bin/pip install --no-cache-dir -r requirements.txt

COPY package.json ./
RUN npm install --omit=dev

COPY server.js README.md transcribe_link.py ./
RUN chmod +x /app/transcribe_link.py

ENV NODE_ENV=production
ENV PORT=10000
ENV FFMPEG_PRESET=ultrafast
ENV FFMPEG_CRF=23
ENV PYTHON_BIN=/opt/transcriber/bin/python
ENV TRANSCRIBE_MODEL=tiny

EXPOSE 10000

CMD ["npm", "start"]
