#!/usr/bin/env python3
"""piper-server.py — local Piper TTS service. Fully offline, no API, no key.

Sibling of edge-tts-server.py and deliberately the same shape (same endpoints, same
request/response bodies) so providers/piper-tts.js is a near-copy of edge-tts.js and
the two are interchangeable in the TTS chain.

WHY A PERSISTENT SERVICE INSTEAD OF SPAWNING piper PER SENTENCE — measured, not
assumed: synthesis is ~350ms but cold start is ~2844ms (295ms to import piper +
2549ms to load the 60MB ONNX model). Spawning per sentence would therefore be
SLOWER than the network round-trip to edge-tts it is meant to beat. The model is
loaded once here and reused.

Unlike edge-tts this is genuinely offline and genuinely free: proven by blocking
socket.connect/getaddrinfo before import and still producing audio. Piper is MIT
and the voice models carry their own open licences, so unlike edge-tts (an
unofficial Microsoft endpoint labelled personal/hobby-only) it is usable in a
product that is sold. That is a licensing observation, not legal advice.

Endpoints (localhost only, no auth — same contract as edge-tts-server.py):
  GET  /health           -> {"ok": true, "voices": N, "engine": "piper", "model": "..."}
  GET  /v1/voices        -> {"voices": [{id, name, language, gender}, ...]}
  POST /v1/audio/speech  -> WAV audio bytes
       body: {"input": "text", "voice": "<voice id>"}

Environment:
  PIPER_PORT        (default 5051 — 5050 is edge-tts)
  PIPER_MODEL_DIR   directory holding <voice>.onnx + <voice>.onnx.json
  PIPER_VOICE       default voice id, e.g. en_US-hfc_female-medium

Run:  python mythos/services/piper-server.py
"""

import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from piper import PiperVoice
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write("piper not installed: %s\n" % exc)
    sys.exit(3)

PORT = int(os.environ.get("PIPER_PORT", "5051"))
MODEL_DIR = os.environ.get("PIPER_MODEL_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "piper")
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "en_US-hfc_female-medium")

# voice id -> PiperVoice. Loading is the expensive part (~2.5s), so every voice is
# cached for the life of the process. A lock because ThreadingHTTPServer means two
# requests can race the first load of the same voice.
_voices = {}
_lock = threading.Lock()


def available_voices():
    """Voice ids present on disk. A .onnx with no sibling .onnx.json is unusable."""
    out = []
    try:
        for f in sorted(os.listdir(MODEL_DIR)):
            if f.endswith(".onnx") and os.path.exists(os.path.join(MODEL_DIR, f + ".json")):
                out.append(f[:-5])
    except FileNotFoundError:
        pass
    return out


def get_voice(voice_id):
    with _lock:
        if voice_id in _voices:
            return _voices[voice_id]
        onnx = os.path.join(MODEL_DIR, voice_id + ".onnx")
        cfg = onnx + ".json"
        if not (os.path.exists(onnx) and os.path.exists(cfg)):
            raise FileNotFoundError("voice not installed: %s" % voice_id)
        v = PiperVoice.load(onnx, config_path=cfg)
        _voices[voice_id] = v
        return v


def synthesize(text, voice_id):
    """Return WAV bytes. piper's synthesize_wav writes the header itself."""
    voice = get_voice(voice_id)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    return buf.getvalue()


def _describe(vid):
    # 'en_US-hfc_female-medium' -> language en_US, name hfc_female (medium)
    parts = vid.split("-")
    lang = parts[0] if parts else ""
    name = parts[1] if len(parts) > 1 else vid
    quality = parts[2] if len(parts) > 2 else ""
    gender = "Female" if "female" in vid.lower() else ("Male" if "male" in vid.lower() else "")
    return {"id": vid, "name": ("%s (%s)" % (name, quality)).strip(), "language": lang, "gender": gender}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet: the parent captures our stdout into the server log

    def _send(self, code, body, ctype="application/json"):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/health"):
            vs = available_voices()
            # ok:false when no voice is installed — an empty model dir means this
            # service cannot speak, and reporting ok:true would make the chain pick
            # a provider that then fails on every single chunk.
            self._send(200, {"ok": len(vs) > 0, "voices": len(vs),
                             "engine": "piper", "model_dir": MODEL_DIR,
                             "default_voice": DEFAULT_VOICE, "loaded": sorted(_voices.keys())})
        elif self.path.startswith("/v1/voices"):
            self._send(200, {"voices": [_describe(v) for v in available_voices()]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self._send(400, {"error": "bad json: %s" % exc})
            return

        text = (body.get("input") or "").strip()
        if not text:
            self._send(400, {"error": "input required"})
            return
        voice_id = body.get("voice") or DEFAULT_VOICE
        try:
            self._send(200, synthesize(text, voice_id), "audio/wav")
        except FileNotFoundError as exc:
            # Honest and specific: the chain should fall through, not retry forever.
            self._send(404, {"error": str(exc), "available": available_voices()})
        except Exception as exc:
            self._send(500, {"error": "synthesis failed: %s" % exc})


def main():
    voices = available_voices()
    sys.stderr.write("piper-server: %d voice(s) in %s\n" % (len(voices), MODEL_DIR))
    if DEFAULT_VOICE in voices:
        # Pay the ~2.5s load now, at boot, rather than on the operator's first reply.
        try:
            get_voice(DEFAULT_VOICE)
            sys.stderr.write("piper-server: preloaded %s\n" % DEFAULT_VOICE)
        except Exception as exc:
            sys.stderr.write("piper-server: preload failed: %s\n" % exc)
    elif voices:
        sys.stderr.write("piper-server: default voice %s not installed; have %s\n"
                         % (DEFAULT_VOICE, ", ".join(voices)))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
