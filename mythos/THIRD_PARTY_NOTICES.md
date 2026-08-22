# Third-Party Notices

This file documents third-party code and models used by MYTHOS beyond what's
declared in `package.json`, **plus every npm dependency in the shipped tree whose
licence is not purely permissive** — see "Shipped npm dependencies" immediately
below.

Until 2026-08-19 this file opened with the line "npm dependency licenses are not
repeated here", and that sentence is why the section below did not exist. Nobody had
enumerated the tree, so four non-permissive obligations shipped unrecorded. The
enumeration is now a tracked gate rather than a claim:

```bash
cd mythos && node scripts/audit-licences.js --check
```

## Shipped npm dependencies — the non-permissive set

`scripts/audit-licences.js` reads the non-dev entries of both `package-lock.json`
files (the root tree and `mythos/`), because electron-builder prunes
devDependencies and then packs what is left off disk. Of **265** production
packages, **225** are plainly permissive (MIT, ISC, Apache-2.0, BSD, ISC, and the
usual long tail), **25** are `@img/sharp-*` prebuilts for other platforms that are
not installed and therefore cannot be in a Windows artifact, and the following
**15** carry an obligation. Anything added to the tree that is neither permissive nor
listed here fails `--check`.

Measured 2026-08-19. As everywhere else in this file, these are readings of what
upstream states, **not legal conclusions** — the licensing review before a paid
release is a separate, tracked gate (merged-order steps 6.5 / 6.6).

### `@img/sharp-win32-x64` — Apache-2.0 **AND LGPL-3.0-or-later**

- **Project:** https://github.com/lovell/sharp (prebuilt binaries: `sharp-libvips`)
- **Licence:** its own `LICENSE` is Apache-2.0; its own `README.md` then lists the
  bundled native libraries, of which **eight are LGPLv3**: `fribidi`, `glib`,
  `libexif`, `libheif`, `librsvg`, `libvips`, `pango`, `proxy-libintl`. Upstream
  notes these are used "via the 'any later version' clause of the LGPLv2 or
  LGPLv2.1".

**It ships, and it loads.** `require('kokoro-js')` pulls 14 `sharp` modules and
initialises **libvips 8.17.3** — measured directly, not inferred. The path is
`kokoro-js` → `@huggingface/transformers` → `sharp`, and
`transformers.node.cjs` requires sharp at module scope, so there is no lazy branch
that avoids it. `@huggingface/transformers` is also a direct dependency in its own
right.

**This qualifies BUG-274 T1.** T1 promoted Kokoro to lead the TTS chain partly to
move away from edge-tts's LGPLv3. That reasoning holds for edge-tts, which is BYO and
ships zero code — but Kokoro's own dependency tree ships an LGPLv3 **binary**, which
edge-tts never did. The exposure was reduced in one place and introduced in another,
and nothing recorded it until this audit.

**The obligation, as upstream states it:** notice, a copy of the licence, and the
recipient's ability to replace the library. It is a dynamically loaded `.node`
addon, so no MYTHOS source is implicated. Whether that is sufficient for a sold
product is a lawyer's call, not a session's.

### `jszip` — `(MIT OR GPL-3.0-or-later)`

- **Project:** https://github.com/Stuk/jszip
- **Election: MIT.** The GPL operand is never relied on.

Reached via `exceljs` and `pptxgenjs`. Recorded because an election left unstated is
indistinguishable from nobody having noticed the GPL half.

### `buffers@0.1.1` — **no licence declared at all**

- **Project:** http://github.com/substack/node-buffers
- **Licence:** none. No `license` field in `package.json`, no `LICENSE`/`COPYING`
  file, and no licence line in its `README.markdown` — read in the installed package
  on 2026-08-19.

**An absent grant is not a permissive grant**, which makes this stricter than the
copyleft entries above rather than looser. It is reached only as
`exceljs` → `unzipper` → `binary` → `buffers`, and `exceljs` has exactly one
first-party consumer (`src/core/effectors/from-docs.js`), so removing it is a bounded
option if the grant cannot be established upstream.

### `@ghostery/*` and `@remusao/*` (12 packages) — MPL-2.0

- **Projects:** https://github.com/ghostery/adblocker (and its `@remusao/*` helpers)
- **Licence:** Mozilla Public License 2.0 — file-level weak copyleft.

Pulled by the root dependency `@ghostery/adblocker-electron`, used for ad-blocking in
the Electron browser surface. MYTHOS ships them **unmodified**, so the obligation is
notice plus making the MPL-covered source available; no MYTHOS file becomes subject to
the MPL. If any of these files is ever patched in place, that patched file must be
published under the MPL — which is the reason to record the group rather than assume it.



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
- **License: UNVERIFIED — re-confirmed 2026-08-16.** The library code above it is
  Apache-2.0, but that licence covers the *code*, not this *model artifact* —
  the same code-licence-vs-weights distinction that applies to openWakeWord's
  CC BY-NC-SA weights elsewhere in this file. MediaPipe's developer docs page
  covers page content (CC BY 4.0) and code samples (Apache-2.0), neither of
  which is the binary itself, and no separate model-card terms for this file
  have been confirmed. **2026-08-16 re-check:** both canonical docs URLs for
  the Gesture Recognizer are now dead — `developers.google.com/mediapipe/
  solutions/gesture_recognizer` 301-redirects to `ai.google.dev/edge/
  mediapipe/solutions/gesture_recognizer`, which 404s — and the
  `google-ai-edge/mediapipe-samples` repo carries the example code (Apache-2.0)
  but states no terms for the `.task` weights. The licence remains unverifiable
  from public sources.
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

## Cloud AI API providers (BYO keys) — terms recorded 2026-08-16

MYTHOS ships without keys; every provider account is the operator's own (the
BYO rule, same as `.env.example`). This section records **verbatim facts**
from each provider's current published terms, fetched and quoted 2026-08-16,
in service of roadmap step 6.6 (provider ToS for resale). Facts and sources
only — no legal conclusions; terms change, so re-verify before any release.

- **Google (Gemini API).** Sources: Gemini API Additional Terms of Service
  (https://ai.google.dev/gemini-api/terms) and Google APIs Terms of Service
  (https://developers.google.com/terms). API Prohibitions §4.a.1: *"Sublicense
  an API for use by a third party. Consequently, you will not create an API
  Client that functions substantially the same as the APIs and offer it for use
  by third parties."* §4.b.1 parenthetical: *"Developer credentials may not be
  embedded in open source projects."* The Additional Terms state use is *"for
  developers building with Google AI models for professional or business
  purposes, not for consumer use"*, that *"You may use only Paid Services when
  making API Clients available to users in the European Economic Area,
  Switzerland, or the United Kingdom"*, and for **Unpaid Services** that Google
  uses submitted content and generated responses to improve its products, that
  *"Algorithms don't always make the best judgment on their own"* regarding
  *"human reviewers who read, annotate, and process"* sample content, and *"Do
  not submit sensitive, confidential, or personal information to the Unpaid
  Services."* Paid Services are stated not to use prompts/responses for product
  improvement, with the DPA applicable.
- **Groq.** Source: Groq Services Agreement
  (https://console.groq.com/docs/legal/services-agreement, *"Last Modified:
  June 22, 2026"*; the groq.com website ToU is a separate document). §3.2:
  *"Customer may not resell or lease access to its Account."* §6.3(c): no
  *"sell, resell, sublicense, transfer, or distribute any of the Cloud Services
  except as expressly approved by Groq"*. §3.1 grants the right to *"use Groq's
  APIs to integrate the Cloud Services and AI Model Services into your Customer
  Application and to make the Cloud Services and AI Model Services available to
  End Users through your Customer Applications."* §4.2: *"Groq is not permitted
  to use Inputs or Outputs for training or fine-tuning any AI Model Services or
  other models, unless explicitly granted permission or instructed by
  Customer"* (stated tier-agnostically; no free/paid data-use split and no
  human-review language found in the document).
- **Mistral AI.** Sources: the live legal hub https://legal.mistral.ai/terms —
  Commercial ToS, Additional Product Terms, ROW Consumer ToS (all *"Effective:
  August 5, 2026"*). `mistral.ai/terms-of-service` is dead (renders the
  homepage). A separate non-commercial/free-tier API terms document: **NOT
  VERIFIED 2026-08-16** (none linked on the live site). Commercial ToS §2.2(h):
  may not *"buy, sell, or transfer API keys or any type of Mistral AI account
  from, to, or with a third party"*; §2.1 license is *"non-sublicensable
  (except to its End Users)"*. §1.4 defines *"Customer Offering"* — *"Customer's
  own products and services that it makes available to third parties which
  involve use of the Mistral AI Products"* — with End User Accounts permitted
  (Additional Product Terms §2: *"End User Accounts may not be shared, sold,
  licensed, or otherwise made available outside of Customer's entity or
  organization."*). §4.3 **Labs or Preview Models** (the free/experimental
  tier): *"Mistral AI may use Customer Data and Outputs generated from Labs or
  Preview Models to train its artificial intelligence models"*, the training
  opt-out *"does not apply"*, and they are *"restricted to professional use
  only."* §4.2: no training on Customer Data/Outputs for the main products
  except the stated opt-in/opt-out states and Labs/Preview.
- **Cerebras.** Source: Terms of Use
  (https://www.cerebras.ai/terms-of-service, *"Effective August 27, 2024"* —
  one document covering site and API; headings unnumbered). Restrictions: no
  *"Copy, rent, lease, sell, loan, transfer, assign, license or purport to
  sublicense, resell, distribute"* of the Service, and *"Buy, sell or transfer
  API keys without our prior written consent in each case"*. The IP License
  grants the right to *"use the APIs to develop, test and support your
  applications"* and *"distribute or allow access to your integration of the
  APIs within your applications to end users"*. Data: *"the foregoing does not
  grant Cerebras the right to use Service Content for the purpose of training
  or fine-tuning models"* (tier-agnostic; no free/paid data-use split and no
  human-review language found).
- **OpenRouter.** Source: Terms of Service (https://openrouter.ai/terms,
  *"Last Updated: July 29, 2026"*). §7.4 prohibits accessing *"the Site or
  Service for purposes of reselling API access to Models or otherwise
  developing a competing service"*; §7.13 prohibits selling or transferring
  access or Materials. §5.1 however expressly contemplates BYO-key products:
  *"The Service enables you, your Authorized Users, and your customers (to the
  extent you incorporate the Service into your own products and services)
  access to Models provided by Model Providers"*, with flow-down obligations to
  those users (§5.2). §6.1: *"Some Models may store or train on your Inputs… as
  described in their Model Terms. Where possible, OpenRouter has opted out of
  model training with the Models it uses"* — per-Model terms flow down
  (§5.1–5.9); org-level Admins configure prompt logging/zero data
  retention/model training settings (§3.1).
- **NVIDIA NIM (build.nvidia.com hosted APIs).** Source: General NIM FAQ,
  "What does 'production' mean?" (https://docs.api.nvidia.com/nim/docs/product,
  fetched 2026-08-17; the older `www.nvidia.com/en-us/nim/docs/product/` path
  404s): *"Production use involves any use of NIM for purposes other than
  development, testing, research or evaluation such as conducting business
  transactions and any non-testing activity including activity serving real
  end-users. Using NIM in production requires an NVIDIA AI Enterprise
  license."* The same FAQ states access through the NVIDIA Developer Program
  *"is for prototyping, research, development and testing purposes only and
  does not include enterprise features or support"*, and its pricing section
  adds: *"To use NIM In production, your organization must have an NVIDIA AI
  Enterprise license."* Closes the 2026-08-16 named gap (`build.nvidia.com/terms`
  rendering an empty JS shell; the agreements hub serving no document body).
  Consequence for MYTHOS: NIM keys are BYO — the end user supplies their own
  key and accepts NVIDIA's terms directly, exactly as with every other provider
  here, so this is a disclosure obligation (state the free tier's limits where
  the key is configured — see `.env.example`), not a licensing one.

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
| DeepSeek Harness (`dsh`) | https://github.com/deepseek-ai/deepseek-harness | MIT (`LICENSE` in every published `@deepseek-ai/*` package and in `package.json`'s `license` field, read from the installed tree 2026-08-22) | Installed by `scripts/setup-dsh.js --install` as `npm install --save-exact @deepseek-ai/dsh@0.1.1-rc.2` into a gitignored project-local `<repo>/DeepSeek Harness/`, then run as a child process. **Not vendored** — no upstream code is tracked in this repo, and nothing in that tree is packaged by `electron-builder`. This is the one integration that does NOT degrade silently: since 2026-07-29 there has been exactly one build-content engine (Hermes-Agent until 2026-08-22, dsh since), so a build with no engine FAILS with an install hint rather than shipping a wrong artifact — boot itself still succeeds without it. **Dependency closure enumerated 2026-08-22, 434 packages:** 349 MIT, 55 Apache-2.0, 15 BSD-3-Clause, 10 ISC, 2 BSD-2-Clause, 1 0BSD, 1 Python-2.0, and exactly one non-permissive declaration — `@img/sharp-win32-x64` at `Apache-2.0 AND LGPL-3.0-or-later`, reached through `@deepseek-ai/dsh-attachment-local` → `sharp`. That is the SAME libvips exposure this repo already ships and already documents in the `@img/sharp-win32-x64` section above, so **dsh introduces no new licence class** — but it does add a second path to it, and the LGPL obligations recorded in that section apply to this one too. Whether an LGPL-3.0 libvips inside a BYO, operator-installed, non-vendored tree changes anything for a paid product is a **lawyer's call and is deliberately not concluded here** |
| Hermes-Agent (REMOVED 2026-08-22) | https://github.com/NousResearch/hermes-agent | MIT (LICENSE file + README badge, verified upstream 2026-08-08, re-verified live 2026-08-16; no commercial-use restriction stated) | **No longer used.** It was the build-content engine from 2026-07-29 until W6 replaced it with DeepSeek Harness on 2026-08-22; `adapters/hermes-agent`, `scripts/setup-hermes.js` and the `Hermes Agent/` install were all deleted. Kept as a row rather than removed because a machine that installed before that date still has the gitignored tree on disk, and because a notices file that silently drops an entry cannot be diffed against an older build |
| cua-driver | https://github.com/trycua/cua (`cua-driver-rs`) | MIT (repository LICENSE.md + sidebar, verified upstream 2026-08-08) | Operator-installed binary (`cua-driver.exe`), spawned over stdio MCP; `adapters/cua-driver/` resolves `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\` then falls back to PATH. Spawn ENOENT → adapter stays OFFLINE. **Caveat worth keeping on record:** the same upstream repo ships other components under different terms — OmniParser is CC-BY-4.0, and the optional `cua-agent[omni]` extra pulls ultralytics under **AGPL-3.0**. MYTHOS uses only the `cua-driver` binary and none of those, so the AGPL path is not entered; do not widen the integration to `cua-agent` without revisiting this |

| open-webSearch | https://github.com/Aas-ee/open-webSearch | Apache-2.0 — verified 2026-08-20 from the **published npm tarball's own LICENSE file** (`open-websearch@2.1.11`), not from the repo page. **Caveat worth recording: that package.json omits the `license` field entirely**, so `npm view open-websearch license` returns nothing and automated licence tooling will report it as unknown. The LICENSE file is the evidence; the metadata gap is upstream's | Operator-installed, **MYTHOS-managed** local daemon, reached over loopback HTTP by `web-search.js`'s first chain rung. Installed on demand by `mythos/scripts/setup-websearch.js --install` into `<repo>/open-websearch/` (gitignored, the `/Hermes Agent/` convention) and started/stopped by `effectors/websearch-child.js` alongside the Piper and edge-tts children. Changed 2026-08-21 (BUG-288): while it was operator-run it was simply never run, and every search for a day was answered by the chain's last rung, Wikipedia. **Still not vendored and not a dependency** — absent from `package.json`, so a clone installs nothing extra and ships nothing of theirs. Connection refused → the rung records the refusal and the chain continues to the other providers. Its own transitive tree (203 packages) has not been audited and owes that before any paid release |

These entries record what upstream states. They are not a legal conclusion —
the licensing review before any paid release is a separate, tracked gate.
