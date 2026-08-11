# Mythos Adoption Matrix — free-only, core-first (brain · memory · skills)

> Status: **parked plan, not executed.** Nothing in here has been installed or wired.
> Source sweep: GitHub trending daily + weekly + monthly, Aug 2026 (43 repos + 13 later additions).
> Revisit before starting Phase 21 work.

## Constraints that govern this list

1. **Free only** — no paid tiers, no hosted API keys, no metered services. Anything whose value
   depends on a key (firecrawl cloud, google/skills → Gemini, LiveKit Cloud, kimi-code) is out.
2. **Core only, for now** — the work is the brain, the memory, and the skills layer. GPU and media
   capabilities (ComfyUI, airllm, OpenCut, claude-video) are real but not this pass; they sit in
   **Future Upgrades** below rather than being dropped or quietly adopted.
3. **Install cost is stated per row.** `MYTHOS-ARCHITECTURE.md` §1.6 says zero new npm deps;
   `mythos/package.json` has already drifted to 9. Exactly one row below adds a dep.

## Ground truth (verified in this checkout)

- Memory already exists and is substantial: `mythos/src/core/memory/` has `semantic.js`,
  `vector-index.js`, `episodic.js`, `lessons.js`, `okf.js`, `chunker.js`, `documents.js`,
  `checkpoints.js`, `working.js`, `audit-writer.js`. The memory work is therefore **a graph +
  provenance layer over what exists**, not a replacement and not a 3-service Tencent deploy.
- `mythos/vault/` is already plain markdown (`Semantic/`, `Episodic/`, `Lessons/`, `Documents/`,
  `Index/`) → an Obsidian-compatible graph is reachable with wikilinks and zero dependencies.
- Skills layer is live: `mythos/skills/` (19 skills), `skills.allowlist`,
  `src/core/skills/{loader,build-pack,run-skill-tool}.js`.
- `mythos/ROADMAP.md` declares itself stale and points at **root `ROADMAP.md`** (2011 lines, last
  phase = Phase 20, `## Risk Register` / `## NOVA Reuse Ledger` / `## Commit Log` at the tail).
  New phases and the deferral list belong in the root file.

---

## 1. Memory — the priority

| Take | Repo | Install cost | Lands in |
|---|---|---|---|
| Tree-sitter code graph + blast radius + risk scoring, over MCP | `tirth8205/code-review-graph` | pip, local-first, no keys | `mythos/mcp/server.js` tool + review/verify gate |
| The 4-asset memory model (Chat Memory L0→L3 · Skill · LLM-Wiki · Code-Graph) as a **schema**, not a deployment | `TencentCloud/TencentDB-Agent-Memory` | none — design only | maps onto `episodic.js` / `skills.js` / `semantic.js` / new code-graph |
| Provenance + accountability edges (every memory fact traceable to its source event) | `semantica-agi/semantica` | none — design only | `semantic.js` + `audit-writer.js` |
| Obsidian-native vault: `[[wikilinks]]` on write, backlink index, free graph view | no repo — Obsidian reads the vault as-is | zero deps | `vault/Semantic`, `Episodic`, `Lessons`, `Index/` |
| PDF classify→Markdown, offline | `firecrawl/pdf-inspector` | **the one new npm dep** (Rust native bindings) | `memory/documents.js` ingestion route |
| Docs/books → on-demand SKILL.md chapters | `virgiliojr94/book-to-skill` | python + local LLM slot | ingestion → `mythos/skills/` |
| Durable goals, evidence logs, verifiable handoffs, quota-aware auto-wake | `huangruiteng/loopx` | none — design only | `src/core/goals/`, `quota.js`, `memory/lessons.js` |
| `/refine` continual-improvement loop, durable memories | `PrimeIntellect-ai/prime-agent` | none — design only | cortex tick + lessons |
| Current-state → ideal-state hill climbing | `danielmiessler/LifeOS` | none — design only | `vault/Goals.md` + goals module |

## 2. Skills layer — all text, zero runtime cost

| Take | Repo | Notes |
|---|---|---|
| 24 lifecycle skills + reviewer personas | `addyosmani/agent-skills` | `npx skills add addyosmani/agent-skills` |
| `/grill-with-docs` → CONTEXT.md + ADRs, `/triage`, `/wayfinder`, `/diagnosing-bugs` | `mattpocock/skills` | `npx skills add mattpocock/skills` |
| Anti-AI-slop design gate | `Nutlope/hallmark` | applies to HUD work |
| Verifiable architecture / sequence / data-flow diagrams (self-contained HTML) | `tt-a1i/archify` | for `Plans/` + docs |
| routing.json + tool-index + regression discipline | `zhaoxuya520/reverse-skill` | MIT — **leave the GPLv3 submodules out** |
| Specialized agent personas | `msitarzewski/agency-agents` | cherry-pick into the roster |
| 100+ agent/RAG recipes | `Shubhamsaboo/awesome-llm-apps` | mine on demand |

Free corpora to mint through `book-to-skill`: `donnemartin/system-design-primer`,
`DataExpert-io/data-engineer-handbook`, `microsoft/AI-For-Beginners`.
Every imported skill needs a `skills.allowlist` entry.

## 3. Brain / loop / ops

| Take | Repo | Install cost | Notes |
|---|---|---|---|
| Role pipeline (specifier→coder→cleaner→architect→QA) + constitution articles | `unclebob/swarm-forge` | none — design | tmux/zsh impl not Windows-portable |
| Prefix-cache stability for an always-on daemon | `esengine/DeepSeek-Reasonix` | none — design | Go |
| RAM discipline for background agents | `1jehuang/jcode` | none — design | Rust |
| Process/port causality ("why is this running?") | `pranshuparmar/witr` | free Go binary, `--json` | HUD diagnostics; would have caught the orphaned edge-tts child |

---

## Proposed roadmap phases (to append to root `ROADMAP.md` after Phase 20)

- **Phase 21 — Memory graph layer.** code-review-graph over MCP + graph/provenance edges in
  `semantic.js` + accountability link into `audit-writer.js`.
- **Phase 22 — Obsidian-native vault.** Wikilinks on write, backlink index in `vault/Index/`; the
  graph opens in Obsidian with no exporter and no deps.
- **Phase 23 — Ingestion → skills pipeline.** pdf-inspector → `documents.js` → book-to-skill →
  `mythos/skills/` + allowlist; mint the three free corpora.
- **Phase 24 — Skills pack import + quality gates.** The five packs; hallmark on HUD work; archify
  for diagrams; reverse-skill's routing/regression discipline for security skills.
- **Phase 25 — Durable loop + ops.** loopx / prime-agent / LifeOS patterns (evidence logs,
  verifiable handoffs, quota-aware auto-wake, goal hill-climbing) + witr diagnostics.

Each phase to be written in the root file's existing shape (goal, scope, tests, gate), marked
`⬚ Pending`, and added to the `## Progress` table.

## Future Upgrades (deferred, not scheduled)

| Repo | Why deferred |
|---|---|
| `OpenCut-app/OpenCut` | Video editing — no Mythos surface needs it yet |
| `Comfy-Org/ComfyUI` | GPU-gated image generation; not core |
| `lyogavin/airllm` | Local 4GB-GPU inference; revisit if provider tiers become the bottleneck |
| `bradautomates/claude-video` | `/watch` comprehension; needs yt-dlp + local Whisper wiring |
| `iOfficeAI/OfficeCLI` | Word + render→look→fix only — `exceljs` + `pptxgenjs` already cover Excel/PPT |
| `vitali87/code-graph-rag` | Free but needs Docker + Memgraph + cmake; Phase 21 is lighter |
| `goauthentik/authentik` | Only if Mythos goes multi-user remote |
| `drawdb-io/drawdb` | Only if Mythos grows a DB surface |
| `ruvnet/RuView` | WiFi-CSI presence sensing; needs a CSI-capable NIC |
| `embabel/embabel-agent` | Kotlin GOAP for `nodes/phone` once it grows past voice relay |
| `livekit/agents` | Server is Apache-2.0 but the good STT/TTS plugins are cloud |
| `earendil-works/pi` + `agegr/pi-web` | Only if Mythos stops shelling out to a coding agent |
| `stablyai/orca` · `paperclipai/paperclip` · `pingdotgg/t3code` | One fleet-surface decision (build/borrow/compete) — deferred as one |
| `HKUDS/DeepTutor` | Only if tutoring becomes a Mythos agent |

## Excluded by the free rule (recorded, not revisited)

`firecrawl` cloud (paid; `playwright-core` is already a dep — scrape in-house) · `google/skills`
(Gemini key) · LiveKit Cloud · `MoonshotAI/kimi-code` (paid Kimi API) ·
`google-deepmind/weathernext` (Earth Engine access) · `every-app/open-seo` (paid SEO data) ·
`TauricResearch/TradingAgents` + `ZhuLinsen/daily_stock_analysis` (market-data keys) ·
`harveyai/harvey-labs` · `NanmiCoder/MediaCrawler` (platform-ToS risk) · `usekaneo/kaneo` ·
`iv-org/invidious` · `LadybirdBrowser/ladybird` · `opa334/Dopamine` (iOS; phone node is Kotlin) ·
`kangarooking/cangjie-skill` (duplicate of book-to-skill).

## When resumed — verification

- Every adopted row is free, keyless, and its install cost matches what actually got installed.
- Root `ROADMAP.md`: Phases 21–25 present with gates, `## Progress` rows added, and the Future
  Upgrades list carried over intact.
- `mythos/ROADMAP.md` still just points at root — do not resurrect the duplicate.
- `cd mythos && npm test` green.
