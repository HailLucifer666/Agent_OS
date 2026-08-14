# Third-Party Notices

This file documents third-party code and models used by MYTHOS beyond what's
declared in `package.json` (npm dependency licenses are not repeated here).

## edge-tts (optional voice synthesis — BYO, never bundled)

- **Project:** https://github.com/rany2/edge-tts (PyPI: `edge-tts`)
- **License:** LGPLv3 (upstream LICENSE file + PyPI classifier), verified
  2026-07-30 against upstream sources.

edge-tts is **BYO — never bundled, never installed for you**. MYTHOS ships zero
of its code: `services/edge-tts-server.py` does `import edge_tts` with no
requirements.txt, so the user supplies the Python package themselves. The
desktop installer excludes `edge-tts-server.py` from `package.json`
`build.files` (pinned by `test/electron-builder-files-allowlist.test.js`),
and the Docker image must not `pip install edge-tts` (pinned by
`test/deploy-config-conformance.test.js`). Absent the package, server TTS
stays off and the browser's speechSynthesis speaks instead. This label is a
reading of what upstream states, not a legal conclusion.

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

### gesture_recognizer.task (bundled model weight — licence UNVERIFIED)

- **Project:** https://github.com/google-ai-edge/mediapipe (MediaPipe Gesture
  Recognizer task)
- **Artifact:** `mythos/ui/public/models/gesture_recognizer.task`, an 8.4MB
  MediaPipe gesture-recognition model bundle loaded by
  `ui/public/js/vision/camera.js` at runtime. It is the only third-party model
  binary committed to this repo — every other model (silero, wakeword, piper,
  kokoro, whisper) is gitignored and fetched per-machine by a setup script.
- **License: UNVERIFIED as of 2026-08-12.** The library code above it is
  Apache-2.0, but that licence covers the *code*, not this *model artifact* —
  the same code-licence-vs-weights distinction that applies to openWakeWord's
  CC BY-NC-SA weights elsewhere in this file. MediaPipe's developer docs page
  covers page content (CC BY 4.0) and code samples (Apache-2.0), neither of
  which is the binary itself, and no separate model-card terms for this file
  have been confirmed.
- A 2026-08-04 licence audit (Step 6.6) found this and excluded the file from
  the installer as a licensing hold. On 2026-08-12 the repo owner made an
  explicit decision to ship it anyway, accepting the unverified-licence risk
  so webcam gesture recognition works in the installed build; the exclusion
  was removed by a later, more specific `package.json` `build.files` pattern.
  This entry records that the licence question itself remains open — the
  decision was to ship despite it, not to resolve it.

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

## Aether-BLE (`nodes/shared/.../BeaconAuth.kt`)

- **Project:** Aether-BLE (`aether-bridge/`, `aether-android/`)
- **License:** Apache License 2.0

`nodes/shared/src/main/kotlin/com/mythos/nodes/shared/BeaconAuth.kt` is copied
**verbatim** (bar the package declaration and an added comment) from
Aether-BLE's own `aether-android/shared/src/main/kotlin/com/aether/shared/
BeaconAuth.kt`, and is used here under its terms. It implements the 19-byte
authenticated beacon payload specified in that project's `PROTOCOL.md` §11.2.

Copied rather than reimplemented on purpose: this is the one place in the node
stack where a single wrong byte or shift makes the beacon **undetectable rather
than broken** — no error, no log, just a device that never wins an election —
and the upstream version is already byte-checked against the receiving
`aether-bridge/beacon_auth.py`. `nodes/shared/src/test/.../BeaconAuthTest.kt`
pins that agreement with fixture vectors **generated by that Python module**,
not by this port.

```
Copyright Aether-BLE contributors
Licensed under the Apache License, Version 2.0
```

The Aether protocol itself (the `reading`/`lost`/`election` wire shapes that
`mythos/src/core/aether/scanner-proxy.js` speaks) is a specification, not
redistributed code; MYTHOS talks to an aggregator the operator runs themselves.

## Vendored agent skills (`mythos/skills/`)

Skills are prose guidance, not executable code, but the ones copied verbatim
from upstream are redistribution and are recorded here. Each vendored skill
directory carries its upstream `LICENSE` alongside its `SKILL.md`.

| Skill(s) | Upstream | License |
|---|---|---|
| `taste-frontend` | https://github.com/Leonxlnx/taste-skill | MIT |
| `ponytail` | https://github.com/DietrichGebert/ponytail | MIT |
| `karpathy-guidelines` | https://github.com/multica-ai/andrej-karpathy-skills | MIT (declared in the skill's own frontmatter; upstream ships no LICENSE file) |
| `caveman` | https://github.com/JuliusBrussee/caveman | MIT |
| `ui-ux-pro-max` (essence only) | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | MIT |
| `agent-reach` | https://github.com/Panniantong/Agent-Reach | MIT |
| `using-superpowers`, `brainstorming`, `writing-plans`, `executing-plans`, `systematic-debugging`, `test-driven-development`, `verification-before-completion` | https://github.com/obra/superpowers | MIT (© 2025 Jesse Vincent) |
| `hallmark` | https://github.com/Nutlope/hallmark | MIT (verified 2026-08-14, no exceptions; `.hallmark/log.json` is runtime-local and gitignored) |
| `diagram-design` | https://github.com/cathrynlavery/diagram-design | MIT (Python validator scripts are optional — degrade per the optional-binary rule) |
| `webapp-testing`, `web-artifacts-builder`, `canvas-design`, `theme-factory`, `mcp-builder`, `skill-creator` | https://github.com/anthropics/skills | Apache-2.0 (each dir carries its upstream `LICENSE.txt`; only the Apache-2.0 subset is vendored — the source-available docx/pdf/pptx/xlsx skills are deliberately excluded). `canvas-design` is vendored guidance-only: its ~5 MB `canvas-fonts/` dir is NOT redistributed here |
| `api-and-interface-design`, `code-review-and-quality`, `performance-optimization`, `security-and-hardening`, `observability-and-instrumentation` | https://github.com/addyosmani/agent-skills | MIT (repo `hooks/` and Claude-Code `commands/` are deliberately not vendored) |
| `grill-me`, `grilling` | https://github.com/mattpocock/skills | MIT |
| `obsidian-markdown`, `obsidian-bases`, `json-canvas`, `defuddle`, `obsidian-cli` | https://github.com/kepano/obsidian-skills | MIT (`obsidian-cli` needs the optional Obsidian CLI binary; absent → inert) |
| `persona-frontend-developer`, `persona-backend-architect`, `persona-ui-designer`, `persona-brand-guardian`, `persona-reality-checker`, `persona-ui-finish-gate-reviewer` | https://github.com/msitarzewski/agency-agents | MIT (bodies verbatim; frontmatter rewritten for this repo's loader — see the comment at the top of each SKILL.md) |

`src/core/brain/style-terse.js` is a condensation of the `caveman` skill above,
rewritten for this repo's brain lanes rather than copied — the skill's own
`LICENSE` (MIT) in `skills/caveman/` covers the ideas it derives from.

`browser-use`, `desktop-commander`, `strix-security`, `okf-knowledge` and
`llm-app-patterns` are **written for this repo**, not copied from upstream —
they describe how MYTHOS drives those tools. No upstream text or code is
redistributed for them. Each `SKILL-CORE.md` is likewise an original
condensation written here.

## Optional external tools reached at runtime (not redistributed)

None of these ship with MYTHOS. Each is installed by the operator on their own
machine, and every integration degrades to OFFLINE when the tool is absent.
Listed so the licences are on record before any release.

| Tool | Upstream | License | How MYTHOS reaches it |
|---|---|---|---|
| Agent-Reach | https://github.com/Panniantong/Agent-Reach | MIT | `agent-reach` CLI, probed once and cached |
| Desktop Commander | https://github.com/wonderwhy-er/DesktopCommanderMCP | MIT | MCP stdio server (`npx @wonderwhy-er/desktop-commander`) |
| browser-use | https://github.com/browser-use/browser-use | MIT (the library; browser-use Cloud services have separate terms) | MCP stdio server (`uvx --from 'browser-use[cli]' browser-use --mcp`) |
| Strix | https://github.com/usestrix/strix | Apache-2.0 | `strix` CLI (`pip install strix-agent`; the upstream `curl \| bash` installer is deliberately not used) |
| Open Knowledge Format | https://github.com/GoogleCloudPlatform/knowledge-catalog | Verify upstream `LICENSE` before shipping an OKF importer/exporter as a product feature | Format only — MYTHOS reads and writes the file shape, linking no upstream code |
| awesome-llm-apps | https://github.com/Shubhamsaboo/awesome-llm-apps | Apache-2.0 | Reference reading only; nothing installed or imported |
| headroom | https://github.com/headroomlabs-ai/headroom | Apache-2.0 | MCP stdio server (`headroom mcp serve`) from an operator-installed, project-local venv. Optional; absent → the MCP adapter returns `{ok:false}` and MYTHOS runs uncompressed |
| Hermes-Agent | https://github.com/NousResearch/hermes-agent | MIT (LICENSE file + README badge, verified upstream 2026-08-08; no commercial-use restriction stated) | Cloned by `scripts/setup-hermes.js --install` into a gitignored project-local `<repo>/Hermes Agent/`, then run as a child process. **Not vendored** — no upstream code is tracked in this repo. Note this is the one integration that does NOT degrade silently: since 2026-07-29 it is the only build-content engine, so a build with no engine FAILS with an install hint rather than shipping a wrong artifact (boot itself still succeeds without it) |
| cua-driver | https://github.com/trycua/cua (`cua-driver-rs`) | MIT (repository LICENSE.md + sidebar, verified upstream 2026-08-08) | Operator-installed binary (`cua-driver.exe`), spawned over stdio MCP; `adapters/cua-driver/` resolves `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\` then falls back to PATH. Spawn ENOENT → adapter stays OFFLINE. **Caveat worth keeping on record:** the same upstream repo ships other components under different terms — OmniParser is CC-BY-4.0, and the optional `cua-agent[omni]` extra pulls ultralytics under **AGPL-3.0**. MYTHOS uses only the `cua-driver` binary and none of those, so the AGPL path is not entered; do not widen the integration to `cua-agent` without revisiting this |

These entries record what upstream states. They are not a legal conclusion —
the licensing review before any paid release is a separate, tracked gate.
