# Usable models by provider — measured 2026-08-22

**Every model listed here answered a real request from this machine.** Models that
errored are not listed: a model that will not answer is not a choice. The
failures are recorded in the "dead and why" section at the end only where they
correct something this repo currently believes.

Regenerate rather than hand-edit:

```bash
node mythos/scripts/audit-providers.js --top 25
node mythos/scripts/audit-providers.js --provider mistral --all --markdown mythos/docs/USABLE-MODELS.md
```

This file exists because model ids go stale fast and three separate sessions
guessed them wrong from memory. It does **not** replace
`mythos/docs/free-tier-model-map.md`, which answers a different question — *why*
each role sits on the lane it does. That reasoning is unaffected by anything here.

## How to read the columns

| Column | Meaning |
|---|---|
| **tools** | Does the model actually EMIT a tool call. **This is the agentic gate.** A build engine writes files through tools, so `chat only` cannot drive a build however good its prose is. |
| **10k** | Does it accept a ~10.7k-token request. That is DeepSeek Harness's *measured* fixed overhead — system prompt plus tool definitions, before any task text, read off Groq's 413s twelve times with a ~120-token spread. A `413` here means the model cannot host dsh at all. |
| **cost** | Only OpenRouter and b.ai publish per-model pricing. `unpriced` means the API discloses no price — **not** that it is free. A 200 on an unpriced route means it costs nothing extra on this key today. |

✅ = passes all three. 💬 = answers, but cannot drive an agentic build.

---

## Mistral — the strongest provider on this machine

14 of 14 tested pass all three gates. Two are purpose-built for agentic coding.

| Model | tools | 10k | Note |
|---|---|---|---|
| `mistral-code-agent-latest` | ✅ | yes | agentic coding |
| `devstral-medium-latest` | ✅ | yes | agentic coding |
| `devstral-latest` | ✅ | yes | |
| `devstral-2512` | ✅ | yes | |
| `mistral-code-latest` | ✅ | yes | |
| `mistral-code-fim-latest` | ✅ | yes | fill-in-middle |
| `codestral-latest` | ✅ | yes | current head of the `build` lane |
| `codestral-2508` | ✅ | yes | |
| `mistral-large-latest` | ✅ | yes | |
| `mistral-large-2512` | ✅ | yes | the model Hermes-Agent drives today |
| `mistral-medium-latest` | ✅ | yes | |
| `mistral-medium-2505` | ✅ | yes | |
| `mistral-medium-2508` | ✅ | yes | |
| `mistral-medium` | ✅ | yes | |

The API advertises 56 ids, 42 of them plausibly text/build models; the 14 above
are the top of the ranking and every one passed. Cost is unpriced by the API.

## NVIDIA / NIM — free endpoints, and both keys work

Base: `https://integrate.api.nvidia.com/v1`. The catalogue is 102 ids, but most
are **not served to this account** — see the dead list. These are the ones that
answer.

| Model | tools | 10k | Note |
|---|---|---|---|
| `deepseek-ai/deepseek-v4-flash-0731` | ✅ | yes | **the DeepSeek route.** 284B MoE (13B active), long-context, built for coding and agentic work. Cold-starts slowly — allow ~150s on a first call |
| `nvidia/nemotron-3-ultra-550b-a55b` | ✅ | yes | largest model available here |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | ✅ | yes | already rank 3 of the `reasoning` lane |
| `poolside/laguna-xs-2.1` | ✅ | yes | 33B MoE for long-horizon agentic coding |
| `thinkingmachines/inkling` | ✅ | yes | Mamba-hybrid MoE, tool use, switchable reasoning |
| `moonshotai/kimi-k3` | ✅ | yes | |
| `meta/llama-3.1-70b-instruct` | ✅ | yes | |
| `meta/muse-glimmer-30b` | 💬 | yes | advertises native tool-calling; **did not emit one** |
| `minimaxai/minimax-m3` | — | — | answered chat, then `429` on both further gates |

## opencode.ai — base is `https://opencode.ai/zen/v1`

**Not** `api.opencode.ai/v1`, which returns `200` with an **empty** model list —
worse than an error, because it looks like a working endpoint that serves
nothing. `opencode.ai/api/v1` returns an HTML page. 64 models advertised.

| Model | tools | 10k | Note |
|---|---|---|---|
| `nemotron-3.5-lightning-free` | ✅ | yes | free |
| `nemotron-3-ultra-free` | ✅ | yes | free |
| `mimo-v2.5-free` | ✅ | yes | free |
| `laguna-s-2.1-free` | ✅ | yes | free, agentic coding |
| `hy3-free` | ✅ | yes | free |
| `x-preview-f-free` | 💬 | — | answers |
| `big-pickle` | 💬 | — | answers despite no `-free` suffix |

Paid ids on this workspace (`kimi-k2.7-code`, `glm-5.2`, `gpt-5.1-codex-max`,
`gpt-5.3-codex`, `grok-build-0.1`, `deepseek-v4-pro`, …) return
`401 CreditsError: No payment method`.

## b.ai — base `https://api.b.ai/v1`

The catalogue lists 42 ids including `deepseek-v4-pro`, `glm-5.2`, `glm-5.3`,
`kimi-k3`, `qwen3.8-max`, `minimax-m3` and the Claude and GPT families — but the
key is **scoped to one model**. Everything else returns `403`.

| Model | tools | 10k |
|---|---|---|
| `deepseek-v4-flash` | ✅ | yes |

## Groq — usable for chat, cannot host a build engine

| Model | tools | 10k | cost | Note |
|---|---|---|---|---|
| `openai/gpt-oss-120b` | ✅ | **413** | $0.150/M | tool calls work; the request is too large for the free tier |
| `openai/gpt-oss-20b` | ✅ | **413** | $0.075/M | same |
| `qwen/qwen3.6-27b` | 💬 | 413 | $0.600/M | fails tool calling |
| `groq/compound` | 💬 | — | unpriced | tool calling unsupported |
| `groq/compound-mini` | 💬 | — | unpriced | tool calling unsupported |
| `allam-2-7b` | 💬 | — | unpriced | tool calling unsupported |

The 413 is `TPM: Limit 8000, Requested ~10800`. It is a **per-request** ceiling,
so pacing cannot evade it — the free tier is structurally too small for dsh.
Groq's Dev tier would fix it.

## Google — chat confirmed, tool calling not tested

`generateContent` takes a different request shape than the OpenAI tools array,
so tool calling is reported as **not tested** rather than guessed.

| Model | chat | tools |
|---|---|---|
| `gemini-3.6-flash` | yes | not tested |
| `gemini-3.5-flash` | yes | not tested |
| `gemma-4-31b-it` | yes | not tested |
| `gemma-4-26b-a4b-it` | yes | not tested |

## OpenRouter — one model reachable, and it is not viable for builds

The account's guardrail is a **strict allow-list**, holding `z-ai/glm-5.2:free`
plus two TTS models. Everything else — every coder model, `qwen3-coder` at
$0.070/M through `gpt-5.1-codex-max` at $1.250/M — returns
`404 No endpoints available matching your guardrail restrictions and data policy`.

| Model | tools | 10k | cost | Note |
|---|---|---|---|---|
| `z-ai/glm-5.2:free` | ✅ | yes | free | **but 2 of 10 requests succeed** |

The rate limit is the disqualifier, not the model. A sequential burst of 10
returned 8 × `429` with `retry-after: 5`, from `upstream_provider_shared_pool`
(provider `Decart`) — there are no `x-ratelimit-*` headers, so it is upstream
congestion rather than an account quota. An agentic build is many sequential
turns, so ~20% per turn compounds to approximately never. Observed directly: two
Forge runs wrote all their files and then died on a later-turn `429`, 75 s and
98 s in.

Paid `z-ai/glm-5.2` is $0.966/M prompt, $3.036/M completion, 1,048,576 context —
about 1¢ per dsh turn — but needs allow-listing plus credit.

---

## Vision — does the model accept an image?

The `vision` lane feeds `screen_look`, `camera_look`, the screen sensor and build
render verify, so image input is not optional there. Measured by sending a real
PNG part.

**This tests ACCEPTANCE, not accuracy.** A tiny synthetic PNG proves the wire
shape works and says nothing about reading a 320KB screenshot well —
`free-tier-model-map.md` already records that a small test image gives
misleading quality signal.

| Provider | Accepts images |
|---|---|
| Google | `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemma-4-31b-it` |
| Mistral | `mistral-small-latest`, `mistral-large-2512`, `mistral-medium-latest` |
| NVIDIA / NIM | `meta/llama-3.2-11b-vision-instruct`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`, `meta/muse-glimmer-30b`, `thinkingmachines/inkling`, `google/gemma-4-31b-it` |
| Groq | `qwen/qwen3.6-27b` |
| opencode | `mimo-v2.5-free` |

Text-only despite being capable text models: `b.ai/deepseek-v4-flash` (400) and
`opencode/nemotron-3-ultra-free` (400).

## Embeddings — and why this lane must not be swapped casually

| Model | Dimensions |
|---|---|
| `mistral/mistral-embed` | **1024** |
| `nvidia/nemotron-3-embed-1b` | **2048** |
| `google/gemini-embedding-001` | **3072** |

Dead: `nvidia/baai/bge-m3` (`500`), `google/text-embedding-004` (`404`).

All three have **different dimensions**, and changing dimensions invalidates
every vector already stored. That is why the embed lane has deliberately never
moved, and nothing measured here changes that.

## Lane health — measured against the real ids in `lanes.default.js`

Probed in priority order, so "starts at" is where a call actually gets its first
answer. `ollama` entries are local and skipped rather than failed — absent-but-
filtered is not the same as dead.

| Lane | Cloud alive | Starts at | Dead entries |
|---|---|---|---|
| `voice` | 3 of 5 | **#1** | `cerebras/gemma-4-31b` 402 · `groq/llama-3.3-70b-versatile` 404 |
| `build` | 4 of 7 | **#1** | `cerebras/gpt-oss-120b` 402 · `groq/llama-3.3-70b-versatile` 404 · `cerebras/zai-glm-4.7` 404 archived |
| `memory` | 2 of 3 | **#1** | `cerebras/gemma-4-31b` 402 |
| `vision` | 3 of 5 | **#1** | `google/gemini-flash-latest` no response (2 runs) · `nvidia/nemotron-nano-12b-v2-vl` `500 EngineCore` after 100s |
| `embed` | 1 of 1 cloud | **#2** | — (`#1` is local `ollama/nomic-embed-text`) |
| `simple` | 3 of 5 | **#2** ⚠ | `groq/llama-3.1-8b-instant` **404 — head of lane** |
| `text` | 2 of 4 | **#3** ⚠ | `cerebras/zai-glm-4.7` 404 · `cerebras/gpt-oss-120b` 402 — **both top entries** |
| `reasoning` | 2 of 4 | **#3** ⚠ | `cerebras/gpt-oss-120b` 402 · `cerebras/zai-glm-4.7` 404 — **both top entries** |

`reasoning` is the expensive one: eight roles ride it — `mull`, `think_deeply`,
self-reflection ×2, reviewer, reality-checker, design verify, orchestrator
synthesize, `ask_agent`, engagement interview — and every one of them burns two
failed attempts before reaching `nim/nvidia/nemotron-3.5-lightning-30b-a3b`,
which is measured healthy and already sits at rank 3.

`nvidia/nemotron-nano-12b-v2-vl` is worth watching rather than deleting: this
repo recorded it at 386ms in July, then 7.5-15s with hallucinated content on
2026-08-14, and now a `500` after 100s. It is degrading, not flapping.

## What can go on each lane

Candidates below are measured usable for the capability that lane needs — not a
recommendation about ordering, which is what `free-tier-model-map.md` argues.

| Lane | Usable models |
|---|---|
| `build` | Mistral `mistral-code-agent-latest`, `devstral-medium-latest`, `devstral-latest`, `mistral-code-latest`, `codestral-latest`, `codestral-2508` · NVIDIA `deepseek-ai/deepseek-v4-flash-0731`, `poolside/laguna-xs-2.1` · opencode `laguna-s-2.1-free`, `mimo-v2.5-free` · b.ai `deepseek-v4-flash` |
| `reasoning` | NVIDIA `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `thinkingmachines/inkling`, `moonshotai/kimi-k3` · opencode `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `hy3-free` · Mistral `mistral-medium-2604`, `mistral-large-latest` · Google `gemini-3.6-flash` |
| `memory` | Google `gemini-3-flash-preview` · Mistral `mistral-medium-2604` · NVIDIA `meta/llama-3.1-70b-instruct` |
| `voice` | Google `gemini-flash-lite-latest`, `gemini-3.5-flash`, `gemini-3.6-flash` · Mistral `mistral-medium-latest`, `ministral-3b-latest` · NVIDIA `meta/llama-3.1-8b-instruct` · opencode free models |
| `simple` | Mistral `ministral-3b-latest` · NVIDIA `meta/llama-3.1-8b-instruct` · Google `gemini-flash-lite-latest` · Groq `openai/gpt-oss-20b` (its 413 only bites at 10k; this lane sends tiny prompts) |
| `text` | Google `gemini-3.6-flash` · NVIDIA `nvidia/nemotron-3-ultra-550b-a55b` (1M context), `moonshotai/kimi-k3` |
| `vision` | see the vision table above |
| `embed` | see the embeddings table above — **dimension change is destructive** |
| Live voice (STT/TTS) | `gemini-3.1-flash-live-preview` over the Gemini Live WebSocket. Separate API; still no Pro-tier Live model at any price |

## Can host DeepSeek Harness as a build engine

Everything that passed all three gates, so any of these can drive agentic builds:

| Provider | Model | Cost |
|---|---|---|
| mistral | all 14 above, incl. `mistral-code-agent-latest`, `devstral-medium-latest` | unpriced |
| nvidia / nim | `deepseek-ai/deepseek-v4-flash-0731` | free endpoint |
| nvidia / nim | `nvidia/nemotron-3-ultra-550b-a55b` | free endpoint |
| nvidia / nim | `nvidia/nemotron-3.5-lightning-30b-a3b` | free endpoint |
| nvidia / nim | `poolside/laguna-xs-2.1` | free endpoint |
| nvidia / nim | `thinkingmachines/inkling` | free endpoint |
| nvidia / nim | `moonshotai/kimi-k3` | free endpoint |
| nvidia / nim | `meta/llama-3.1-70b-instruct` | free endpoint |
| opencode | `nemotron-3.5-lightning-free`, `nemotron-3-ultra-free`, `mimo-v2.5-free`, `laguna-s-2.1-free`, `hy3-free` | free |
| b.ai | `deepseek-v4-flash` | key-scoped |
| openrouter | `z-ai/glm-5.2:free` | free, but 2/10 success — not viable multi-turn |

## Dead, and why it matters

These are listed only because the repo currently believes otherwise.

| Route | Believed | Measured 2026-08-22 |
|---|---|---|
| `nim / deepseek-ai/deepseek-v4-flash` | `lanes.default.js:294` dead-route list, reason `404/timeout` | **the id is wrong.** The real one is `deepseek-ai/deepseek-v4-flash-0731`, and it passes every gate. It was also written off a second time on a 45s abort that was a **cold start** |
| `cerebras / gpt-oss-120b` | head of `reasoning`, rank 4 of `build`, rank 2 of `text` | **`402 Payment required`** — the account is unbilled. Cerebras advertises only two ids at all |
| `cerebras / zai-glm-4.7` | rank 2 of `reasoning`, rank 6 of `build`, head of `text` | **`404` — "archived and unavailable for the organization"** |
| `cerebras / gemma-4-31b` | rank 3 of `memory`, in `simple` and `vision` | **`402 Payment required`** |
| `groq / llama-3.3-70b-versatile` | rank 5 of `build`, discussed for `voice` | **`404`**, and Groq's `/models` advertises **no Llama 3.3 in any form** — not a renamed id |
| `z-ai/glm-5.2` on NVIDIA | listed on build.nvidia.com as a free endpoint | **`410 Gone`**, and absent from the API's 102-id catalogue |
| `meta/muse-glimmer-30b` | "native tool-calling" per its model card | answers, but **emits no tool call** |

**Consequence worth acting on.** The two dead Cerebras entries are the top two of
both `PREF_REASONING` and `PREF_TEXT`. So `mull`, `think_deeply`, reviewer,
reality-checker, design verify, orchestrator synthesize, `ask_agent` and
engagement interview each burn two failed attempts before reaching
`nim/nvidia/nemotron-3.5-lightning-30b-a3b`, which is measured healthy. The
`build` lane is **4 of 7** cloud entries alive — the three Mistral heads plus
`nim/meta/llama-3.1-8b-instruct`.
