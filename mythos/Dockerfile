FROM node:20-alpine

# edge-tts for voice synthesis (optional — degrades gracefully if missing)
RUN apk add --no-cache python3 py3-pip && \
    pip3 install --break-system-packages edge-tts || true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Render injects PORT; MYTHOS_PORT in .env is the local fallback.
ENV PORT=4478
ENV MYTHOS_BIND=0.0.0.0

EXPOSE ${PORT}

CMD ["node", "src/main.js"]
