FROM node:20-alpine

# edge-tts is BYO — never bundled, never installed for you (LGPLv3 upstream;
# see THIRD_PARTY_NOTICES.md). This image deliberately ships NO Python
# edge-tts toolchain: services/edge-tts-server.py is inert without the
# package, and every TTS call degrades honestly when it is absent (server
# TTS stays off, the browser's speechSynthesis speaks instead) — the same
# posture as the desktop installer, which excludes edge-tts-server.py from
# build.files. Operators who want cloud TTS supply their own image layer or
# a shippable engine (e.g. Piper, MIT). Pinned by
# test/deploy-config-conformance.test.js.

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
