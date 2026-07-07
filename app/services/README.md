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

---

# Speech-to-Speech (S2S) — Local Browser-Free Voice Control (Phase 2)

## What it is
An optional local pipeline (`huggingface/speech-to-speech`: Silero VAD +
faster-whisper + Kokoro TTS) that lets you talk to Agent OS with **no browser
tab open at all** — a fully local, open-mic voice loop. It runs as a child
process managed by `app/lib/voice/s2s-child.js` and talks to the dashboard as
its "LLM backend" via `POST /voice/v1/chat/completions` (an OpenAI
chat-completions-shaped endpoint — see `app/lib/voice/s2s-completions.js`),
which reuses the exact same `voice-agent.js` brain as Phase 1's browser
push-to-talk flow.

**Off by default.** This is a heavier, more experimental install than edge-tts:
multi-GB first-run model downloads, untested-on-Windows upstream, and an open
mic with no additional auth once enabled. Run the setup script and read this
section before setting `S2S_AUTOSTART=true`.

## One-time install
```
powershell -ExecutionPolicy Bypass -File app/services/setup-s2s.ps1
```
Default Windows execution policy blocks unsigned `.ps1` scripts, so the
`-ExecutionPolicy Bypass -File` form above is typically required to run it at
all (this only bypasses policy for this one invocation, not system-wide).

The script creates a venv at `S2S_VENV` (default `services/s2s-venv`), installs
`speech-to-speech[faster-whisper]`, detects CUDA and installs a matching torch
build, checks for `espeak-ng`, smoke-tests the installed CLI, and best-effort
lists audio input devices.

## Recommended default: faster-whisper on CPU (int8)
Unless you have a dedicated/idle GPU, prefer the **CPU int8** faster-whisper
build (the setup script's default when no `nvidia-smi` is detected). Agent OS
already runs Ollama concurrently as the reasoning "brain" — sharing a single
GPU's VRAM between Ollama and an STT model is a common source of OOM/latency
issues. CPU int8 STT keeps the two workloads from contending for the same
VRAM budget.

## Kokoro needs espeak-ng
Kokoro TTS depends on `espeak-ng` being available on PATH:
```
winget install espeak-ng
```
The setup script checks for this and will prompt you to install it before
continuing.

## Windows long-path caveat
The venv and its model cache can produce paths well past Windows' classic
260-character limit (nested `site-packages` + cached model directories add up
fast). If you hit `FileNotFoundError`/path-too-long errors during install or
first run, enable long-path support:
- `git config --system core.longpaths true`, and/or
- the Windows registry/Group Policy long-paths toggle (`LongPathsEnabled` under
  `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem`, requires a reboot).

## WSL2 / Docker fallback note
There is no native microphone passthrough in WSL2. If you end up running this
pipeline inside WSL2 or a container instead of natively on Windows, `realtime`
mode's audio must be pointed at the **Windows host's IP address**, not
`localhost` — `localhost` inside WSL2 does not resolve to the Windows host's
audio devices.

## PowerShell execution policy
Same note as above, repeated here for visibility: run the setup script with
`powershell -ExecutionPolicy Bypass -File setup-s2s.ps1` on a default Windows
execution policy. This is operator guidance, not something the script itself
should silently work around.

## Unverified in this environment — validation checklist
Two things could not be validated without a machine that has the pipeline
actually installed and a live end-to-end run:

1. **Does the s2s client require SSE streaming from `/voice/v1`, or does it
   accept plain JSON?** `POST /voice/v1/chat/completions` currently always
   returns a single non-streamed JSON response, even when the request sets
   `stream:true` (see `app/lib/voice/s2s-completions.js`). Validation step: run
   the child against a live server, watch the ring-buffer logs surfaced at
   `GET /api/voice/status` (the `s2s.ringBuffer` field), and if the client
   errors on a non-streamed response, implement an SSE branch around
   `buildCompletion()` in `s2s-completions.js` — that function is the single
   seam a streaming branch would need to grow around, not a rewrite.
2. **Live open-mic end-to-end behavior** — VAD sensitivity, STT accuracy, TTS
   latency, and the overall wake/interrupt feel. This can only be evaluated on
   a machine with the pipeline actually installed and a real microphone; it is
   not verifiable in this dev environment or in CI.
