#!/usr/bin/env python3
"""edge-tts-server.py — local OpenAI-compatible TTS service wrapping Microsoft Neural voices.

This is an UNOFFICIAL wrapper around the edge-tts library, which reverse-engineers
Microsoft Edge's Read Aloud feature. It provides genuinely free Microsoft Neural TTS
(322 voices, 74 languages) with no API key and no account — but it is NOT an officially
offered Microsoft API. Personal/hobby use only; commercial deployment violates
Microsoft's Terms of Service. Use Azure Free Tier or Piper for commercial needs.

Endpoints (localhost only, no auth):
  GET  /health             -> {"ok": true, "voices": N}
  GET  /v1/voices          -> {"voices": [{id, name, language, gender}, ...]}
  POST /v1/audio/speech    -> MP3 audio bytes (OpenAI-compatible shape)
       body: {"input": "text", "voice": "en-US-AriaNeural", "format": "mp3"}

Run:  python app/services/edge-tts-server.py
      (or set EDGE_TTS_PORT=5050 to change the port)
"""

import json
import os
import asyncio
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

PORT = int(os.environ.get("EDGE_TTS_PORT", "5050"))
DEFAULT_VOICE = os.environ.get("EDGE_TTS_DEFAULT_VOICE", "en-US-AriaNeural")

# Cache the voice catalog once at startup — calling list_voices() per request is slow.
_VOICES_CACHE = None


def load_voices():
    global _VOICES_CACHE
    if _VOICES_CACHE is None:
        try:
            raw = asyncio.get_event_loop().run_until_complete(edge_tts.list_voices())
            _VOICES_CACHE = [
                {
                    "id": v["ShortName"],
                    "name": v.get("FriendlyName", v["ShortName"]),
                    "language": v.get("Locale", ""),
                    "gender": v.get("Gender", ""),
                }
                for v in raw
            ]
        except Exception as e:
            print(f"[edge-tts] failed to load voices: {e}")
            _VOICES_CACHE = []
    return _VOICES_CACHE


async def synth_to_buffer(text, voice, rate, pitch):
    """Synthesize text to an in-memory MP3 buffer."""
    buf = io.BytesIO()
    communicate = edge_tts.Communicate(text, voice, rate=rate or "+0%", pitch=pitch or "+0Hz")
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    buf.seek(0)
    return buf


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_audio(self, buf, fmt="mp3"):
        data = buf.read()
        self.send_response(200)
        self.send_header("Content-Type", f"audio/{fmt}")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "voices": len(load_voices())})
        elif self.path == "/v1/voices":
            self._send_json(200, {"voices": load_voices()})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON body"})
            return

        text = (body.get("input") or "").strip()
        if not text:
            self._send_json(400, {"error": "input required"})
            return

        voice = body.get("voice") or DEFAULT_VOICE
        fmt = body.get("response_format") or body.get("format") or "mp3"
        rate = body.get("rate") or "+0%"
        pitch = body.get("pitch") or "+0Hz"

        try:
            buf = asyncio.new_event_loop().run_until_complete(
                synth_to_buffer(text, voice, rate, pitch)
            )
        except Exception as e:
            self._send_json(500, {"error": f"synthesis failed: {e}"})
            return

        self._send_audio(buf, fmt)

    def log_message(self, *args):
        # Suppress default noisy logging; errors still print via the handlers above.
        pass


def main():
    print(f"[edge-tts] service starting on port {PORT}")
    print(f"[edge-tts] voice catalog: {len(load_voices())} voices")
    print("[edge-tts] UNOFFICIAL wrapper — personal/hobby use only (Microsoft ToS)")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[edge-tts] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
