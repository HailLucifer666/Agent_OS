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

## Kokoro-82M (offline TTS — providers/kokoro-tts.js)

- **Project:** https://github.com/hexgrad/kokoro (weights/model card:
  https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
- **Code license:** Apache License 2.0 (`kokoro-js` npm package, and the
  `@huggingface/transformers` runtime it depends on, both Apache-2.0 per
  their own `package.json`/repo LICENSE).
- **Model weights license:** Apache License 2.0, per the model card and the
  upstream repo's own licence badge — unlike openWakeWord's CC BY-NC-SA
  weights above, Kokoro's weights carry no non-commercial restriction. This
  is a reading of what upstream states, not a legal conclusion.
- Weights (~26MB q8 default, ~86MB fp32) download from Hugging Face on first
  use into `mythos/models/kokoro/` (gitignored, per-machine — same convention
  as `/mythos/models/piper/`), never committed to this repo.

## Silero VAD (voice activity detection — ui/public/js/voice/silero-vad.js)

- **Project:** https://github.com/snakers4/silero-vad
- **License:** MIT (both the code and the model weights — no non-commercial
  restriction, unlike openWakeWord's weights above).
- `silero-vad.js` is a clean-room JavaScript port of the model's real-time
  inference contract (frame size, recurrent state threading, sample-rate
  input), driven directly through onnxruntime-web — the same loading pattern
  `wakeword.js` already uses (`import('/vendor/onnxruntime/ort.min.mjs')`).
  No new client dependency (`@ricky0123/vad-web`, which this project does NOT
  vendor, is only a thin wrapper over the same model).
- The `.onnx` file is fetched by `scripts/setup-silero.js` from a pinned
  version of `@ricky0123/vad-web`'s published npm package (via jsDelivr's npm
  CDN) into `mythos/ui/public/models/silero/` (gitignored, per-machine),
  never committed. See that script's own comments for why the source is
  pinned to that specific artifact rather than fetched from
  snakers4/silero-vad's repo directly: a live check found the current
  `src/silero_vad/data/silero_vad.onnx` on that repo's master branch carries
  the right input/output tensor names but scores real speech near zero — a
  different export of the same architecture. The version fetched here was
  verified, live, against the model's own `tests/data/test.wav` fixture
  (max probability 0.9998, 77% of frames scored >0.5).

## Local Whisper STT (providers/local-whisper-stt.js)

- **Project:** https://github.com/openai/whisper (run via
  `@huggingface/transformers`'s Node backend, ONNX export from
  onnx-community on Hugging Face).
- **Code license:** MIT (Whisper itself); `@huggingface/transformers` is
  Apache-2.0.
- Model weights download from Hugging Face on first use into
  `mythos/models/whisper/` (gitignored, per-machine), never committed.

## exceljs / pptxgenjs (document generation — Phase 2)

- **exceljs** — https://github.com/exceljs/exceljs — MIT. Used by the
  `generate_spreadsheet` effector (xlsx output sandboxed under
  `vault/builds/docs/`).
- **pptxgenjs** — https://github.com/gitbrent/pptxgenjs — MIT. Used by the
  `generate_deck` effector (pptx output sandboxed under `vault/builds/docs/`).
- The third Phase 2 effector, `generate_pdf`, adds **no new dependency**: it
  renders styled HTML and invokes the locally-installed Chrome/Chromium in
  headless `--print-to-pdf` mode, degrading honestly to an HTML file when
  Chrome is absent. No runtime CDN or network fetch is introduced.

All npm dependency licenses are repeated here only for the Phase 2 additions
that motivated this entry; the canonical license list remains `package.json`.
