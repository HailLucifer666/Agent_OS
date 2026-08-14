# Free-tier model map — measured 2026-08-14

## AS BUILT — what actually shipped (2026-08-15)

**This section is the authority. Everything below it is the measurement run and
the recommendation drafts that produced it**, written before the operator's
scoping decisions, and several of those tables disagree with each other and with
what shipped (three separate drafts propose three different homes for `mull`).
Read this section for what the code does; read the rest for the evidence and the
reasoning.

Shipped in one change: two new lanes, nine re-pointed call sites, three silent
breakages fixed, and the `think_deeply` tool.

| Role | Lane | Head of chain | Changed? |
|---|---|---|---|
| Voice conversation | — (Live WS) | `gemini-3.1-flash-live-preview` | no — capped at Flash tier, no alternative exists |
| `screen_look` / `camera_look` / screen sensor / build render verify | `vision` | Google `gemini-3.5-flash-lite` → Mistral `mistral-small-latest` → … → NIM last | **yes** |
| Memory consolidation (×3 call sites), document answer | `memory` **(new)** | Google `gemini-3-flash-preview` → Mistral `mistral-medium-2604` → Cerebras `gemma-4-31b` | **yes** |
| `mull`, self-reflection (×2), reviewer, reality-checker, design verify, orchestrator synthesize, `ask_agent`, engagement interview | `reasoning` **(new)** | Cerebras `gpt-oss-120b` → Cerebras `zai-glm-4.7` → NIM `nemotron-3.5-lightning-30b-a3b` → Mistral `mistral-medium-2604` | **yes** |
| `think_deeply` **(new tool)** | `reasoning` | same chain, bounded 20s total / 7s per attempt | **new** |
| Typed / batch chat, announcements, daily brief | `voice` | Google `gemini-flash-lite-latest` (Groq demoted to rank 4) | **yes** |
| Build fallback / engagements | `build` | Mistral `codestral-latest` → `mistral-medium-2604` → `mistral-large-2512` | reordered |
| Goal reasoning | `simple` / `build` | unchanged | **no** — deliberate, see below |
| Incident explainer, trivial / formatting | `simple` | Groq `llama-3.1-8b-instant` | **no** — the one role Groq's 12k window suits |
| Embeddings | `embed` | unchanged | **no** — new dimensions invalidate every stored vector |
| Long document | `text` | dead entries dropped; still no caller | hygiene only |
| Build content (Hermes) | — (CLI) | `mistral-large-2512`, Hermes-owned config | **no** — deferred |

### Where this departs from the drafts below, and why

- **`mull` went to `reasoning` (Cerebras), not to a Google model.** The draft
  tables suggest `gemini-3.7-flash` / `gemini-3.5-flash-lite`; the operator's
  scoping put all seven low-frequency thinking roles on one lane. Nothing waits
  on `mull`, so Cerebras's 5 req/min is not a constraint for it.
- **Memory consolidation went to Google, not Mistral.** Mistral's 4 req/min is
  shared with Hermes builds and with embeddings, and consolidation is one of the
  two frequent consumers. Keeping it off Mistral is the whole point.
- **Trivial/formatting stayed on Groq**, against draft row 9. Groq's 12,000-token
  window is a genuine fit for small prompts and a genuine misfit for everything
  else; moving the one role that fits it buys nothing.

### Three silent breakages the rewire would have caused, all fixed

1. **Persona injection** — `brain/index.js` injected a persona only for lanes
   `voice`/`build`/`simple`. The reviewer and reality-checker seats pass a
   `persona` argument and moved to `reasoning`, which would have dropped it in
   silence. `reasoning` and `memory` were added to that list in the same change.
2. **Terse styling** — `BRAIN_TERSE_LANES` defaulted to `simple`, so every
   lane-simple caller got compression implicitly. The default is now
   `simple,memory`: kept for memory (summaries should stay compact), dropped for
   reasoning (compressing a reasoning answer defeats the lane).
3. **Unknown-lane fallback** — `registry.chainFor()` substituted the caller-less
   `text` lane for any unrecognised name, so a typo produced no error at all.
   It now emits `health.anomaly` and a stderr line, and
   `test/brain-lane-wiring.test.js` asserts every literal `lane:` string in
   `src/` resolves to a real lane.

### Deliberately not changed, each with a code comment and a test

Live voice model (no Pro Live exists at any price) · embeddings (dimension
change) · `goals/index.js` (dynamic lane argument, and the highest-frequency
brain caller — putting the cortex loop on Cerebras's 5/min would starve the seven
roles the lane exists for) · `immune/explainer.js` (picks one of three fixed
values; nothing to gain) · Groq for trivial formatting · NIM kept as a vision
fallback rather than deleted, because the breakers are self-correcting and a
deletion is not.

### Still open

- **Hermes's own build model.** `devstral-medium-latest` (12/12 @ 1593ms) is the
  candidate and `lanes.default.js`'s "41s" exclusion contradicts that
  measurement. Settle with `build-refine.js`'s real render check over real
  builds. Model lives in `Hermes Agent/config.yaml`, which forwarded env does
  not override.
- **`vault/Personas/` is empty**, so the reviewer and reality-checker seats now
  reach a strong model with a generic brief. Breakage 1 is fixed, so authoring
  those files will take effect without further code changes.
- **Re-probe `gemini-3.7-flash` (1/4) and `gemini-3.6-flash` (3/4) clean.** Both
  scored low only because this run's own request volume hit their RPM wall.
- **The benchmark is thin** — one sample per probe, ~50-token prompts, seven
  models tied at 4/4. Re-probe at realistic size before treating the reasoning
  order as settled.

---

## FINAL side-by-side: current vs suggested

Google vision verified with a real 320KB screenshot (an 8×8 test PNG returns
"Unable to process input image" and is a false negative — do not conclude from it):
`gemini-3.5-flash-lite` **1473ms**, `gemini-flash-lite-latest` 1883ms,
`gemini-3.5-flash` **32145ms** (avoid).

| Role | Freq | **CURRENTLY** | **SUGGESTED** | Why |
|---|---|---|---|---|
| **Voice conversation** | constant | Google `gemini-3.1-flash-live-preview` (Live WS, bypasses `chain.js`) | **unchanged** | No Pro Live model exists at any price; Live has its own quota pool |
| **Vision** | **frequent** | NIM `nemotron-nano-12b-v2-vl` → Mistral `mistral-small-latest` | **Google `gemini-3.5-flash-lite`** → Mistral `mistral-small-latest` → NIM (last, breakered) | NIM head is dead: 4015ms + 4002ms timeouts then a 500, so 8s wasted per look. Google is **1473ms verified** and has its own quota |
| **Memory consolidation** | **frequent** | Groq `llama-3.1-8b-instant` | **Google `gemini-3-flash-preview`** | 4/4; separate per-model bucket from vision |
| **Build (Hermes)** | periodic, heavy | Mistral `mistral-large-2512` (Hermes `config.yaml`) | **unchanged** — but make it Mistral's only heavy user | 250k tokens/min suits bulk generation |
| **Deep reasoning in a turn** | occasional | **does not exist** | **NEW `think_deeply`** → Cerebras `gpt-oss-120b` → NIM `nemotron-3.5-lightning-30b` | 4/4 @ 778ms, reasoning in a separate field. **Only route from a conversation to a good model** |
| **Background `mull`** | periodic | Groq `llama-3.1-8b-instant` | **Google `gemini-3.7-flash`** (re-probe first) | Own bucket; keeps Cerebras free for reviews |
| **Reviewer / reality-checker** | occasional | Groq 8B **+ `persona: null`** | **Cerebras `zai-glm-4.7`** + populate `vault/Personas/` | 4/4; currently generic, not specialised |
| **Self-reflection** | rare | Groq `llama-3.1-8b-instant` | Cerebras `zai-glm-4.7` | same bucket, negligible volume |
| **Typed / batch chat** | occasional | Groq `llama-3.3-70b-versatile` (**2/4**) | **Google `gemini-flash-lite-latest`** | 4/4 @ 961ms, only model with zero flags |
| **Spoken announcements** | rare | Groq `llama-3.3-70b-versatile` (**2/4**) | Google `gemini-flash-lite-latest` | COT-LEAK disqualifies Mistral for spoken output |
| **Trivial / formatting** | frequent, tiny | Groq `llama-3.1-8b-instant` | **unchanged** | Groq's 12k-token window only ever suited small prompts |
| **Embeddings** | frequent, tiny | Ollama `nomic-embed-text` (**offline**) → Mistral `mistral-embed` | **unchanged** | New dimensions would invalidate every stored vector |
| **Long document** | none | Cerebras `zai-glm-4.7` → `ling-3.0-flash:free` (**404 DEAD**) | drop the dead entry; **no free 262K option remains** | lane has no caller anyway |

### Provider load after the change

| Provider | Budget | Before | After |
|---|---|---|---|
| **Groq** | 12k tokens/window | ~6 roles | **1** (trivial only) |
| **Google** | ~6–10 RPM **per model** | 1 role | **5 roles across 5 different models** + Live on its own pool |
| **Cerebras** | 5/min, 2400/day, 1M tok/day | 0 (lane had no caller) | 3 low-frequency reasoning roles |
| **Mistral** | 4/min, 250k tok/min | builds + vision fallback + embeddings | builds + embeddings + vision *fallback only* |
| **NIM** | unmeasured, per-model | vision primary | fallbacks only, behind breakers |

The two frequent users — **vision and memory — now sit on different providers**, and
neither is Mistral, so neither competes with Hermes builds.

**Remaining contention, stated rather than hidden:** embeddings cannot leave
Mistral (vector dimensions), so embeddings and builds share the 4 req/min. Watch
that one.

---


What each configured API key can actually reach, how good it is, what it costs in
quota, and which MYTHOS role it should serve.

**Everything here is measured, not recalled.** Method follows
`lanes.default.js`'s own rule — a real completion call per entry, never a catalog
listing (listings lie: 4 models listed fine on these keys and then returned 404,
429 or timed out). Rate limits are read from live response headers, not from
provider marketing pages.

## Method and its limits

Four probes per model, `temperature: 0`, `max_tokens: 2500`:

| Probe | What it tests | Correct answer |
|---|---|---|
| **R1** | multi-step constraint reasoning (book ordering) | `4` |
| **R2** | inverted age word-problem | `40` |
| **J** | strict JSON with a REQUIRED key, and an explicitly forbidden one — a miniature of the 2026-08-14 `open_web` failure, where the model passed `query` where the contract demanded `url`, 5 times out of 5 | `{"url":"…openai…","type":"web"}`, no `query` key |
| **H** | refuses to invent an unknowable fact | declines |

Two documented disqualifiers are also flagged: chain-of-thought leaking into
`content` (would be **spoken aloud** on the voice lane) and array-shaped
`content` (renders as `[object Object]`).

**Known weaknesses of this table, stated so nobody over-trusts it:**

- **One sample per probe.** BUGS.md's own lesson (`one-sample-hides-model-flakiness`)
  is that a single lucky reply proved nothing for a widget build that was actually
  0/3. Treat scores as a screen, not a ranking. Re-run before demoting anything.
- **The COT-LEAK flag is a heuristic**, not proof: a regex for `<think>` tags and
  for answers opening with "Okay/Alright/First/Hmm". A model that simply begins a
  sentence that way is flagged without leaking anything. Verify by eye before
  acting on it.
- **A first benchmark run had the R1 answer wrong** (checked for `2`; the answer
  is `4`), which inverted that column and scored correct reasoners as failures.
  The numbers below are from the corrected run. Mentioned because the same
  mistake is easy to repeat.
- Groq was **already rate-limited** partway through, so its scores are a floor.

## Measured quota (live response headers)

| Provider | Binding limit | Also | Header source |
|---|---|---|---|
| **Cerebras** | **5 req/min** | 150/hour, **2400/day**, 1,000,000 tokens/day, 30k tokens/min | `x-ratelimit-*` |
| **Mistral** | **4 req/min** | 250,000 tokens/min. **No daily header exposed** | `x-ratelimit-limit-req-minute` |
| **Groq** | **12,000 tokens** per window (~1 min) | 1000 requests; limits are **per-model** | `x-ratelimit-limit-tokens` |
| **NVIDIA NIM** | not exposed | per-model 429s observed | — |
| **Google** | not exposed | Flash only; **zero** Pro requests on free tier | — |

### Three corrections to what we assumed

1. **Cerebras is not the scarce one — it's the most generous.** Assumed 100–500
   requests/day; measured **2400/day plus 1M tokens/day**. It is only tight
   *per-minute* (5/min).
2. **Mistral's "1B tokens/day" is unconfirmed.** No daily header is exposed. What
   *is* certain is **4 requests/minute**, which is the real constraint and is
   tighter than Cerebras.
3. **Groq's token budget is tiny — 12,000 per window.** `lanes.default.js` notes
   the voice lane's prompt is ~40k chars (≈10k tokens), so a *single* voice turn
   nearly exhausts Groq's window. This is the likely cause of the repeated Groq
   429s, and it makes Groq a poor choice for the voice lane's first position.

### Consequence for design: no intra-provider parallelism

4–5 requests/minute means **best-of-N cannot fan out across models within one
provider.** It must fan out *across* providers — one call each to Cerebras +
Mistral + NIM. This invalidates an earlier plan to run parallel samples on
Mistral.

## Results — models that scored 4/4

| Score | Median | Provider | Model | Notes |
|---|---|---|---|---|
| **4/4** | **778ms** | Cerebras | **`gpt-oss-120b`** | reasoning in a separate field — clean |
| **4/4** | **1030ms** | Google | **`gemini-flash-lite-latest`** | **no flags at all** — cleanest result in the run |
| **4/4** | 1306ms | Cerebras | **`zai-glm-4.7`** | reasoning separated |
| 4/4 | **461ms** | Mistral | `mistral-medium-2604` | fastest 4/4; COT-LEAK flag |
| 4/4 | 783ms | Mistral | `mistral-medium-latest` | COT-LEAK flag |
| 4/4 | 1213ms | Mistral | `magistral-small-latest` | COT-LEAK flag (it is a reasoning model) |
| 4/4 | 4123ms | NIM | `nvidia/nemotron-3.5-lightning-30b-a3b` | reasoning separated |
| 4/4 | 4741ms | NIM | `nvidia/nemotron-3-nano-30b-a3b` | reasoning separated |
| 4/4 | 4975ms | Google | `gemini-3.6-flash` | slower today than the 1382ms on record |
| 4/4 | 13395ms | NIM | `stepfun-ai/step-3.7-flash` | too slow for interactive |
| 4/4 | 27856ms | NIM | `nvidia/nemotron-3-super-120b-a12b` | **27.9s** — unusable interactively |

### Scored below 4/4

| Score | Median | Provider | Model | Missed |
|---|---|---|---|---|
| 3/4 | 336ms | Cerebras | `gemma-4-31b` | R1 |
| 3/4 | 701ms | Mistral | `mistral-large-2512` | R2 — **beaten by mistral-medium** |
| 3/4 | 693ms | Mistral | `mistral-small-latest` | R2 |
| 3/4 | 828ms | Groq | `openai/gpt-oss-120b` | rate-limited mid-probe |
| 3/4 | 9180ms | NIM | `nvidia/nemotron-3-ultra-550b-a55b` | HTTP 503; 550B is not usable |
| 2/4 | 258ms | Groq | `llama-3.3-70b-versatile` | **R1 and R2** — currently first in `PREF_VOICE` |
| 2/4 | 664ms | Mistral | `ministral-14b-latest` | R1, R2 |
| 2/4 | 1933ms | Groq | `qwen/qwen3.6-27b` | rate-limited; COT-LEAK |
| 2/4 | 3378ms | Google | `gemini-flash-latest` | **HTTP 503 right now** |
| 1/4 | 965ms | NIM | `z-ai/glm-5.2` | 429 |
| 0/4 | 268ms | NIM | `minimaxai/minimax-m3` | 429 |

### Dead on these keys — do not list them

| Model | Result |
|---|---|
| `gemini-3.1-pro-preview`, `gemini-pro-latest` | **429 in ~200–430ms** — plan gate, zero free Pro requests |
| `gemini-2.5-pro` | 404 "no longer available to new users" — will not return with billing |
| `openrouter: inclusionai/ling-3.0-flash:free` | **404 "unavailable for free. The paid version…"** |
| `moonshotai/kimi-k2.6` | 404 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | 404 |
| `deepseek-ai/deepseek-v4-flash-0731` | 60s timeout |
| `mistral: glm-5-2` / `zai-glm-5-2` | 429 (listed, not reachable) |
| `deep-research-pro-preview-12-2025` | 400 — Interactions API only |

**This means `lanes.default.js` currently contains a dead entry.**
`inclusionai/ling-3.0-flash:free` appears in both `PREF_TEXT` and `PREF_BUILD`,
described as the 262K-context long-document workhorse. It is 404 for free now, so
every chain walk through those lanes burns an attempt on it — the exact failure
that file's header says it was rewritten to eliminate.

## Google tier — settled by Google's own quota IDs

The key is **free tier**, confirmed not by inference but by the `QuotaFailure`
detail Google returns on a Pro-model call:

```
GenerateRequestsPerDayPerProjectPerModel-FreeTier
GenerateRequestsPerMinutePerProjectPerModel-FreeTier
GenerateContentInputTokensPerModelPerDay-FreeTier
GenerateContentInputTokensPerModelPerMinute-FreeTier
   metric: generate_content_free_tier_requests    model: gemini-3.1-pro
```

A Google One / Gemini Advanced subscription is a **consumer** plan and grants no
API quota; API billing is separate (AI Studio paid tier / Vertex). Every Pro-tier
and premium model 429s in ~200–250ms — a plan gate, not a transient limit:
`gemini-3.1-pro-preview`, `-customtools`, `gemini-pro-latest`,
**`gemini-2.5-computer-use-preview`**, `gemini-omni-flash-preview`. The
computer-use model would be directly useful for MYTHOS's UI automation and is
locked behind the same gate.

Google **no longer publishes free-tier numbers** (docs defer to AI Studio's
per-project dashboard), so these were measured by burst:

| Model | Measured | Quota hit | retryDelay |
|---|---|---|---|
| `gemini-3.7-flash` | 6 ok / 12 burst | `…PerMinutePerProjectPerModel-FreeTier` | 47s |
| `gemini-3.6-flash` | 6 ok / 12 burst | same | 25s |

Prior probe calls consumed part of that minute, so the true ceiling is likely
~10 RPM. **What is certain: the binding limit is per-minute, PER MODEL, per
project.** That means switching roles onto *different Google models* buys genuinely
independent capacity — the single most useful fact for load spreading below.

### Reachable Google models, re-probed

| Score | Median | Model |
|---|---|---|
| **4/4** | **960ms** | `gemini-3.5-flash-lite` |
| **4/4** | **961ms** | `gemini-flash-lite-latest` |
| 4/4 | 3082ms | `gemini-3.5-flash` |
| 4/4 | 3090ms | `gemini-3-flash-preview` |
| 3/4 | 44382ms | `gemini-3.6-flash` — **throttled during the run** |
| 1/4 | 15822ms | `gemini-3.7-flash` — **throttled during the run** |

`3.6-flash` had scored 4/4 @ 4975ms earlier the same day. Its collapse to 44s, and
`3.7-flash`'s 1/4, are **my own request volume hitting the 6–10 RPM wall**, not
model quality. Both need a clean re-probe before being judged. Dead: `gemini-2.5-flash`
(404, "no longer available to new users"); `antigravity-preview`, all
`deep-research-*` (400, Interactions API only).

## Hermes CLI's model

`Hermes Agent/config.yaml` → `model.default: mistral-large-2512`, provider
`openai-api`, base URL `https://api.mistral.ai/v1`. Two consequences:

1. It scored **3/4** here (missed R2) while `mistral-medium-2604` scored 4/4 and is
   faster — but Hermes owns its own config and MYTHOS's forwarded env does not
   override it, so this is a Hermes-side change.
2. **Hermes shares MYTHOS's Mistral key**, so every build competes with any MYTHOS
   role on Mistral's 4 req/min. Builds are the token-heaviest workload in the
   system, which is why the allocation below gives Mistral to builds and moves
   almost everything else off it.

## Load-spread allocation — no two heavy users on one provider

Frequency weighting per the operator: **vision = frequent, memory = frequent,
build = periodic but token-heavy, voice = constant.**

| Role | Frequency | Provider | Model | Why this slot |
|---|---|---|---|---|
| **Voice conversation** | constant | Google **Live API** | `gemini-3.1-flash-live-preview` | `bidiGenerateContent` — a **separate quota pool** from `generateContent`, so it costs nothing from the budgets below |
| **Vision** | **frequent** | NIM → Google | `nemotron-nano-12b-v2-vl` → `gemini-3.5-flash` | NIM primary is live-verified; fallback moved **off Mistral** so it cannot collide with builds |
| **Memory consolidation** | **frequent** | Google | `gemini-3-flash-preview` | Own per-model RPM, distinct from every other Google role here |
| **Build (Hermes)** | periodic, heavy | Mistral | `mistral-large-2512` (Hermes-owned) | Mistral's 250k tokens/min is the best fit for bulk generation — and it becomes Mistral's **only** heavy user |
| **`think_deeply`** | occasional | Cerebras → NIM | `gpt-oss-120b` → `nemotron-3.5-lightning-30b` | Best measured reasoning (4/4 @ 778ms), reasoning in a separate field |
| **Background `mull`** | periodic | Google | `gemini-3.5-flash-lite` | 4/4 @ 960ms, own RPM bucket |
| **Reviewer / reality-checker** | occasional | Cerebras | `zai-glm-4.7` | 4/4; infrequent enough to share Cerebras's 5/min with `think_deeply` |
| **Self-reflection** | rare | Cerebras | `zai-glm-4.7` | same bucket, negligible volume |
| **Typed / batch chat** | occasional | Google | `gemini-flash-lite-latest` | 4/4 @ 961ms, own RPM bucket |
| **Trivial / formatting** | frequent, tiny | Groq | `llama-3.1-8b-instant` | Groq's 12k-token window only suits small prompts — this is the one role that fits it |
| **Embeddings** | frequent, tiny | Mistral | `mistral-embed` | Cannot move — different dimensions would invalidate every stored vector. **Accepted risk:** shares Mistral's 4 req/min with builds |

### Resulting provider load

| Provider | Budget | Carries | Collision risk |
|---|---|---|---|
| **Google** | ~6–10 RPM **per model** | 5 roles on **5 different models** + Live on its own pool | low — each has an independent bucket |
| **Cerebras** | 5/min, 2400/day, 1M tok/day | 3 low-frequency reasoning roles | low |
| **Mistral** | 4/min, 250k tok/min | builds + embeddings only | **watch this one** — the only known contention |
| **NIM** | unmeasured, per-model | vision primary + reasoning fallback | low |
| **Groq** | 12k tokens/window | trivial formatting only | low |

Groq drops from ~6 roles to 1. Mistral drops from vision-fallback + build to
build + embeddings. Google gains four roles but spread across four models with
separate quotas, which is why that concentration is safe.

## Side-by-side: what runs today vs what should

Scores are from the probe set above. The **Impact** column is the honest part:
most lane paths in this repo are not actually exercised, so changing them changes
nothing you can feel. Read that column before spending time on a row.

| # | Role | Runs today | Score | Recommended | Score | Impact |
|---|---|---|---|---|---|---|
| 1 | **Voice conversation** (every action, every reply) | Google `gemini-3.1-flash-live-preview` via Live WebSocket — **bypasses `chain.js` entirely** | n/a | **unchanged — no alternative exists** | — | — |
| 2 | **Deep reasoning in a turn** | **does not exist** | — | **NEW `think_deeply` tool** → Cerebras `gpt-oss-120b` → `zai-glm-4.7` → NIM `nemotron-3.5-lightning-30b` | 4/4 @ 778ms | **HIGHEST — the only way to reach a good model from a conversation** |
| 3 | **Background anticipation** (`mull`, cortex tick) | Groq `llama-3.1-8b-instant` | — (8B, rate-limited in probe) | **Cerebras `gpt-oss-120b`** (reasoning separated, so nothing leaks into speech) | 4/4 @ 778ms | **REAL** — this is your proactivity |
| 4 | **Memory consolidation** | Groq `llama-3.1-8b-instant` | — | **Mistral `mistral-medium-2604`** (250k tokens/min suits bulk work) | 4/4 @ 461ms | **REAL** — better recall summaries |
| 5 | **Self-reflection** (`identity/reflection.js`) | Groq `llama-3.1-8b-instant` | — | Cerebras `gpt-oss-120b` | 4/4 @ 778ms | moderate |
| 6 | **Reviewer / reality-checker** | Groq 8B **+ `persona: null`** (`vault/Personas/` is empty) | — | Cerebras `zai-glm-4.7` **+ populate `vault/Personas/`** | 4/4 @ 1306ms | **REAL** — currently generic, not specialised |
| 7 | **Typed / batch chat** (`voice-agent`, lane `voice`) | Groq `llama-3.3-70b-versatile` | **2/4** | **Google `gemini-flash-lite-latest`** — only model with **zero flags** | 4/4 @ 1030ms | moderate — not the Live path |
| 8 | **Spoken announcements** (`announcer.js`) | Groq `llama-3.3-70b-versatile` | **2/4** | **Google `gemini-flash-lite-latest`** — COT-LEAK is disqualifying for anything spoken aloud | 4/4 @ 1030ms | small |
| 9 | **Trivial / formatting** | Groq `llama-3.1-8b-instant` | — | Cerebras `gemma-4-31b` | 3/4 @ 336ms | small |
| 10 | **Vision** (`screen_look`, `camera_look`) | NIM `nemotron-nano-12b-v2-vl` → Mistral `mistral-small-latest` | — | **unchanged** — live-verified 2026-08-14 (`attemptsTried:3`) | — | none needed |
| 11 | **Builds** | Hermes-Agent CLI (no API call) | — | **unchanged** — single-engine rule | — | none |
| 12 | **Build fallback / engagement spec** (lane `build`) | Mistral `codestral-latest` | — | keep; reorder `mistral-medium-2604` above `mistral-large-2512` | 4/4 vs 3/4 | ~zero (Hermes bypasses) |
| 13 | **Long document** (lane `text`) | Cerebras `zai-glm-4.7` → **`ling-3.0-flash:free` (404 DEAD)** | — | drop the dead entry; **no free 262K option remains** | — | ~zero (**no caller**) |
| 14 | **Embeddings** | Ollama `nomic-embed-text` (**offline**) → Mistral `mistral-embed` | — | **unchanged** — new dimensions would invalidate every stored vector | — | none |

### Reading the Impact column

- Rows **2, 3, 4, 6** are the ones worth doing. Two of them (3, 4) simply move
  work off an 8B model; one (6) is a missing data file; one (2) is new code.
- Rows **12, 13** are dead paths — `lane: 'text'` has no caller at all, and
  Hermes bypasses `lane: 'build'`. Fix as hygiene, expect no felt change.
- Row **1 cannot be improved.** It is what answers you, and it is capped.

### Why Groq loses almost every row

Not capability alone — **quota shape**. Measured limit is 12,000 tokens per
~1-minute window, per model, while `lanes.default.js` records the voice prompt at
~40k chars (≈10k tokens). One turn nearly exhausts the window, which is why Groq
429'd repeatedly during this benchmark. It stays useful only where prompts are
genuinely small.

## Recommended role assignment

| Role | Model | Why |
|---|---|---|
| **Conversation (voice)** | `gemini-3.1-flash-live-preview` (unchanged) | No alternative exists — all 6 Live-capable models are Flash tier; Pro Live returns 404 |
| **Deep reasoning** (`think_deeply`, reviewer, reality-checker) | **Cerebras `gpt-oss-120b`** → **Cerebras `zai-glm-4.7`** → NIM `nemotron-3.5-lightning-30b` | 4/4 at sub-1.4s with reasoning properly separated; 2400 req/day affords it |
| **Background thinking** (`mull`, memory consolidate, reflection) | **Mistral `mistral-medium-2604`** → Cerebras `gpt-oss-120b` | 4/4 at 461ms; 4 req/min is fine for a loop that fires every 300 ticks |
| **Best-of-N** (hard, consequential questions) | one call each: Cerebras `gpt-oss-120b` + Mistral `mistral-medium-2604` + NIM `nemotron-3.5-lightning-30b` | Must be cross-provider — per-minute caps forbid intra-provider fan-out |
| **Fast/trivial** (formatting, classification) | Cerebras `gemma-4-31b` (336ms) or Mistral `mistral-small-latest` | Cheap work belongs on cheap models |
| **Vision** | NIM `nemotron-nano-12b-v2-vl` → Mistral `mistral-small-latest` | Unchanged; live-verified working 2026-08-14 with `attemptsTried:3` |
| **Long context** | *nothing free right now* | The 262K OpenRouter slug is dead; largest remaining free context is unmeasured |
| **Embeddings** | Mistral `mistral-embed` | Unchanged — swapping dimensions invalidates every stored vector |

### Changes this implies to `lanes.default.js`

1. **Remove `inclusionai/ling-3.0-flash:free`** from `PREF_TEXT` and `PREF_BUILD` — 404.
2. **Demote Groq `llama-3.3-70b-versatile`** from first in `PREF_VOICE`: scored
   **2/4**, and its 12k-token window cannot hold the lane's ~40k-char prompt.
3. **Remove `nemotron-3-super-120b-a12b`** from `PREF_TEXT` — 27.9s median far
   exceeds any interactive budget, and exceeds `CHAIN_ATTEMPT_TIMEOUT_MS` intent.
4. **Add a `reasoning` lane** led by Cerebras `gpt-oss-120b`, and point `mull`,
   `memory:consolidate` and `reflection` at it instead of `simple` (Groq 8B).
5. **`mistral-medium-2604` should outrank `mistral-large-2512`** everywhere — it
   scored higher (4/4 vs 3/4) and is faster (461ms vs 701ms).

### One open risk in already-shipped code

`VISION_ATTEMPT_TIMEOUT_MS` is **4000ms** (committed `2cd82ae`). Google answered
at **3115ms** in this run against the 1382ms on record. A provider answering at
3.1s is close to being cut off while working. Revisit once a few sessions of
`vision.attempt` telemetry exist — that is what it was added for.
