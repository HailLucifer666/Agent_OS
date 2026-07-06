# Edge TTS — Local Microsoft Neural Voices

## What it is
A local OpenAI-compatible TTS service that wraps Microsoft Neural voices via the
[`edge-tts`](https://pypi.org/project/edge-tts/) Python package. It exposes 322
high-quality neural voices with **no API key, no account, no usage limits**.

The Node TTS provider (`edge-tts` provider) calls this service the same way it
would call OpenAI's `/v1/audio/speech` endpoint.

## ⚠️ Honest caveat — read before deploying
This is **UNOFFICIAL**. `edge-tts` reverse-engineers Microsoft Edge's "Read Aloud"
endpoint to fetch neural audio. There is no public/licensed API for these voices.

- **Personal / hobby / educational use only.**
- **Commercial deployment violates Microsoft's Terms of Service** and is not
  licensed for production traffic.
- Microsoft can break or rate-limit this at any time without notice.

For commercial TTS, use a licensed option:
- **Azure Cognitive Services Speech** (the official source of these voices — has a
  generous Free Tier: 500K chars/month).
- **Piper** (`pip install piper-tts`) — fully offline, MIT-licensed neural TTS.

## One-time install
Requires **Python 3.8+** on your PATH:

```bash
pip install edge-tts
```

That's it — no keys, no config files.

## How it runs
The service **autostarts with the dashboard** on boot when Python + `edge-tts` are
detected. You usually don't need to launch it yourself.

- **Run manually:** `python app/services/edge-tts-server.py`
- **Disable autostart** (e.g. you run it yourself, or you don't want TTS):
  set `EDGE_TTS_AUTOSTART=false` in your `.env`.

## Endpoints
Listens on port `5050` by default (override via `EDGE_TTS_PORT`).

| Method | Path                | Purpose                                  |
|--------|---------------------|------------------------------------------|
| GET    | `/health`           | Liveness probe (`{"status":"ok"}`)        |
| GET    | `/v1/voices`        | List available voices (OpenAI-shaped)    |
| POST   | `/v1/audio/speech`  | Synthesize speech, returns audio bytes   |

The Node provider reaches the service via `EDGE_TTS_URL`
(default `http://127.0.0.1:5050`). The default voice is `EDGE_TTS_DEFAULT_VOICE`
(default `en-US-AriaNeural`).

## Troubleshooting
- **Voices return `503` / provider shows offline** → the Python service isn't
  running. Confirm `pip install edge-tts` succeeded and `python` is on your PATH
  (`python --version`).
- **Port already in use** → set a different `EDGE_TTS_PORT` (and matching
  `EDGE_TTS_URL`) in `.env`.
- **`ModuleNotFoundError: edge_tts`** → rerun `pip install edge-tts` in the same
  Python environment the dashboard uses to launch the service.
