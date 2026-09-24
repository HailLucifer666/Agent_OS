# GitHub reuse research for the 28 open MYTHOS bugs

Research date: 2026-09-24. Local code inspected at `2141da0cde785cc7eaff8dae7aa756b849b43d12`. Prices, free-tier boundaries, licences and the open/closed state of every upstream issue and pull request below are as read on that date; re-check any of them before relying on it.

## Operator constraint: retain the existing free-tier stack

The operator explicitly requires no paid tier for this work. This constraint supersedes any earlier suggestion that a hosted service, premium default, trial-to-paid upgrade, or model migration is an acceptable prerequisite. The report now maps each of the 28 current open IDs separately. A repository may supply a reusable mechanism without supplying a complete MYTHOS fix.

No model list, provider setting, billing setting, API key, runtime flag, or installed dependency was changed. Recommendations here are research and proposed implementation boundaries, not claims that a free-only execution guard has already been installed.

### What preserving the list means

- Keep the existing approved free provider/model choices and their load-spreading intent. Do not silently replace them with a repo's example OpenAI/Anthropic model, hosted browser, inference gateway, or dynamic model router.
- Distinguish three costs: running open-source code locally, consuming an existing free API quota, and paying for hosted inference/infrastructure. The first does not make the other two free. Finite trial credits are not a permanent free service.
- On quota exhaustion, use the next already-approved free route within the existing budget, wait within a bounded deadline, or report unavailable. Never enable billing, buy credits, remove a `:free` suffix, or substitute a paid sibling.
- Preserve explicit operator consent and per-action authorization even when the external code is free. Cheap autonomous retries can still duplicate a send or target the wrong window.
- Prefer deterministic local validation, observation, timers, queues, and circuit breakers. They add no model calls. Extra LLM judges, semantic browser agents, and automatic repair loops consume the same scarce free quota and are optional experiments, not baseline repairs.

### Local evidence that changes adoption order

`docs/free-tier-model-map.md` records the August 14/15 measurement and design. `docs/USABLE-MODELS.md` records August 22 tests. `src/core/brain/lanes.default.js` contains September 11 revisions, including retired models, Mistral tier refusals, and Cerebras payment-required results. Therefore preserve the intended free stack, but do not copy an older document's historical ranking or entitlement into a new config. No provider calls were made in this research, so current account quota is not newly verified.

The lane table also deliberately prepends `BYO_PREMIUM` OpenAI/Anthropic routes to six lanes. `registry.js` makes those providers eligible on key presence. They were designed for future BYO customers; absent keys are not durable enforcement of this operator's current no-paid requirement. **Recommended first implementation:** a free-only policy at the effective routing boundary, applied after `CHAIN_*` overrides and to external adapters as well as direct voice/STT/TTS paths. Unknown-price routes are ineligible until verified. Keep product BYO support available outside this operator's explicitly selected free-only mode. Model-name filtering alone cannot establish zero charges when a provider account has pay-as-you-go enabled; verify the relevant account policy before a live probe without changing it automatically.

Read-only hardware inspection found approximately 15.7 GiB RAM and Intel Iris Xe graphics; no NVIDIA adapter was listed. The graphics driver memory field is not treated as reliable dedicated VRAM. This makes the Hugging Face README's heavy Linux/NVIDIA preset a poor default for this machine. Retain existing working speech components first; a CPU-capable local alternative must earn adoption with actual latency and memory measurements. No GPU purchase or paid inference fallback is part of the recommendation.

### Current public free-tier boundaries

These sources establish advertised options, not this account's current entitlement. No exact quota is copied into runtime configuration.

| Existing or proposed service | Public boundary | Decision for this work |
|---|---|---|
| Gemini Live | Official pricing lists a free tier for the configured 3.1 Flash Live preview; quotas are model/project dependent. [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [limits](https://ai.google.dev/gemini-api/docs/rate-limits). | Preserve configured free Live path. No paid/new-model substitution. |
| Groq | Free Plan has organization/model limits. [Rate limits](https://console.groq.com/docs/rate-limits). | Keep existing approved models; respect quota and retry delay. |
| Mistral | Current Free-mode/subscription and usage rules distinguish included usage from pay-as-you-go. [Subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions), [usage limits](https://docs.mistral.ai/admin/billing-usage/usage-limits). | Do not infer access from the catalog; no PAYG activation. |
| NVIDIA hosted endpoints | Official docs describe hosted APIs for prototyping; trial terms apply. [Deployment options](https://docs.api.nvidia.com/nim/docs/run-anywhere), [trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf). | Preserve entitled development usage; do not promise perpetual free production hosting. |
| Cerebras | Local lane evidence records payment-required responses; no new account probe performed. | Keep unavailable entries out of effective free execution; do not fund account to make a fallback pass. |
| OpenRouter | Explicit free variants have limits; the free router can choose models dynamically. [Limits](https://openrouter.ai/docs/api_reference/limits), [router](https://openrouter.ai/openrouter/free). | Do not resurrect retired IDs or add the dynamic router to the user's fixed list. |
| Hugging Face hosted Inference Providers | Monthly credits are finite; additional usage has separate billing. [Pricing](https://huggingface.co/docs/inference-providers/pricing). | Do not treat the HF speech repo as free hosted inference. Use existing approved backend or qualified local components. |
| Playwright/MCP, state/queue libraries | Local browser primitives and state transitions do not require another LLM or hosted subscription. [Playwright package](https://github.com/microsoft/playwright-mcp/blob/main/package.json). | First-choice reuse. Existing MYTHOS planning still uses its current quota. |

### Best approach under this constraint

1. **Protect the free-only boundary and baseline first.** Snapshot effective routes without exposing keys, reconcile the existing PR integration point, and prevent premium/default fallback through new adapters. Use fakes to test routing before any account-dependent probe.
2. **Finish and verify cheap local repairs.** Prioritize action/consent guards (461/464), truthful browser results (462), description/claim fixes (459/448/460), output validation (458), and startup filtering (463). Verify the access, autonomy, TTS-breaker, and shutdown fixes already coded instead of replacing their stacks.
3. **Use Playwright as the browser foundation.** Evaluate the official existing-session extension only if it improves the failing transport case. Preserve target identity and independent outcome checks. Do not add Stagehand/Browser Use to the default path merely to repair a race, stale reference, or false-success contract.
4. **Adapt playback and scheduling mechanisms.** Borrow LiveKit's playback lifecycle and HF/Pipecat's result-lifecycle designs while retaining the present free model. A wire feature unavailable on that model remains unavailable; local scheduling must be tested on the actual supported path.
5. **Keep the HF voice-backend experiment bounded and optional.** It may justify revisiting deferred D7 for validated text before TTS, but this research does not silently reverse that decision. Use one speech pipeline and the existing approved LLM route, no premium example defaults, no paid hosting, no required hardware upgrade. Benchmark CPU/memory and end-to-end latency before migration.
6. **Promote only on existing live gates.** First reproduce with deterministic fixtures, then use the attended golden path. Measure provider attempts and tokens per successful task alongside correctness and latency. A candidate that needs more quota than the free account can sustain is not a viable replacement even if one demo succeeds. Preserve the current broader-stage pause and the original acceptance bars.

Expected priority is application fixes plus selective reuse, not a framework shopping list. No reviewed source establishes a turnkey solution to all 28 bugs, and several tickets already have local fixes awaiting proof.

## Finding

Existing open-source implementations can replace or improve several fragile mechanisms. The strongest fits are Microsoft Playwright's browser primitives and official existing-session extension, LiveKit Agents JS's playback lifecycle, and established approval/state-machine implementations. None of the sources establishes that installing a browser or voice agent will close all MYTHOS bugs. Recommendations below are research conclusions, not results of a local integration benchmark.

This is a research report, not another execution-plan source of truth. The existing roadmap and RESUME.md retain that role. No dependency was installed, user browser controlled, provider key exercised, or bug marked fixed during this research.

## What MYTHOS already has

Local source inspection matters because recommending already-integrated capabilities would fund the same work twice.

- `mythos/package.json` already declares `playwright-core` with range `^1.62.1`. `adapters/browser-agent/index.js` manages CDP attachment and persistent browser launch.
- `src/core/effectors/from-browser.js` already uses accessibility snapshot refs. Its comments explicitly discuss lessons from agent-browser. The defect is not simply absence of a browser library.
- `src/core/effectors/browser-driver-tools.js` distinguishes desktop-owned extension actions from legacy CDP actions. Replacing one path does not automatically repair the other.
- `skills/browser-use/SKILL.md`, `adapters/mcp-client`, and `effectors/from-mcp.js` already describe an optional Browser Use integration. This establishes scaffolding, not an installed or qualified runtime.
- The generic MCP effector deliberately marks successful external calls `unverified:true`. Installing another MCP server does not supply the missing outcome verifier. Its own comments also state that local effector guards do not govern an external server's internal operations.

The current browser evidence helper captures state after an action and treats any describable state as verified. That is an application-level correctness defect: a successful click or readable page is not proof that the requested video started. The proposed new backend must not inherit this result interpretation.

## Browser candidates, ranked for this codebase

### 1. Keep Playwright; qualify Microsoft's official extension/MCP transport

[Playwright](https://github.com/microsoft/playwright) and [Playwright MCP](https://github.com/microsoft/playwright-mcp) are the first candidates because MYTHOS already shares the Node runtime and browser foundation. The MCP server supplies structured accessibility observations and browser actions. Its code license is Apache-2.0. [Repository and license](https://github.com/microsoft/playwright-mcp)

The [official extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md) attaches to existing authenticated browser state, offers tab selection, and documents per-client tab groups and profile-specific authentication. This is directly relevant to signed-in-session and target-ownership problems. Chrome, Edge, and Chromium are listed; successful operation with the user's Brave build still requires a real test. Extension connection permission is not approval for every future action.

Use upstream [locators](https://playwright.dev/docs/locators) and [actionability checks](https://playwright.dev/docs/actionability), retaining explicit target identity. For an ordinal request, first identify the intended result in the observed list, then preserve its stable URL/video ID across scrolling and rerendering. Calling `nth(2)` again after the list changes can identify something else. Actionability checks establish that input can reach an element, not that a business outcome occurred.

[Retrying assertions](https://playwright.dev/docs/test-assertions) are a useful verification reference: poll the expected outcome rather than sleep for a guessed interval. MYTHOS can use its own bounded production verifier; adopting the test runner as a runtime dependency is not required. Keep separate results for dispatched, verified, failed, and unverified.

The [CDP API documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) warns that CDP connections have lower fidelity than Playwright protocol connections. This is a relevant constraint, not proof that CDP caused the attended failure. [Trace Viewer](https://playwright.dev/docs/trace-viewer) supplies before/action/after DOM evidence; the library's context tracing API is usable outside the test runner. Capture failure evidence locally with bounded retention and avoid recording secrets unnecessarily.

**Decision:** retain the existing engine, repair its outcome contract, and compare the official extension against the custom transport. Switch transport only if it passes MYTHOS's session-identity and permission requirements. No need to add another planner to obtain these benefits.

### 2. agent-browser: concrete target-pinning work, but an exact matching open defect

[Vercel agent-browser](https://github.com/vercel-labs/agent-browser) provides a local CLI/MCP surface with snapshot refs and named sessions. Its code license is Apache-2.0. It adds a separately managed process/native runtime; packaged startup and shutdown become part of qualification.

A particularly relevant implementation is [merged PR #1589](https://github.com/vercel-labs/agent-browser/pull/1589): persistent CDP target identity and strict `--pin-tab` behavior. If the pinned tab disappears, strict mode reports `tab_gone` instead of choosing another tab. This is a useful reference for MYTHOS's reconnect ownership.

However, [issue #1922](https://github.com/vercel-labs/agent-browser/issues/1922) reports stale refs after click-triggered navigation followed by a no-op reported as success. It was open when researched. [Proposed fix #1923](https://github.com/vercel-labs/agent-browser/pull/1923) was also open, with a review concern about background-tab invalidation. These are reporter/reviewer observations, not a reproduction performed here.

**Decision:** borrow or adapt the target-pinning contract with its tests. Do not describe the unresolved stale-ref patch as a shipped solution. A full-backend comparison should use a pinned version and include this exact reproduction before promotion.

### 3. Stagehand: useful semantic discovery, not a drop-in reliability upgrade

[Stagehand](https://github.com/browserbase/stagehand) has MIT-licensed code. [Local browser configuration](https://docs.stagehand.dev/v4/configuration/browser) supports local Chromium and CDP attachment, so cloud browser hosting is not mandatory. [Observe](https://docs.stagehand.dev/v4/basics/observe) can propose structured actions for inspection before execution.

The [v4 migration guide](https://docs.stagehand.dev/v4/migrations/playwright) explicitly says there is no Playwright page interoperability. Automatic waits, `getBy*` locators, web-first assertion retries, and Playwright-style strict matching are not preserved. Replacing the current engine means porting flows and rebuilding protections. The guide also warns against blindly retrying `act()` after an ambiguous failure because the action may already have happened.

**Decision:** consider a separate, bounded semantic-discovery experiment for unfamiliar pages. Validate any proposal through MYTHOS before acting. Do not replace the established YouTube path or assume a Playwright Page can be handed directly to v4. AI-selected action success still requires independent outcome evidence.

### 4. Browser Use: exploratory alternative, already partially represented locally

[Browser Use](https://github.com/browser-use/browser-use) has MIT-licensed code and a Python-centered agent runtime. [Browser settings](https://docs.browser-use.com/open-source/customize/browser/all-parameters) support existing CDP connections and local profiles. Its [session implementation](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/browser/session.py) contains bounded reconnect and stale-session cleanup.

The reconnect implementation can choose the first available page if the previous target is absent. That behavior is unsuitable for a MYTHOS action already authorized for one exact tab. Adopt cleanup/backoff ideas, not silent target substitution.

**Decision:** useful for an isolated comparison on unfamiliar multi-step tasks. The autonomous loop adds model cost and requires control over every side-effecting step. Generic MCP task completion must not bypass the existing leash or count as verified completion. Revalidate current upstream APIs before relying on the old local skill's command examples.

### Other browser projects considered

[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) is Apache-2.0 and useful for network, console, and performance diagnosis. Its README officially supports Chrome/Chrome for Testing, not all Chromium derivatives. Usage statistics are enabled by default and configurable. [Troubleshooting](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md) documents connection issues involving existing browsers, unloaded tabs, and Windows launch configuration. It is a diagnostic candidate, not the first Brave replacement.

[BrowserOS](https://github.com/browseros-ai/BrowserOS) and [Skyvern](https://github.com/skyvern-ai/skyvern) are larger product/runtime alternatives with AGPL-3.0 code-license declarations. They change deployment assumptions and warrant a separate distribution review before integration into the planned commercial product. That license label is not a statement that commercial use is forbidden. No evidence found that either eliminates MYTHOS's exact outcome-verification requirement.

## Voice: reusable lifecycle code exists

### LiveKit Agents JS is the closest runtime fit

[LiveKit Agents JS](https://github.com/livekit/agents-js) is Apache-2.0 code. Its pinned [AudioOutput implementation](https://github.com/livekit/agents-js/blob/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360/agents/src/voice/io.ts) tracks playback start, progress, finish, position, interruption, and synchronized transcript, with playout waiting and pause/resume interfaces. These are concrete mechanisms for BUG-455 and BUG-447.

**Proposed adaptation:** the actual Electron audio sink reports consumed progress under utterance/session IDs. Echo references remain available during playback and a bounded acoustic tail. Resume state uses the unheard portion of that same answer. MYTHOS still owns IPC, lost-event handling, watchdogs, and real-room acoustic proof.

[Thinking-audio documentation](https://docs.livekit.io/agents/multimodality/audio/background-audio/) and its [implementation](https://github.com/livekit/agents-js/blob/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360/agents/src/voice/background_audio.ts) demonstrate feedback driven by agent state. Adapt that lifecycle to the requested single quiet chime, independently of the protocol ack deadline. Do not copy continuous typing audio as the product decision.

Full framework adoption adds LiveKit room/server and transport integration. It is a larger architecture change than adapting the lifecycle contract. [Turn-handling documentation](https://docs.livekit.io/agents/logic/turns/) describes interruption recovery, but output-sink capabilities remain material. A framework cannot infer how much custom Electron playback the operator heard without feedback from that sink.

**License boundary:** LiveKit's [turn-detector MODEL_LICENSE](https://github.com/livekit/agents/blob/main/MODEL_LICENSE) is separate from the framework code license and restricts model use to LiveKit Agents. Do not transplant those weights as though Apache-2.0 covered them. This recommendation concerns code patterns, not model weights.

### Pipecat supplies scheduling and recording references

[Pipecat](https://github.com/pipecat-ai/pipecat) uses BSD-2-Clause code licensing. Its pinned [Gemini adapter](https://github.com/pipecat-ai/pipecat/blob/9d4c5087aaa1bd5193262136a59d677348bb950c/src/pipecat/services/google/gemini_live/llm.py) checks model capabilities; its [async-tool example](https://github.com/pipecat-ai/pipecat/blob/9d4c5087aaa1bd5193262136a59d677348bb950c/examples/realtime/realtime-gemini-live-async-tool.py) demonstrates delayed native responses. Its broader [function-calling API](https://docs.pipecat.ai/pipecat/learn/function-calling) separates timeout, cancellation, and result handling.

[Google's Live tools documentation](https://ai.google.dev/gemini-api/docs/live-api/tools) explicitly says Gemini 3.1 Flash Live does not support asynchronous function calling. Therefore a framework change alone cannot add `NON_BLOCKING`/`WHEN_IDLE` behavior to that model. A different supported model is a separate compatibility experiment, not an automatic upgrade.

The pinned [AudioBufferProcessor](https://github.com/pipecat-ai/pipecat/blob/9d4c5087aaa1bd5193262136a59d677348bb950c/src/pipecat/processors/audio/audio_buffer_processor.py) supplies synchronized user/bot tracks and gap handling. Adapt that evidence shape for BUG-406/455, pairing microphone recording with actual playback timing. Server PCM arrival alone does not establish speaker output.

**Decision:** use Pipecat as a reference implementation or isolated benchmark. Adding its Python pipeline as the production replacement introduces packaging, IPC, and cancellation work that must earn its cost.

### Acoustic testing and native crashes

The maintained [WebRTC recording sample](https://webrtc.github.io/samples/src/content/getusermedia/record/) and [source](https://github.com/webrtc/samples/blob/6e2c5a117aa860d66d874f7c0df0ef9a3e2cd74e/src/content/getusermedia/record/js/main.js) provide a small microphone-recording/AEC fixture. This helps measure the issue; enabling echo cancellation is not evidence that MYTHOS's playback path is canceled effectively.

[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) provides a child-process boundary and lifecycle events suitable for crash-prone native components. MYTHOS already has containment work for BUG-422. No verified upstream patch for the exact attended native TTS crash was found; do not replace an existing worker solely to rename the mechanism.

Upstream frameworks also have regressions: [LiveKit JS issue #2477](https://github.com/livekit/agents-js/issues/2477) reports replayed chunks during fallback. It is contrary evidence to a universal reliability claim, not proof every LiveKit deployment fails.

## Approval, memory, and empty answers

### Reuse exact-request approval designs

[Vercel AI SDK](https://github.com/vercel/ai) has Apache-2.0 code despite GitHub's API returning `NOASSERTION` for the repository license classification. The [actual license](https://github.com/vercel/ai/blob/main/LICENSE) resolves that ambiguity. Its [approval validation implementation](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/validate-tool-approvals.ts) and [tests](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/validate-tool-approvals.test.ts) validate approved tool inputs and approval policy; configured signatures protect integrity.

**Adaptation for BUG-461/464:** bind approval to exact action/content, target, trusted operator turn, session, expiry, and single-use identity. The model cannot set its own consent flag. A valid signature does not prove that speech was understood correctly. [Issue #16334](https://github.com/vercel/ai/issues/16334) and [associated fix #16592](https://github.com/vercel/ai/pull/16592) also make release selection and approval round-trip tests important.

[XState](https://github.com/statelyai/xstate), MIT, offers explicit guarded state transitions. [Guards](https://stately.ai/docs/guards) are relevant to pending, approved, cancelled, expired, and executing states. [Persistence](https://stately.ai/docs/persistence) does not promise exactly-once external side effects. A small local state machine may suffice; add the dependency only if it reduces complexity.

[LangGraph.js](https://github.com/langchain-ai/langgraphjs), MIT, provides durable [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts). Its documentation warns that resuming restarts the interrupted node's code. This is a useful approval/checkpoint reference but a poor justification for migrating the whole app to fix two guards. Side effects need isolation/idempotency.

No autonomous memory-inference library is recommended for BUG-464. The required property is explicit, content-bound consent. Automatic extraction and storage solve a different problem.

### Keep the current model chain for BUG-458

[LiteLLM Router](https://docs.litellm.ai/docs/proxy/reliability) supplies established retry/fallback machinery, but it adds a Python service boundary and does not establish validation of MYTHOS's final user-visible content. Its [license](https://github.com/BerriAI/litellm/blob/main/LICENSE) is MIT outside separately licensed enterprise content. [Open issue #40404](https://github.com/BerriAI/litellm/issues/40404) reports streaming failures that do not activate fallback; that report was not reproduced here.

**Decision:** fix the local post-normalization success check first. Distinguish blank text from a valid structured tool-only result, refusal, cancellation, and already-emitted partial output. A successful HTTP response is not sufficient. Provider migration is not required to implement that contract.

For BUG-448/460/451, no reviewed library establishes that a keystroke delivered a message, that a successful scroll justifies unrelated facts, or that a proposed cause is true. Those remain application-owned evidence/provenance contracts.

## Coverage of every open ticket

Register regenerated read-only with `buildRegister()`: 28 unique open IDs, listed once below. **Pattern** means reusable implementation with MYTHOS integration still required. **Local** means the existing application contract must be repaired or qualified; no complete upstream substitute was established. **Decision** means code adoption cannot close the ticket. All recommendations use local code plus only existing approved free API usage; none requires buying a service.

| Bug | Established problem | Relevant repository/source and fit | Recommended action and proof |
|---|---|---|---|
| 274 | Wake-word dependency/weight licensing gate | **Decision:** [openWakeWord upstream license distinction](https://github.com/dscripka/openWakeWord#license). | Code is Apache-2.0; bundled pretrained weights have separate noncommercial terms. Free API usage does not resolve distribution rights. Keep gate open; no paid replacement proposed. |
| 275 | Fabricated facts/sources spoken as true | **Pattern + decision:** [HF text-to-audio architecture](https://github.com/huggingface/speech-to-speech). | A pre-TTS validation point is possible, but grounding/evidence checks remain MYTHOS work. Revisit D7 explicitly before migration; no extra LLM judge by default. Prove unsupported claims are blocked, not merely logged after speech. |
| 406 | Excessive microphone hold | **Pattern:** [Pipecat audio recorder](https://github.com/pipecat-ai/pipecat/blob/9d4c5087aaa1bd5193262136a59d677348bb950c/src/pipecat/processors/audio/audio_buffer_processor.py), [WebRTC sample](https://webrtc.github.io/samples/src/content/getusermedia/record/). | Capture synchronized microphone/playback evidence on existing hardware. Verify genuine speech is not suppressed; a recorder is evidence infrastructure, not the acoustic fix itself. |
| 421 | Reveal budget cannot reach allowed ordinal | **Pattern:** [Playwright locators](https://playwright.dev/docs/locators). | Preserve stable item ID while bounded scrolling reveals the requested result. Prove items beyond sixth and honest limit handling; generic selectors cannot determine semantic ordering. |
| 422 | Native TTS/child death interrupts session | **Pattern:** [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process). | Qualify existing process isolation/recovery first. Prove worker death is observed and recovery bounded. Containment does not reproduce or cure the original native exception. |
| 432 | System notices/results interrupt each other | **Pattern:** [HF ordered tool-result client](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/src/speech_to_speech/api/openai_realtime/audio_client.py). | Adapt identity/order/cancellation rules to current free Live transport. Run existing flag A/B; no result cuts an active answer or disappears on rotation. |
| 436 | Event-loop stalls and dropped rotation results | **Pattern:** [Node async child processes](https://nodejs.org/api/child_process.html), [event-loop delay measurement](https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions). | Verify coded async conversions and attribute remaining stall. Delay histograms alone do not identify blocking function. Separate model waiting from local freezes; preserve pending result across rotation. |
| 437 | Quit leaves owned processes alive | **Pattern:** [Electron app lifecycle](https://www.electronjs.org/docs/latest/api/app), [Node IPC/child lifecycle](https://nodejs.org/api/child_process.html). | Qualify shared bounded shutdown and ownership-aware cleanup on all supported quit paths. Never kill operator-owned attached browser to make process count reach zero. |
| 439 | Native CUA click races window-state refresh | **Pattern:** [p-queue serialization](https://github.com/sindresorhus/p-queue). | This is a native window-state race, not a browser defect. Await refresh plus dependent action per resource across batches; bind window/generation. Validate existing repair before adding a queue dependency. |
| 444 | Raw bearer persisted as long-lived cookie | **Local/reference:** [opaque-session pattern](https://github.com/expressjs/session). | Verify the already-coded auth redesign and revocation. No auth-library swap needed by current evidence; do not adopt the reference library's development MemoryStore as production design. |
| 445 | Model cannot see refs beyond truncated snapshot | **Pattern:** [Playwright MCP observations](https://github.com/microsoft/playwright-mcp). | Keep coded structured paging and emitted-ref contract; compare upstream transport. Prove third/sixth target identity and playback, including offscreen results. |
| 446 | Old paused commitments execute at boot | **Pattern:** [XState guards](https://stately.ai/docs/guards). | Verify persisted state, explicit authority, and operator-presence policy before dispatch. Booting seeded paused/over-budget goals must produce zero side effects. Existing coded fix gets first qualification. |
| 447 | System speech crowds out user; stale resume | **Pattern:** [LiveKit audio lifecycle](https://github.com/livekit/agents-js/blob/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360/agents/src/voice/io.ts). | Bind remainder to answer/playback position; keep diagnostics out of speech and user request ahead of announcements. Prove newer answer invalidation; language-error residual still needs recorded evidence. |
| 448 | True action statements retracted | **Local:** MYTHOS claim/evidence mapping. | Match claim object to actual effect. Keypress cannot prove message delivery; launch evidence can support opening a window. Upstream browser success strings do not solve this. |
| 449 | Tool syntax spoken but not executed | **Pattern + decision:** [HF ordered text/tool output](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/src/speech_to_speech/api/openai_realtime/README.md). | Validate text before TTS and distinguish structured tool calls. Keep D7 deferral explicit. Existing free model must emit usable tool calls; never execute text recovered from speech as a workaround. |
| 450 | Dead TTS engines retried every sentence | **Pattern:** [Cockatiel circuit breakers](https://github.com/connor4312/cockatiel). | Qualify existing persistent per-engine breaker; reuse a library only if it simplifies defects. Prove open circuit skips dead engine and bounded half-open probe detects recovery without repeated sentence delay. |
| 451 | False inferred causes saved as facts | **Local:** evidence/provenance records; [AI SDK approval reference](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/validate-tool-approvals.ts). | Label hypothesis versus observed cause; bind records to evidence. Approval establishes permission, not truth. Historical vault cleanup remains operator decision. |
| 452 | Foreign website can invoke local API | **Local/reference:** [ws pre-upgrade authentication](https://github.com/websockets/ws#client-authentication), [CORS limits](https://github.com/expressjs/cors). | Verify origin/auth rejection before HTTP handler and WS upgrade. CORS response headers alone do not prevent side effects. Finish existing coded fix, no hosted auth dependency. |
| 455 | Echo reference expires while audio still plays | **Pattern:** [LiveKit playback progress](https://github.com/livekit/agents-js/blob/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360/agents/src/voice/io.ts). | Use actual sink progress plus utterance identity and bounded acoustic tail; retain stuck-player rescue. Verify long playback and intentional interruption with recordings. |
| 456 | Slow tools leave silence and cut replies | **Pattern:** [LiveKit feedback lifecycle](https://github.com/livekit/agents-js/blob/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360/agents/src/voice/background_audio.ts), HF tool client. | One local chime uses independent timer; answer delivery has separate lifecycle. Prove feedback latency and no duplicate chime/interruption. Chime adds no inference call. |
| 457 | Tool result injected as user speech | **Pattern:** [Pipecat Gemini adapter](https://github.com/pipecat-ai/pipecat/blob/9d4c5087aaa1bd5193262136a59d677348bb950c/src/pipecat/services/google/gemini_live/llm.py), HF structured outputs. | Use supported model-specific response path. Retaining current free Gemini means honoring its async limitations; changing framework cannot invent a wire feature. |
| 458 | Empty answer prevents fallback | **Pattern/local:** [Cockatiel result predicates](https://github.com/connor4312/cockatiel), existing MYTHOS chain. | Validate final content before success; try only approved free fallbacks. Test whitespace, all-empty, tool-only, refusal and partial stream distinctly. No LiteLLM service required. |
| 459 | Tool description falsely denies capability | **Local:** canonical catalog/export contract. | Remove contradictory Live override and test the actual emitted declaration. Zero new dependency or inference cost. |
| 460 | Clear short command triggers false unheard correction | **Local:** action-specific evidence. | Link acknowledgement to corresponding verified action rather than exempt entire reply. Replay true/false controls; no model upgrade needed. |
| 461 | Noise interpreted as action request | **Pattern:** [AI SDK approval validation](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/validate-tool-approvals.ts), XState. | Bind clarification to exact action/target/session/expiry. Block unresolved intent before dispatch. Voice duration/word count alone is not consent. Test silence/noise and legitimate short commands. |
| 462 | No-op click reported as completion | **Pattern:** [Playwright actionability](https://playwright.dev/docs/actionability), [outcome assertions](https://playwright.dev/docs/test-assertions). | Capture before dispatch; verify requested target-specific postcondition. No change or inaccessible oracle stays unverified. Upstream issue #1922 below is counterevidence to blindly replacing engine. |
| 463 | Startup notes steer every conversation | **Local/pattern:** boot-scoped state, optionally XState. | Filter startup-only facts into once-per-process boot input; reconnect does not rerun them. Keep vault bytes unchanged. |
| 464 | Memory persists without request | **Pattern:** AI SDK exact-request approvals and local consent state. | Bind trusted operator words or approved proposal to exact saved text. Test negation, stale/unrelated yes, replay and typed path; no extra memory-agent service. |

### Additional reusable local code

[Cockatiel](https://github.com/connor4312/cockatiel), MIT, implements result predicates, bounded retries, timeouts and persistent circuit-breaker policies. It is a closer runtime fit than adding a Python router for BUG-450/458. Its usefulness is the state/error contract, not a reason to replace already-correct local code. Keep empty-content validation separate from provider-outage classification, and never retry a side-effecting action merely because its confirmation timed out.

[p-queue](https://github.com/sindresorhus/p-queue) provides promise concurrency control. For BUG-439, the transferable property is ordered execution of state refresh and dependent native action. A global queue can unnecessarily delay unrelated resources, and a queue does not make a stale element index valid. Use existing synchronization if it already establishes the required invariant.

### Supporting upstream reports and their actual status

GitHub REST states below were checked during this follow-up. Upstream issue numbers are not MYTHOS bug numbers. A closed issue alone is not proof a suitable release contains a working fix; a merged PR still needs release mapping and MYTHOS qualification.

| Source | State observed | Relevance and use |
|---|---|---|
| [agent-browser PR #1589](https://github.com/vercel-labs/agent-browser/pull/1589) | Merged 2026-08-10 | Concrete target-pinning implementation; use missing-target refusal as a browser acceptance condition. |
| [agent-browser issue #1922](https://github.com/vercel-labs/agent-browser/issues/1922) | Open | Reports stale-ref clicks falsely succeeding; related to MYTHOS 462. Add reproduction to comparison harness. |
| [agent-browser PR #1923](https://github.com/vercel-labs/agent-browser/pull/1923) | Open, not merged | Candidate ref-invalidation repair, not an already-shipped fix. Include background-tab navigation regression case. |
| [HF speech issue #433](https://github.com/huggingface/speech-to-speech/issues/433) | Open | Barge-in latency proposal; relevant to 406/447/455. Does not establish acoustic cancellation solved. |
| [HF speech issue #461](https://github.com/huggingface/speech-to-speech/issues/461) | Closed | Provider-failure spoken fallback; inspect associated implementation before reuse for silent-failure behavior. Not evidence of empty-content chain fallback. |
| [HF speech issue #375](https://github.com/huggingface/speech-to-speech/issues/375) | Closed | Wrong-language STT report. Useful regression stimulus for 447's language residual; no evidence MYTHOS shares that root cause. |

Where no directly matching upstream report was established, the table says local/pattern rather than manufacturing a repository solution. These additions do not change any BUGS.md completion status.

## Adoption experiment: evidence needed to call a candidate a solution

These are evaluation criteria, not new work authorized or performed by this report.

1. Record the exact dependency version/commit, browser build, profile, route, model, and flags. Install only project-local dependencies with project-local caches. Compare the current backend and official Playwright extension first; do not change the LLM and browser engine simultaneously.
2. Reproduce the established failure on disposable fixtures, then test a signed-in attended browser run. Cover third/sixth result identity, duplicate links, rerender, delayed navigation, popup, nested scroll, background tab navigation, missing target, reconnect, browser restart, cancellation, and action-with-no-effect.
3. Every side-effecting leaf goes through the existing leash and shared dispatch. An external agent's opaque whole-task loop is not an acceptable shortcut. Never silently switch profile/tab or blindly repeat an uncertain mutation.
4. Record selected target/document generation, action, action-specific postcondition, trace, latency, model/tool cost, and recovery count. Score wrong target, false success, duplicate side effect, and permission bypass separately from ordinary failures. A no-op must not become a successful completion to improve the score.
5. Preserve the existing ten consecutive attended golden-path successes across two cold boots and the sustained-run condition in RESUME.md. Use the existing 48/50 first-attempt and 50/50 bounded-recovery mixed-workflow requirement when that broader stage is authorized; it is not evidence collected by this research. Require zero wrong-target writes, unauthorized actions, duplicate side effects, or false completion claims.
6. For voice references, compare long queued playback, deliberate interruption, false interruption, delayed tool, reconnect, lost playback notification, and native-worker failure. Record feedback and final-answer latency separately. A chime does not count as a correct answer.
7. Promote only the smallest change that improves measured outcomes. Remove superseded ownership/retry paths when replacing them. Keep a rollback switch between implementations, but never auto-fallback to a different browser target after an uncertain write. Requalify the packaged app before calling packaged behavior fixed.

## Maintenance and reproducibility evidence

### Follow-up: Hugging Face speech-to-speech

The operator supplied [huggingface/speech-to-speech](https://github.com/huggingface/speech-to-speech) after the initial report. This is a credible additional candidate for a controllable voice backend, and its omission from the original shortlist is corrected here. GitHub metadata at inspection: unarchived, Apache-2.0 code, HEAD `a6576590f2a63f0d7c090e306422d86e0e1756ce`, committed 2026-09-23. Code licensing does not establish the terms for every selectable model or voice.

The current project is a Python VAD/STT/LLM/TTS cascade with interchangeable local/hosted components, WebSocket/WebRTC interfaces, and tests. It is not a single native speech-to-speech model. The README's standard hardware examples focus on Apple Silicon and Linux/NVIDIA; their memory budgets are estimates, not MYTHOS measurements. [Current repository](https://github.com/huggingface/speech-to-speech)

**Directly relevant implementation:** the pinned [audio client](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/src/speech_to_speech/api/openai_realtime/audio_client.py) deduplicates calls within a response batch, launches async execution, orders results by call position, and submits `function_call_output`. Follow-up generation is controlled separately. This is a concrete alternative to injecting a late tool result as operator speech, relevant to BUG-432/456/457. MYTHOS must still authorize every tool and verify its external outcome; task cancellation cannot undo a completed external action.

The [engine contract](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/src/speech_to_speech/api/openai_realtime/README.md) documents generation-tagged cancellation and separate tool-result submission/generation. It also explicitly makes `conversation.item.truncate` an acknowledgement-free no-op. Therefore protocol compatibility does not establish heard-audio history or exact unheard-remainder support. The tested surface is a core Realtime subset, not complete equivalence.

**Architectural opportunity, not an implemented MYTHOS fix:** a text-producing LLM stage before synthesis gives MYTHOS a place to validate claims and filter tool syntax before speech. This is relevant to the deferred validated-text-lane decision behind BUG-275/449. Enforcing the validators, preserving latency, and connecting the existing tool/memory context would be new integration work. A streaming text pipeline does not automatically provide semantic validation.

**Echo remains unresolved for this use case.** The README recommends headphones or `--local_audio_block_mic_during_playback` for speaker feedback; the latter disables user interruption during playback. That is containment with a product trade-off, not proof of full-duplex echo cancellation. [README](https://github.com/huggingface/speech-to-speech)

**Windows evidence is partial.** The pinned [dependency manifest](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/pyproject.toml) has an explicit Windows TTS dependency branch. The pinned [CI workflow](https://github.com/huggingface/speech-to-speech/blob/a6576590f2a63f0d7c090e306422d86e0e1756ce/.github/workflows/ci.yml) resolves OmniVoice dependencies for a Windows target on Ubuntu; install-smoke jobs run on Linux and macOS. That is not a Windows microphone/GPU/Electron runtime test. Do not call Windows unsupported, but do not call it qualified either.

[Issue #433](https://github.com/huggingface/speech-to-speech/issues/433), proposing lower-latency barge-in through reversible ducking, remained open. Older search snippets for provider-failure [issue #461](https://github.com/huggingface/speech-to-speech/issues/461) and language-detection [issue #375](https://github.com/huggingface/speech-to-speech/issues/375) looked unresolved, but current GitHub API states were closed. Those upstream issue numbers are unrelated to MYTHOS's similarly numbered bugs. No current failure is inferred from the outdated snippets.

**Revised recommendation:** include this repository in the voice-backend shortlist, especially if the operator chooses a validated text pipeline or local inference. Keep LiveKit's playback lifecycle as the closer reference for BUG-455/447. First compare one compatible STT/LLM/TTS configuration on the actual Windows machine: start/stop, ten-second tool, cancellation, speaker echo, long playback, repeated sessions, peak memory, and feedback/answer latency. Connect tools through MYTHOS's existing dispatch and retain its authorization/evidence contract. This would require a Gemini-wire adapter replacement, a Python process, and model/dependency packaging; it is not an endpoint-only swap for MYTHOS. Nothing was installed or runtime-tested in this follow-up.

GitHub REST metadata was read during this research. All eight repositories below were unarchived. HEAD commit dates establish activity, not correctness or release availability. Pin a tested released package and map it to the relevant source before adoption; do not ship floating `latest` from these research links.

| Repository | Inspected HEAD | HEAD date | Code license |
|---|---|---|---|
| microsoft/playwright | `b7957c51db7074a1bb28b6cab57386c1b856300a` | 2026-09-24 | Apache-2.0 |
| microsoft/playwright-mcp | `f1257a5a67aff872f947fae274759f7d54853862` | 2026-09-18 | Apache-2.0 |
| vercel-labs/agent-browser | `d01253d9db28d75080e36da3c1c31ef89454731e` | 2026-09-22 | Apache-2.0 |
| browserbase/stagehand | `e23a7198638b64c66748d81c39286bd800ca03fb` | 2026-09-23 | MIT |
| browser-use/browser-use | `d8110c5ff87ccba887aaa726cdb780f2f84bef8d` | 2026-09-15 | MIT |
| livekit/agents-js | `38f65f8a4c790f0bc4b62b1aba407cf1f95a2360` | 2026-09-23 | Apache-2.0 |
| pipecat-ai/pipecat | `9d4c5087aaa1bd5193262136a59d677348bb950c` | 2026-09-23 | BSD-2-Clause |
| statelyai/xstate | `fbee62e7c1586315ed478c2fedf530d7e0ff5a3e` | 2026-09-15 | MIT |

Source metadata endpoint: `https://api.github.com/repos/{owner}/{repo}`; HEAD endpoint: `https://api.github.com/repos/{owner}/{repo}/commits/HEAD`. License labels were checked against repository declarations/files; separate assets, dependencies, hosted services, and model weights require their own review. This report does not make a legal conclusion about the final distributed product.

## Research limits

The research used public primary sources: upstream repositories, implementation files, documentation, issue reports, proposed/merged changes, and GitHub REST metadata. Browser, voice, and execution/consent searches ran independently and were compared with local source. The requested deep-research skill's Firecrawl/Exa tools were unavailable, so the available web search/open tools and read-only HTTP were used instead.

No upstream benchmark was treated as proof of MYTHOS success. No repository was installed or benchmarked locally. Issue reports are identified as reports, and open PRs are not counted as released fixes. Local acoustic behavior, actual Brave compatibility, package startup, and exact provider behavior remain unmeasured here.

The recommendation is selective reuse: keep Playwright and improve its integration, trial Microsoft's existing-session transport, adapt playback-aware lifecycle code, and use content-bound approval/state transitions. Whole-framework migrations have not earned adoption on the evidence available.
