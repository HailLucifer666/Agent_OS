# Third-Party Notices

This file documents third-party code and models used by MYTHOS beyond what's
declared in `package.json` (npm dependency licenses are not repeated here).

## openWakeWord (wake-word detection)

- **Project:** https://github.com/dscripka/openWakeWord
- **Code license:** Apache License 2.0

`ui/public/js/voice/wakeword.js` and `ui/public/js/voice/wakeword-worklet.js`
are a clean-room JavaScript port of openWakeWord's streaming inference
pipeline (`openwakeword/model.py`, `openwakeword/utils.py`): PCM audio ->
melspectrogram ONNX model -> sliding-window speech-embedding ONNX model ->
per-wake-word classifier ONNX model -> wake score. The pipeline *logic*
(frame sizes, buffer windowing, feature-window slicing) is derived from that
Apache-2.0-licensed source and is used here under its terms, with attribution.

```
Copyright openWakeWord contributors
Licensed under the Apache License, Version 2.0
```

- **Model weights ("hey_jarvis" and the shared melspectrogram/embedding
  models): CC BY-NC-SA 4.0** (non-commercial). These are **not distributed
  with MYTHOS** — `mythos/ui/public/models/wakeword/` is gitignored, and
  `scripts/setup-wakeword.js` downloads them directly from openWakeWord's
  GitHub releases to the user's own machine on demand (same pattern as
  cua-driver: an optional external component MYTHOS degrades honestly
  without). The wake-word feature (`WAKEWORD_ENABLED`) is opt-in and off by
  default; when the model files are absent it reports `modelsPresent:false`
  rather than failing silently.

## onnxruntime-web (ONNX inference runtime)

- **Project:** https://github.com/microsoft/onnxruntime
- **License:** MIT
- Vendored via npm (`node_modules/onnxruntime-web`) and served locally at
  `/vendor/onnxruntime` — never loaded from a CDN.

## @mediapipe/tasks-vision (gesture recognition runtime)

- **Project:** https://github.com/google-ai-edge/mediapipe
- **License:** Apache License 2.0
- Vendored via npm, served locally at `/vendor/mediapipe` — never loaded from
  a CDN. (Predates this file; documented here for completeness.)
