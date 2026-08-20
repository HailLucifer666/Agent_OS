# Mythos Adoption Matrix

Consolidated from GitHub trending (daily + weekly + monthly, Aug 2026). 43 unique repos —
that figure covers **sections 1-10 only**, which came from that one trending sweep.
**Section 11 (web search & research) was appended 2026-08-20** from a different source: the
BUG-280 investigation, where candidates were found by need and then measured from this
machine rather than found by popularity. Later sections may be added the same way; do not
read the count above as a total.
**Status legend:** 🟢 adopt now · 🟡 decide/conditional · ⚪ pattern/template only · ❌ skip
**Phase legend:** P1 = immediate · P2 = next · P3 = strategic

## Context the agent needs before acting

- **OmniRoute gateway is installed and working** (`diegosouzapw/OmniRoute`). It exposes 290+ providers / 500+ models behind one OpenAI-compatible endpoint with quota-aware auto-fallback and token compression. **Any repo below with an OpenAI-compatible slot can point at the local gateway.**
- Mythos already runs the **SKILL.md skills standard** (superpowers). Skill repos (add `skills` to their names) install directly into the existing skills layer.
- Mythos runs sidecar children from the server (edge-tts child pattern). Python/Go single binaries fit the same pattern.
- Mythos surfaces to map onto: **server** (`mythos/server`), **HUD** (`mythos/ui`), **Electron shell** (`electron/`), **phone node** (`nodes/phone`, Kotlin/Gradle + BLE), **voice chain** (edge-tts / Live-audio / wake word), **approvals** (confirm-request/confirm-resolved + ttl), **review/verify gates** (launch guards, pre-commit, e2e harness).
- **Star count has been anti-correlated with usefulness in both domains measured so far, so rank by a measurement from THIS host, never by popularity.** Two cases on record, both 2026-08-20. Windows automation: the three most-starred candidates (Windows-MCP 6.8k, robotjs 12.8k, WinAppDriver 4.0k) all drive with synthetic input, which UIPI/MSIX silently discards — that failure mode *is* the problem they were being considered for. Web search: `nickclyde/duckduckgo-mcp-server` (1.4k, MIT, healthy) is dead here because all three DuckDuckGo hosts are unreachable from this network, while an `example.com` control returned 200 in 234ms.
- **And a sharper version of the same trap: a service being reachable is not the same as a repo's parser working against it.** open-webSearch was adopted specifically because a raw request to Bing from this machine returned HTTP 200 with 136 result links. Driven through that repo's own Bing engine, the same query from the same machine returns **HTTP 301 and zero results**. Always measure through the candidate's own code path.

---

## 1. Voice & realtime

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟢 P1 | `huggingface/speech-to-speech` | https://github.com/huggingface/speech-to-speech | Production VAD→STT→LLM→TTS on OpenAI Realtime protocol; LLM slot → OmniRoute | Voice sidecar (replaces/supplements edge-tts + Live-audio chain); HUD/phone speak the Realtime API | Python sidecar, swappable stages (Silero VAD, Parakeet/Whisper, Qwen3/Kokoro TTS), fully local option |
| 🟡 P3 | `livekit/agents` | https://github.com/livekit/agents | Semantic turn detection, telephony, MCP, LLM-judge test framework; AgentsJS for Node | Voice layer if it outgrows the sidecar | Apache-2.0; the production reference for voice-agent pipelines |
| 🟡 P3 | `google/skills` | https://github.com/google/skills | LiveAPI Service skill + Gemini streaming playbooks | Only if voice goes Gemini | `npx skills add google/skills` |

## 2. Models & gateway

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| ✅ installed | `diegosouzapw/OmniRoute` | https://github.com/diegosouzapw/OmniRoute | The model hub — one endpoint, fallback, token compression | Everything OpenAI-compatible points here | Already working; MCP/A2A support |
| 🟡 P3 | `earendil-works/pi` + `agegr/pi-web` | https://github.com/earendil-works/pi · https://github.com/agegr/pi-web | TS agent runtime + unified LLM API (`pi-ai`) that sits on OmniRoute; web UI | Agent core if Mythos stops shelling to Claude Code | prime-agent is built on it; supply-chain hardened |

## 3. Memory & code intelligence

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟡 **DECIDED 2026-08-17 — patterns only, never a dependency** | `TencentCloud/TencentDB-Agent-Memory` | https://github.com/TencentCloud/TencentDB-Agent-Memory | Chat memory (L0→L3) → **step 8C**; versioned skills → **8F.1**; LLM-Wiki links → **8F.2**; ACL/agent loadouts → **8F.3** (scoped-recall half only; the team/ACL half is NOT built — no reader in a single-operator product); CodeGraph → **8F.4**, which opens with an adopt-vs-build decision against `code-review-graph` below | Ported native into `mythos/src` over the existing vault; **the 3-service Docker stack is not deployed** — it breaks open-source portability and the sold-installer story | MIT. Research finding: `memory/index.js recallHybrid()` already does keyword+vector RRF, TencentDB's headline retrieval design, and `Identity/operator-profile.txt` is already its L3 persona — so 8C.3 (L2 scenarios) is provisional |
| 🟢 P1 — **now the "adopt" side of step 8F.4's decision** | `tirth8205/code-review-graph` | https://github.com/tirth8205/code-review-graph | Tree-sitter blast-radius graph via MCP, ~65× token reduction, risk-scored PR merge gate | Review/verify gates + pre-commit | Python; `pip install code-review-graph`; local-first. **Do not adopt and build 8F.4 natively both** — 8F.4 opens with that decision. Adopt = MCP sidecar degrading OFFLINE when absent (the cua-driver pattern); the objection is a Python dep inside a product being sold, so its licence and deps must clear step 6.6 first. Roadmap's recorded recommendation: build native, JS/TS-scoped and honest about it |
| 🟡 P3 | `vitali87/code-graph-rag` | https://github.com/vitali87/code-graph-rag | Monorepo knowledge graph + AST-patch editing via MCP | Codebase understanding/editing for coding agents | Needs Docker (Memgraph), cmake, ripgrep |
| 🟢 P1 | `firecrawl/pdf-inspector` | https://github.com/firecrawl/pdf-inspector | Rust PDF classify→Markdown, native Node bindings | Document ingestion route (feeds memory/wiki) | `npm i @firecrawl/pdf-inspector`; ~20ms scanned-vs-text |
| 🟢 P1 | `virgiliojr94/book-to-skill` | https://github.com/virgiliojr94/book-to-skill | Docs/books → on-demand SKILL.md chapters | Knowledge → skills pipeline (chains with pdf-inspector) | 24–51× token savings |
| 🟡 **DECIDED 2026-08-17 — patterns only, never a dependency** | `PrimeIntellect-ai/prime-agent` | https://github.com/PrimeIntellect-ai/prime-agent | Continual harness (`/refine`, evidence-backed durable state, snapshots/rollback) → **step 8B**; bounded autonomous mode (turn/token/wall budget + gates that must pass) → **step 8D** | Designed into `src/core/harness/` + `src/core/agent/` over the existing vault and leash | MIT, but installs by `curl \| sh` — **forbidden by the root `CLAUDE.md`**, where Hermes-Agent is the single deliberate external-engine exception. Borrow ideas, not code |

## 4. Agent core & orchestration

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟡 P2 | `unclebob/swarm-forge` | https://github.com/unclebob/swarm-forge | Role pipelines (specifier→coder→cleaner→architect→QA), constitution articles, handoff protocols | Blueprint for Mythos agent roster | tmux/zsh impl not Windows-portable — take the design |
| 🟡 P3 | `embabel/embabel-agent` | https://github.com/embabel/embabel-agent | Kotlin/JVM GOAP agent framework (Goals/Actions/Conditions, replanning) | On-device logic if the phone node grows past voice relay | Same stack as phone node (Kotlin); from Spring's creator |
| 🟡 P3 | `1jehuang/jcode` | https://github.com/1jehuang/jcode | RAM-efficient Rust harness | Always-on background agents on weak hardware | |
| ⚪ | `esengine/DeepSeek-Reasonix` | https://github.com/esengine/DeepSeek-Reasonix | Daemon-agent design, prefix-cache stability | Reference only | Go |
| 🟢 **DECIDED 2026-08-17** — partially adopted, rest tracked as **step 8E** | `msitarzewski/agency-agents` | https://github.com/msitarzewski/agency-agents | Specialized agent personas/prompts | **6 already vendored** as `mythos/skills/persona-*/SKILL.md` (MIT, in `skills.allowlist`, credited in `THIRD_PARTY_NOTICES.md`); **+8 more with named readers** in step 8E.3 | Shell installers ignored — the markdown IS the asset. **The catch found while deciding:** the vendored six are catalogue-only. `agents/personas.js` serves the *seats* from a different directory, so no seat can reach them, and `pickBuilderPersona()` is a two-way keyword coin flip. 8E.1 bridges the roots, 8E.2 makes the router scored + self-reporting. ~220 personas stay unvendored on purpose (a catalogue entry no seat calls is prompt tax every turn). Roadmap "Step 8E" is authoritative |
| ⚪ | `Shubhamsaboo/awesome-llm-apps` | https://github.com/Shubhamsaboo/awesome-llm-apps | 100+ agent/RAG app recipes | Mine on demand | Catalog |
| ⚪ | `HKUDS/DeepTutor` | https://github.com/HKUDS/DeepTutor | Lifelong personalized tutoring agent | Only if tutoring becomes a Mythos agent | Python |

## 5. Control surface (desktop / phone / HUD)

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟡 P2 | `stablyai/orca` | https://github.com/stablyai/orca | **Decision required** — fleet ADE: mobile companion, Design Mode, parallel worktrees, notifications | Same category as Mythos phone node + HUD + approvals | Build / borrow / compete; MIT |
| 🟡 P2 | `pingdotgg/t3code` | https://github.com/pingdotgg/t3code | Permission modes, phone control, app↔server sync patterns | Approvals + phone layer reference | |
| ⚪ | `koala73/worldmonitor` | https://github.com/koala73/worldmonitor | Situational-awareness dashboard concept | HUD pattern only | TS |

## 6. Skills layer

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟢 P1 | `addyosmani/agent-skills` | https://github.com/addyosmani/agent-skills | 24 lifecycle skills + reviewer personas | Skills layer (same SKILL.md standard) | `npx skills add addyosmani/agent-skills` |
| 🟢 P1 | `mattpocock/skills` | https://github.com/mattpocock/skills | `/grill-with-docs` → CONTEXT.md shared language + ADRs; `/triage`, `/wayfinder`, `/diagnosing-bugs` | Skills layer + dev workflow | `npx skills add mattpocock/skills` |
| 🟡 P2 | `zhaoxuya520/reverse-skill` | https://github.com/zhaoxuya520/reverse-skill | routing.json + tool-index + 163-case regression discipline | Template for Mythos security skills | PowerShell; MIT (GPLv3 submodules) |
| 🟢 P1 | `Nutlope/hallmark` | https://github.com/Nutlope/hallmark | Anti-AI-slop design gate | HUD frontend quality | Skill |
| 🟢 P1 | `tt-a1i/archify` | https://github.com/tt-a1i/archify | Verifiable architecture/workflow/diagram generation (HTML, motion, export) | Plans/ docs + diagrams | Skill |

## 7. Diagnostics & system health

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟢 P1 | `pranshuparmar/witr` | https://github.com/pranshuparmar/witr | Process/port causality ("why is this running?") — Go binary + `--json` | HUD diagnostics; dev debugging | Would have caught the orphaned edge-tts incident instantly |

## 8. Deliverables & media

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟢 P1 | `iOfficeAI/OfficeCLI` | https://github.com/iOfficeAI/OfficeCLI | Word/Excel/PPT read/edit/create, no Office, render→look→fix loop | Agents produce real documents from the HUD | Single binary, Windows build; installs its own SKILL.md |
| 🟡 P3 | `bradautomates/claude-video` | https://github.com/bradautomates/claude-video | `/watch` video understanding (download, frames, transcription) | Media comprehension capability | |
| ⚪ | `OpenCut-app/OpenCut` | https://github.com/OpenCut-app/OpenCut | Video editing engine | Only if Mythos generates video | TS |

## 9. Auth, infra, computation

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟡 P3 | `goauthentik/authentik` | https://github.com/goauthentik/authentik | Self-hosted IdP (OIDC/SSO/MFA) | Only for multi-user remote access | External service, not embedded |
| 🟡 P3 | `Comfy-Org/ComfyUI` | https://github.com/Comfy-Org/ComfyUI | Image-gen engine as a sidecar | Image capability (GPU-gated) | |
| ⚪ | `lyogavin/airllm` | https://github.com/lyogavin/airllm | 70B on 4GB GPU | Edge inference case only | |
| ⚪ | `drawdb-io/drawdb` | https://github.com/drawdb-io/drawdb | DB schema diagram + SQL generation | Only if Mythos grows a DB surface | JS |

## 10. Skip (with reason)

| Repo | Link | Reason |
|---|---|---|
| `google-deepmind/weathernext` | https://github.com/google-deepmind/weathernext | Weather modeling research, no service fit |
| `harveyai/harvey-labs` | https://github.com/harveyai/harvey-labs | Legal-work benchmark |
| `iv-org/invidious` | https://github.com/iv-org/invidious | YouTube frontend, Crystal |
| `every-app/open-seo` | https://github.com/every-app/open-seo | SEO niche |
| `usekaneo/kaneo` | https://github.com/usekaneo/kaneo | Full PM app, heavy |
| `microsoft/AI-For-Beginners` | https://github.com/microsoft/AI-For-Beginners | Course, not a component |
| `ZhuLinsen/daily_stock_analysis` | https://github.com/ZhuLinsen/daily_stock_analysis | Finance niche (unless a finance agent is wanted) |
| `donnemartin/system-design-primer` | https://github.com/donnemartin/system-design-primer | Learning resource — but mintable into an architecture-review skill via book-to-skill |

---

## 11. Web search & research

Added 2026-08-20 (BUG-280). Every row here was measured from this machine on that
date, and the measurements are quoted rather than summarised because two of them
contradict what a reasonable reading of the repos would predict.

| Status | Repo | Link | What to take | Lands in | Notes |
|---|---|---|---|---|---|
| 🟢 **ADOPTED, shipped** | `Aas-ee/open-webSearch` | https://github.com/Aas-ee/open-webSearch | Multi-engine keyless search; MCP server plus a plain REST daemon (`POST /search {query, limit, engines[]}`, `GET /health`) | Shipped: `web-search.js`'s FIRST chain rung, over loopback HTTP to an operator-run daemon. Optional exactly like cua-driver — NOT in `package.json`, connection refused means the rung records the refusal and the chain continues | Apache-2.0 per the **published tarball's LICENSE file**; its `package.json` omits the `license` field, so tooling reports "unknown". **Adopted on one engine, not three.** Measured through its own CLI: startpage 3 relevant results; bing HTTP 301; baidu socket hang up; brave HTTP 429; sogou anti-bot page; duckduckgo and csdn nothing. The plan adopted it "for Bing's reachability" — that justification is void, and it earns its place on startpage alone, because the alternative was a chain with zero working providers. `WEB_SEARCH_ENGINES` defaults to startpage. 203 transitive packages, licence-unaudited — recorded as owed in `THIRD_PARTY_NOTICES.md` |
| 🟡 P2 — **vendored, wired, never executed** | `Panniantong/Agent-Reach` | https://github.com/Panniantong/Agent-Reach | 15-platform reader: Twitter/X, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu, V2EX, LinkedIn, RSS. `doctor --json` health check | Already vendored at `mythos/skills/agent-reach/` (SKILL.md + 6 reference files + LICENSE). Consumer already written: the `RESEARCH FINDINGS` injection into `packBlockFor()` (`Plans/MYTHOS-Post-Parity-Plan.md:1217-1269`) | **Not the fix for BUG-280** — its `references/search.md` routes general web search to **Exa**, which is the provider whose free quota ran out. The CLI is **not installed**, so the injection has never run once against a real `agent-reach`: the shipped-but-inert class. To activate: install the CLI, run `agent-reach doctor --json`, then live-verify the injection actually fires. Owes the step-6.6 resale audit |
| ❌ reject — **unreachable from this host** | `nickclyde/duckduckgo-mcp-server` | https://github.com/nickclyde/duckduckgo-mcp-server | — | — | 1.4k★ MIT, healthy repo, rejected on measurement rather than quality: all three DuckDuckGo hosts fail from this machine (`fetch failed` @10.5s) against a 200-in-234ms `example.com` control. Popularity is not reachability. Do not re-research |
| ❌ reject | public SearXNG instances | https://searx.space | — | — | Measured: `searx.be` returns HTML not JSON (API disabled), `searxng.site` **403**, `priv.au` **403**, `search.bus-hit.me` dead. Self-hosting needs Docker, heavier than the portability rule allows. `slinusc/web-search-mcp-server` (6★, **no licence file at all**) depends on one and is rejected with it |
| ❌ reject | `canilc/mcp-open-webresearch` | https://github.com/canilc/mcp-open-webresearch | — | — | 0★, last pushed 2025-11-18. Same idea as open-webSearch with no adoption signal or maintenance |
| ⚪ ours, not adoptable | Wikipedia full-text API | https://en.wikipedia.org/w/api.php | `action=query&list=search` | Shipped in `web-search.js` | Not an adoption — a defect in our own call. The chain had been using `action=opensearch`, which is title-prefix matching: `London` → 3 hits, `weather in London today` → **0 hits**; full text on the same host → **10 hits**. Listed here so the "why is Wikipedia useless for search" question is not re-asked |

**Not adopted and deliberately so:** nothing was written to replace the DuckDuckGo
rungs. They are unreachable from this operator's network, not broken, and other clones
will reach them.

---

## Recommended sequence

- **Phase 1 (immediate, all 🟢):** speech-to-speech↔OmniRoute voice sidecar · pdf-inspector + book-to-skill ingestion · witr diagnostics · OfficeCLI deliverables · addyosmani + mattpocock + hallmark + archify skills · code-review-graph review gate.
- **Phase 2 (next):** reverse-skill discipline for security skills · **orca decision** (build/borrow/compete) · t3code pattern study. **TencentDB, prime-agent and agency-agents are no longer Phase-2 items here** — they were decided on 2026-08-17 and moved into the roadmap as **merged-order step 8**, lanes 8A-8F, which is now the authoritative place for their design, wiring and sequencing. Step 8 does not start until 6.5, 6.6 and 7 are ticked; nothing in it is implemented yet.
- **Phase 3 (strategic):** pi runtime on OmniRoute · embabel on the phone node · livekit if voice outgrows the sidecar · authentik / ComfyUI / claude-video as needs arise.

## Agent action checklist (what to do with this doc)

1. For every 🟢 P1 row: wire it in (install, add server route/`skill`, add launch-guard test, document in CONTRIBUTING).
2. For every 🟡 row: convert to a decision — adopt, borrow, or defer, and record the decision here (flip the status cell).
3. Keep status cells current; re-run the trending sweep periodically and append new candidates.
