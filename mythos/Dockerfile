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

# V2 §7.2 — MYTHOS_BIND is non-loopback here, so the server refuses to boot
# unless MYTHOS_AUTH_TOKEN is also set. NOT baked into the image (it's a
# secret) — supply it at run time, e.g.:
#   docker run -e MYTHOS_AUTH_TOKEN=... -p 4478:4478 <image>
# See mythos/.env.example for the token's full contract (Bearer header,
# mythos_token cookie, or WS ?token=).

EXPOSE ${PORT}

CMD ["node", "src/main.js"]
