# Audit + fix plan — the AI news digest build, 2026-08-22

> ## STATUS — read this before the rest
>
> **Code: complete. Live verification: NOT DONE, and it is the one thing left.**
>
> All four approved phases shipped on `fix/audit-2026-08-22-build-gate-collapse`
> (PR #21). Suite green. Every fix has a regression test that was watched failing
> first, and the guards were mutation-tested.
>
> **Two findings in this document were WITHDRAWN as my own measurement errors,
> and their sections say so in place:**
> - **BUG-318** was never a defect — `actionStatus()` already honoured the
>   evidence contract; the `FAIL` came from my own throwaway dump script.
> - **BUG-322 as written here is wrong** — `turnCounter` resets per Live session
>   and that day had two, so I joined one session's anomaly to another's
>   transcript. The detector has **zero** false positives. The real finding is
>   that transcription genuinely failed 23 times, which is worse and is still
>   open. The number BUG-322 now belongs to an unrelated barge-in fix.
>
> **Two findings were ADDED on 2026-08-23** after measuring items this document
> had only filed: **BUG-323** (the `hub.js` suggestion scorer — real, but far less
> severe than described here) and **BUG-324** (two anomalies that knew their cause
> and did not report it).
>
> **The premise "three anomaly kinds have no playbook" was wrong for all three.**
> See the revised final section — "no playbook" is not "unhandled".
>
> Where this document and reality disagreed, reality won and the text was
> corrected rather than deleted, so the same ground is not re-hunted. Sections
> still marked **READ** rather than **MEASURED** were reproduced during their own
> fix; nothing shipped on a READ premise alone.

## Context

The operator asked MYTHOS by voice (23:40 IST 2026-08-21, again 12:35 IST
2026-08-22) to search the web for AI news from the last week and build an AI news
digest landing page. Three builds were started. Two died. The third shipped, and
it (a) looked, in the operator's words, like an 1800s website, and (b) carried
geopolitical news — UN, India, China, APAC — instead of the AI news that was
asked for.

This document is the log audit that was requested plus the repair plan that falls
out of it. Twelve defects were reported here; **ten survived measurement**, and two
more were found later (BUG-323, BUG-324) — but there are only **three defect
classes**, and one of them is on its fifth recurrence in this repo. The plan fixes
the classes, not the instances, which is why a twelve-item list closes with far
fewer than twelve patches.

### Operator decisions taken

| Decision | Answer |
|---|---|
| Fix scope | **All four phases** — 12 defects |
| Canonical vault | **`%APPDATA%\MYTHOS\vault`** (the packaged vault; repo vault stops being written) |
| BUG-317 `open_artifact` | **Signed URL** — mint a short-lived signed token so the browser can load it |
| BUG-314 invented copy | **Enforce, and fetch the article** for real text — see the security constraint on step 6, this one reopens a surface the repo deliberately closed and must go through the BUG-303-hardened fetch path |

### Evidence used

| Source | What it gave |
|---|---|
| `%APPDATA%\MYTHOS\vault\Audit\2026-08-22.jsonl` | 259 audit lines — the whole session with tool args |
| `…\Episodic\2026-08-22.jsonl` | 1.0 MB — full turn transcript, both directions |
| `…\Checkpoints\build-jobs.json` | the four job records incl. refine passes and verdicts |
| `…\Pipeline\{execute,shipped}\*.json` | the three cards, with `risk` and `evidence` |
| `…\builds\pipeline\ai-news-landing-page.html` | the shipped artifact, 5 436 bytes |
| `mythos/vault\Audit\2026-08-22.jsonl` | the *other* half of today's trail — 8 lines, all Aether |
| hand-run probes | risk classifier, skill pack, ui-ux-pro-max search.py, Google News RSS rung |

**Reproduction status** is marked on every finding: **MEASURED** means I re-ran it
and recorded the output; **READ** means it is established from code plus the log
record but I have not yet forced it to fail on demand. Every READ item gets its
reproduction as the first step of its fix, per the prime rule.

---

# Part 1 — The audit

## The root cause

### BUG-309 (P0) — the risk classifier read "typography" as "typo" — MEASURED

`src/core/effectors/risk-classifier.js:10` lists `'typo'` as a `tiny-fix`
keyword, and `classify()` (`:46-58`) matches with `String.indexOf`, no token
boundary. The spec MYTHOS wrote for itself contained *"base 16px **typo**graphy
using Geist font pairing"*.

```
classify(shipped spec)                      => tiny-fix
same spec, "typography" -> "type scale"     => feature
gatePath('tiny-fix')                        => ["artifact"]
requiresResearch / requiresReview / requiresVisual  => false / false / false
```

`Pipeline/shipped/pipe-1787402245811-455.json` carries `"risk": "tiny-fix"`. Two
earlier, near-identical cards for the same request carry `"risk": "feature"` —
they simply did not happen to contain the word typography.

**Why it is not hypothetical, and what it cost:** one substring collapsed the
whole gate. No web research, no reviewer, no visual gate — and, through BUG-310,
the design system was resolved and thrown away. Every symptom the operator
reported traces through this line.

**Class:** #3 friendly test data / #8 fighting the tool. The existing tests use
inputs where the keyword is the whole word. No test in the suite contains a
keyword embedded in a longer real word, so this was structurally uncatchable.

## Class A — substring matching where token matching was needed

Same defect shape, sixteen call sites. The two that have already caused real
damage:

### BUG-312 (P1) — the `dark.theme` verify rule is a substring sniff — MEASURED

`src/core/design/verify.js:72-75` matches `/dark/i`. The shipped page passes the
rule **only** because the string `--color-accent-dark` contains "dark". The
visually corrected regeneration did not contain the literal word and was
therefore discarded (see BUG-311). The requirement side (`:155`,
`specLower.includes('dark')`) has the mirror problem: it is negation-blind, so a
spec saying *"light theme, not dark"* demands a dark theme.

The same rule has already destroyed a whole build. `Pipeline/execute/pipe-1786743659157-401.json`:

```
buildError: "build failed verification after retry:
             missing required design element: dark.theme
             (spec mentions it but not found in deliverable)"
```

### Sixteen sites, enumerated — MEASURED

`grep -rn "specLower.includes\|lower.indexOf" src --include=*.js` returns 16.
Triaged:

- **Harmful now:** `risk-classifier.js:46,50,54,58` (4 lines, BUG-309);
  `design/verify.js:155` `'dark'` (BUG-312).
- **Same class, latent:** `design/verify.js:137,140,143,146,149,152,158` —
  `'hero'`, `'cta'`, `'neon'` (matches "neonatal", and matches "no neon"),
  `'mobile'` (matches "automobile"). All negation-blind.
- **Filed here, FIXED LATER as BUG-323 — and this framing was wrong:**
  `effectors/hub.js:144` scores tool-name matches with substring in *both*
  directions (`lower.indexOf(wanted) !== -1 || wanted.indexOf(lower) !== -1`).
  This entry called it "a tool-selection scorer" with "a documented history of
  tool-selection races". **It selects nothing.** `nearestToolNames()` runs only
  on the unknown-tool failure path, after `invoke()` has already decided to
  fail, and its output is the "did you mean" text. So the impact is a misleading
  suggestion, never a misrouted call.
  Measured on 2026-08-23 against the real registry, 12 probes: 10 good
  suggestions, 1 false positive (`essay_write` → `say`), 1 empty. Fixed by
  requiring the containment to begin at index 0 or after an underscore, which
  keeps all 10 and kills the 1. Not fixed with `keyword-match.js`: that module
  does English morphology for prose specs, and these are identifiers.
- **Not defects:** `from-spotify.js:415` (delimiter search),
  `lessons.js:235` / `build-pack.js:125` (soft scoring), `verify.js:125`
  (array `indexOf`, exact word match — correct).

**The class-level fix is one token matcher plus one sweep test**, not five patches.

## Class B — a value mutated after its consumer already captured it

### BUG-310 (P0) — the resolved design system never reaches any generation — MEASURED

`agent-actions.js:551-560` resolves the real design system (ui-ux-pro-max's
`scripts/search.py`) and prepends it to `basePrompt` — but *inside* `run()`.
`run()` is called from `build-runner.js:411`, which is **after**:

1. the first generation (`build-runner.js:188`),
2. source verification and its retry (`:231-256`),
3. the entire refine loop, including every regeneration (`:347`).

All of those use the string captured at `enqueue()` (`agent-actions.js:518`).
JavaScript strings are values; reassigning `basePrompt` inside `run()` cannot
reach anything already generated. The only generations that *can* see the design
system are the research-grounded rebuild (`:581`) and the review retry (`:599`).
With `risk = tiny-fix` both were skipped, so a 30-second Python subprocess ran and
its entire output was discarded.

The code comment at `:506-511` asserts the opposite — *"the grounded rebuild in
run() prepends the real design system before the model sees the prompt"* — which
is true only on the research path.

**Proof it was real output being discarded.** Running the same call by hand
returns a full design system: pattern, style, a ten-role palette, Inter for
heading and body, key effects, a pre-delivery checklist, and a live
`@import url('https://fonts.googleapis.com/css2?family=Inter…')`.

The shipped page contains none of it — no `@import`, no `<link>`, no Inter — and
instead declares `font-family: 'Geist'`, a font it never loads. **That is the
"1800s website" look, mechanically: an unloaded font falling back to the OS
default, plus two solid accent-colour bars for header and footer.**

Second consequence of the same shape: the refine regenerations at
`build-runner.js:347` rebuild from the original `prompt`, so on the research path
they silently discard the research brief too. And the grounded rebuild at `:581`
replaces `raw` *after* verification and refinement have finished, so whatever it
produces is never source-verified and never rendered. `job-1787358977679-888`
(the snake game, `researchStatus: "grounded"`) shipped exactly that way, with
`verifyWarnings` reading *"Deliverable is a truncated skeleton."*

**Two premises of the audit that measurement corrected.** The skill essences do
load — `packBlockFor('ui')` returns 7 114 characters and all four essences
(`taste-frontend`, `hallmark`, `ui-ux-pro-max`, `diagram-design`) resolve. And
`skillToolAvailable('ui-ux-pro-max', 'scripts/search.py')` is `true`. So this is
not the old "skills never reached builds" problem. The discipline text arrived;
the design system did not.

## Class C — reported success it had not earned (5th recurrence)

Commit `7d7b55a`, from earlier the same day, is titled *"four places that
reported success they had not earned (BUG-304/305/306)"*. These are the next
five. The reason they keep coming back is in `completion-status.js:42-48`:

```js
var needsWork = reviewStatus === 'failed' || isFallbackEngine;
return { status: needsWork ? 'needs-work' : 'done', evidence: { pass: !needsWork } };
```

That is a **denylist**. Anything the function has not been taught to distrust
reads as `done`. Every new status value in the system therefore defaults to
"proven good". This is kee class #4 — the guard written to stop a defect class
contains an instance of it — and class #5, existence standing in for agreement.

**MEASURED — the denylist, run against the real function:**

```
DONE        evidence.pass=true   | review actually approved
DONE        evidence.pass=true   | review SKIPPED (tiny-fix path, hardcoded approve)
needs-work  evidence.pass=false  | review failed
DONE        evidence.pass=true   | a future value nobody taught it ('skipped')
DONE        evidence.pass=true   | undefined reviewStatus
DONE        evidence.pass=true   | typo in the status string ('aproved')
DONE        evidence.pass=true   | no args at all  <-- deriveCompletionPayload({})
```

`deriveCompletionPayload({})` — **no arguments at all** — returns
`status: 'done', evidence.pass: true`. And `refineStatus: 'reverted'` passed in
alongside changes nothing, because the parameter does not exist. The module whose
header states *"a failed review must never be announced as a success"* announces
success for the empty object. That is the class, proven, not argued.

### BUG-311 (P0) — a visually-rejected artifact shipped as `status: done` — MEASURED

The refine loop worked. `job-1787402245908-705`, pass 1, `mistral-small-latest`,
`pass: false`:

> Missing all secondary story cards · Missing "Read more" links and story
> summaries · Marquee breaking news banner text is truncated and not scrolling ·
> **No electric blue accents visible in the design**

It regenerated. The regeneration was then vetoed by the *source* verifier
(`refineIssues: ["missing required design element: dark.theme"]` — BUG-312), so
`build-runner.js:360-369` took the `reverted` branch and shipped the original,
the one the visual gate had just rejected. The known-broken guard at `:399-404`
only fires on runtime errors, and there were none (`renderOk: true`, no console
or page errors). `refineStatus` is not passed to `deriveCompletionPayload` at
all. Final state: `status: "done"`.

### BUG-316 (P0) — a skipped review is recorded as an approved review — MEASURED

`agent-actions.js:593`:

```js
var review = needsReview ? await fullReview(card, artifact, brain)
                         : { verdict: 'approve', issues: [], visualDescription: '' };
```

then `:622` writes `reviewStatus = 'approved'`. No reviewer ran. The shipped card
reads `reviewStatus: "approved"`, `status: "done"`,
`evidence: { pass: true, phases: ["artifact"] }`. MYTHOS then said, at 13:04:17:
*"Completed and verified, Sir."* There is no `skipped` value anywhere on that
path, and because `completion-status.js` is a denylist, adding one without
inverting the logic would still read as `done`.

### BUG-317 (P0) — `open_artifact` returns `opened: true` for a URL the browser cannot load — READ

`from-dashboard.js:690-700` preflights the artifact URL with
`Authorization: Bearer ${config.MYTHOS_AUTH_TOKEN}`. The OS browser then requests
that same URL with no header, and `/vault/*` sits behind `requireToken`
(`server/index.js:856`) → 401. The operator's words at 13:04:43: *"It says error
unauthorized set mythos auth token via authorized bearer token."*

This is kee class #1, TOCTOU, in its purest form: **the process that checks is
not the process that uses.** The comment directly above the preflight says it
exists because *"configuring a token silently made every artifact unopenable"* —
so the previous fix made the **check** pass rather than making the **open** work.
Downstream, MYTHOS misattributed the 401 to Gmail reauth, claimed success again at
13:04:58 (which tripped `claimed-action-not-taken`), then retracted at 13:05:10.

### BUG-319 (P2) — a ten-day-old artifact was presented as the new build — READ

At 23:40:12 — in the *same turn* that started the research, before any build
existed — MYTHOS called

```
open_artifact({ path: '/vault/builds/pipeline/ai-news-digest-openai-ai-went-rogue-2.html',
                title: 'AI News Digest' })
```

on a file last written **2026-08-11**. It returned `opened: true`, because the
existence check passes on a real old file. That is the page the operator called
"totally failed" at 23:41:32.

### BUG-318 — **WITHDRAWN. NOT A DEFECT. My measurement error.**

**Claimed:** that `ok: true, unverified: true` was being rendered as `FAIL`,
flattening `unverified` into `ok` against the evidence contract in
`src/core/CLAUDE.md`.

**What was actually true:** the raw record reads `status: "unverified"` with an
honest summary, and `actionStatus()` already handles that state correctly. The
`FAIL` I saw came from **my own throwaway dump script**, which collapsed the
record with `a.ok ? "ok" : "FAIL"`. The production code was never wrong.

Nothing was changed for this, and nothing should be. Recorded rather than
deleted so the next session does not re-open it — and as a standing reminder that
a reading tool written in five minutes is not an oracle. The evidence contract
holds; verify against the raw record, not a summariser.

*(A hypothesis I had and measurement killed: I initially read the operator's
"you opened documents folder" as a path-resolution bug in `resolveSandboxed`.
`vaultRelativePath` handles both `/vault/…` and `vault/…` — verified — and the
records show the correct absolute path both times. The resolution was right; the
reporting was wrong.)*

## Class D — judging on evidence you do not have

### BUG-314 (P0, factual integrity) — every story body on the page is invented — MEASURED

`newsRssSearch` (`web-search.js:145-178`) returns
`snippet: "Published Nh ago."` and nothing else. There is no summary text in the
result at all. Yet the shipped page carries a paragraph under every headline:

> "India has overtaken other APAC countries in AI adoption, with significant
> investments in AI infrastructure and talent development."

That sentence exists in no search result. All four "Read more" links are
`href="#"`, so none of it is checkable. And the hero image is
`<img src="https://picsum.photos/seed/ai-summit/800/400" alt="UN Secretary-General
at the Global South AI Summit">` — a random stock image captioned as a real
person at a real event.

Stated for balance, because it is the opposite mistake and worth not chasing: the
Qwen3.8-27B / 262 K context / "nears Claude Opus" claims MYTHOS spoke at 13:09:53
**were** sourced — they came from a real `explainx.ai` search result. That part
was not fabrication.

### BUG-313 (P1) — the LLM verifier reads the first 2 000 characters, which on an inline-`<style>` page is 100 % CSS — MEASURED

`design/verify.js` — *"LLM self-check on first 2000 chars"*. In the shipped file:

```
total chars: 5436 | <body> at: 3329 | first 2000 chars contain <body>? false
```

The judge never saw a single word of content, and said so in its own warning:
*"Hero section content not visible in snippet—cannot confirm 'UN
Secretary-General lab' topic match."* The build shipped anyway, and that warning
is the *only* thing standing between the operator and a page whose topic was
never checked.

### BUG-315 (P1) — any query containing "news" is answered by a general news aggregator, and nothing else is consulted — MEASURED

`web-search.js:81` puts the bare word `news` in `FRESHNESS_MARKERS`. Rung 0a
(`:735`) is Google News RSS, first in the chain, and the file's own comment states
the property that matters: *the endpoint never returns zero.* So for any query
containing "news" it always wins and the chain never continues.

Re-run today, byte for byte, the query MYTHOS used at 12:35:31
(`"global AI news past week"` → `when:1d`):

```
China urges Indonesia to back global AI initiative amid US rivalry — 5h ago
UN Secretary-General Antonio Guterres says India is right place to host …  — 16h
No one saw this coming! - CNBC TV18 — 5h ago
India sets the pace in APAC for AI adoption and investment …  — 11h ago
```

Those are, in order, the four stories on the shipped landing page. **This is not
a model error. It is what the search rung returned.**

The contrast is in the same session: at 13:09:51 the query
`"global AI model releases August 15-22 2026 Qwen DeepSeek Claude"` came back
empty from RSS, fell through to DuckDuckGo, and returned the real thing —
Qwen3.8-27B on Aug 15, Gemini 3.7 Flash, Claude Opus 5 updates. Specific queries
work. The word "news" breaks it.

Second half of the same defect: `NEWS_WINDOWS = ['when:1d', 'when:7d']` (`:141`)
stops at the first window that answers, and `when:1d` always answers — so *"what
happened in the last one week"* is structurally served with the last 24 hours.
A third query, `"top AI news stories past week"`, returned *"This Week's Top Five
Stories in Cyber"*, *"…in the Data Centre Industry"* and *"The OncFive: Top
Oncology Articles"* — Google matched the phrase template, not the topic.

### BUG-322 — **WITHDRAWN AS WRITTEN. The detector is correct. My measurement error.**

**Claimed:** that the `live-turn-no-user-transcript` detector fired on turns whose
transcript existed — "5 of 13 false positives (38%)" — and that the remedy was to
re-check after the turn's field set closed.

**The correlation was wrong.** `turnCounter` **resets per Live session**, and
2026-08-22 had **two** sessions. I paired session A's anomaly `turnId` with session
B's transcript of the same number. Every row in the table below that read "YES —
user text on record" was a different turn entirely.

**Re-measured with time proximity instead of bare turnId:** all 23 anomalies have
empty user text. **The detector is right every single time.** There are no false
positives, and `turnSystemInitiated` is sufficient.

**What the corrected measurement actually found, and it is worse:** transcription
genuinely failed 23 times that day, several with substantial audio (`audioIn` up
to 282 frames). That is the vendor-side drop the code already describes as having
no available code fix. It also **contradicts the memory note** claiming `audioIn`
116–584 transcribes reliably — that note is now known to be too optimistic.

**Nothing in this file's fix plan for BUG-322 was implemented, and none of it
should be.** Suppressing on `audioIn: 0` would have been harmless; re-checking
after the field set would have suppressed 23 true reports of real data loss.

> ⚠️ **STILL OPEN, and this is the finding that matters:** 23 turns of operator
> speech reached Gemini and came back untranscribed in a single day. Needs its own
> investigation with the release log's `framesDropped`/`heldMs` as evidence. Not
> a detector bug — a data-loss bug the detector correctly reported.

**Note on the number BUG-322.** A concurrent session claimed BUG-322 for an
unrelated barge-in fix, which landed first (`ee11585`). That commit owns the
number. This entry is the withdrawn finding that briefly shared it.

**Method lesson, worth more than the finding:** a per-session counter is not a
global key. Two of my own measurements in this audit were wrong on the first pass
(this and BUG-318), both because I trusted a join without checking that the key
meant the same thing on both sides.

## Also in the logs — cheap fixes

### BUG-320 (P2) — `note_read` is called with wiki-link brackets, three times — MEASURED

`note_read({title: "[[ai-news-digest-v2]]"})` and `[[AI News Landing Page Plan]]`.
The error names the existing notes but the brackets are never stripped, so the
healer recorded the same lesson twice and it will recur next session.

### BUG-321 (P2) — the dsh failure hint contradicts the dsh probe — MEASURED

The build failure message ends with *"Install it with `node
mythos/scripts/setup-dsh.js --install`"* while the very same audit line reports
`online: true, evidence: version-printed-and-matched-pin`. A load-time crash is
being told to reinstall a correctly installed engine.

---

## Already fixed — do not re-fix

Both builds that died (05:12 and 05:22 IST) burned the full 600 000 ms each and
failed with:

```
App threw an error during load
Error: failed to apply loader entry … (@deepseek-ai/cordis-plugin-hmr):
--expose-internals is required for HMR service
```

That was **BUG-301**, fixed the same morning at 05:58 IST by `5bc90fb` (spawn
`process.execPath` with `--expose-internals`), and proven fixed by the 18:07 build
succeeding. Nothing to do beyond BUG-321's stale hint.

---

## Session health — logged, mostly not code in this plan

| Count | Anomaly | State |
|---|---|---|
| 23 | `live-turn-no-user-transcript` | **CORRECTED: zero false positives.** All 23 are real — see the BUG-322 withdrawal. Transcription genuinely failed 23 times, several with substantial audio. Vendor-side, unresolved, needs its own investigation |
| 5 | `cortex-stall` — no tick for 22 s | `restart-cortex` applied 5×, during the build |
| 7 | `confirm-expired-silently` on `pipeline_advance` | playbook **no-match** (unhandled) |
| 3 | `gmail-reauth-required` | playbook **no-match**; `invalid_grant`, refresh token expired or revoked, tool suppressed |
| 1 | `live-turn-stalled` (turn 6) | playbook **no-match** |
| 3 | `open_web` weather | `fetch failed` — network egress |
| 2 | `search-provider-failed` `exa-mcp` | HTTP 429, suppressed 20 min each |

Three anomaly kinds have no playbook at all. Gmail needs `node
scripts/google-auth.js` and a fresh `GOOGLE_REFRESH_TOKEN` in `mythos/.env`.

**Incident ledger — CORRECTED 2026-08-23. "160 incidents, 0 resolved" was wrong
twice.** Measured with `scripts/triage-incidents.js --check` against the
canonical vault:

```
Recorded: 58   cited in BUGS.md: 31   untracked: 27
```

The 160 I reported was a count of raw `Incidents/*.jsonl` LINES (161 in the
canonical vault, plus 100 more in the repo vault). That file is an append-only
event stream with several lines per incident, not a backlog. The actionable
ledger is `Semantic/incidents.md`, and **more than half of it is already tracked**.

**The real backlog is 27 untracked incidents, not 160 unresolved ones.** Clear one
by citing its id in a BUGS.md entry, or by recording why it needs none.

Two things the list makes plain that are worth acting on separately: Gmail's
`invalid_grant` is logged **twice**, on 2026-08-20 and again on 2026-08-23, so it
has been dead for four days; and a cluster of six 2026-08-18 entries are all the
same WhatsApp/UIA "cannot identify the message box" fault.

**Today's audit trail is split across two vaults.** The packaged vault holds the
entire session (259 audit lines, zero Aether lines). The repo vault holds 8 audit
and 16 episodic lines, **100 % Aether proxy failures** — `listen EADDRINUSE
127.0.0.1:4480` for node "phone", retried 8× over 77 minutes, playbook
`aether-proxy-rebind` returning `bind-failed-again` every time. Neither vault can
see the other half, so `list_incidents` and the Audit view are both showing a
partial picture.

**One thing the logs could not settle — SETTLED 2026-08-23, and MYTHOS was
right.** At 23:38:52 MYTHOS named the top-priority incident as *"visual click
failure on the Linear tab"*; the operator replied *"that's not what I remember, I
don't remember anything discussing about linear with you."* This section
previously guessed it "may be a real old incident wrongly attributed".

The ledger answers it outright:

```
inc-1787302412282-3 | error | 2026-08-21 | source: voice | status: open
  "Operator reports visual click failure on Linear tab, despite tool returning success."
inc-1787355572005-1 | warn  | 2026-08-22
  "Operator denies discussing Linear tab click failure, disputing earlier incident log context."
```

So the incident is **real**, was recorded from the operator's own voice turn the
**previous day**, and was still `open` when MYTHOS cited it. **This was not an
invention and not a misattribution** — it was an accurate report of a genuinely
open item, one day stale.

What remains is a much smaller and different defect: MYTHOS cited it with **no
date**, so a correct answer about yesterday was indistinguishable from a claim
about this conversation. An incident summary that omits *when* invites exactly
this dispute. Worth fixing; not the hallucination it looked like.

---

## Triage

| Verdict | Items |
|---|---|
| **CLOSED** | BUG-301 (dsh `--expose-internals`, fixed `5bc90fb`, proven by the 18:07 build) |
| **QUICK WIN** | BUG-309, BUG-312, BUG-316, BUG-320, BUG-321 (BUG-318 and BUG-322 withdrawn — see their sections) |
| **BACKLOG (this plan, phases 1–4)** | BUG-310, BUG-311, BUG-313, BUG-314, BUG-315, BUG-317, BUG-319 |
| **FILED, NOT FIXED HERE** | `hub.js:144` bidirectional-substring tool scorer; `live-turn-no-user-transcript` recurrence; the three missing playbooks; the 160-item ledger |
| **ACCEPT** | nothing — BUG-314 and BUG-317 are integrity and auth-surface defects and are not deferrable regardless of severity label |

---

# Part 2 — The fix plan

Every item is red-first: write the test, watch it fail against HEAD, then fix.

## Phase 1 — the root cause and the class it belongs to

**1. BUG-309 + BUG-312 + the latent sites — one token matcher, one sweep test.**

New `src/core/effectors/keyword-match.js` (small, dependency-free, same shape as
`completion-status.js`): `matchesKeyword(text, keyword)` matching on word
boundaries, tolerant of the multi-word keys already in the tables
(`'fix spelling'`, `'call to action'`), and negation-aware for the requirement
side (`not dark`, `no neon`).

Rewire `risk-classifier.js:46-58` and `design/verify.js:137-158` onto it.

*Tests (`test/bug-309-keyword-boundaries.test.js`):*
- `classify()` returns `feature` for the exact shipped spec string. Fails on HEAD.
- A table test that walks **every** keyword in `KEYWORDS` and in verify.js's
  requirement list, embeds each inside a longer real word (`typo`→typography,
  `add`→address, `change`→exchange, `neon`→neonatal, `mobile`→automobile,
  `dark`→darker) and asserts none match. This is the assertion that stops the
  next instance.
- Negation: `"light theme, not dark"` must not require `dark.theme`.

**2. BUG-312 pattern side — stop sniffing for the word "dark".**
Replace `/dark/i` with a computed check: parse the `body`/`:root` background
colour and test its luminance.

*Test:* a page whose dark background is only `var(--bg)` / `rgb(18,18,18)` passes;
a light page fails. Both fail on HEAD (the first is the false negative that
discarded the fixed regeneration; the second is the false positive that let
`--color-accent-dark` satisfy the rule).

**3. BUG-310 — resolve the design system before `enqueue()`.**
`executePipelineCard` becomes async, or the design system is resolved in a small
pre-step and the finished prompt handed to `enqueue`. Mirror the identical shape
in `buildKanbanCard` (`:748-755`).

Then, separately in `build-runner.js`: the refine regeneration at `:347` and the
grounded rebuild at `:581` must both build from the *current* full prompt, and
anything `run()` regenerates must go back through the source verifier before it
is saved.

*Tests (`test/bug-310-design-system-reaches-generation.test.js`):*
- A capturing fake engine records every prompt `generate()` receives. Assert the
  design-system header is present in **the first** prompt, not only in the
  grounded rebuild. Fails on HEAD.
- A `tiny-fix`-risk card (research skipped) still receives the design system.
- A refine regeneration receives both the design system and the research brief.
- A grounded rebuild's output is source-verified before `saveDeliverable`.

**4. BUG-311 + BUG-316 — invert `completion-status.js` from denylist to allowlist.**
This is the single assertion that covers both, and the reason the class has
recurred five times.

`deriveCompletionPayload` takes `{ reviewStatus, buildEngine, refineStatus }` and
returns `done` **only** when review is a real `approved` from a reviewer that
actually ran, the engine is real, and refine did not end in `reverted` /
`exhausted` / a `blind` verdict on a page that errored. Every other value —
including any value added in future — degrades to `needs-work`.

Add a third review state, `skipped`, at `agent-actions.js:593/622`, and pass
`job.refineStatus` through at `:632`.

*Tests (`test/bug-311-316-completion-is-allowlist.test.js`):*
- `refineStatus: 'reverted'` → not `done`. Fails on HEAD.
- review skipped → `reviewStatus: 'skipped'` and not `done`. Fails on HEAD.
- **An unknown future status value → `needs-work`.** This is the guard against
  the sixth recurrence.

## Phase 2 — search truthfulness

**5. BUG-315 — the bare word "news" must not route to an RSS-only answer.**
Either require the RSS result set to survive a topical check against the query's
subject terms, or run RSS **and** one general provider and merge. Separately,
honour a stated window: `when:7d` when the query says week or 7 days.

*Tests (`test/bug-315-news-marker-is-not-a-topic.test.js`, fixtured RSS — no live
network in the suite):*
- A result set whose titles share no topic term with the query does not short-
  circuit the chain. Fails on HEAD.
- A query saying "past week" requests `when:7d`.
- The freshness gate itself is unchanged: a timeless query still never reaches
  rung 0a. (Pins the existing safety property so this fix cannot weaken it.)

**6. BUG-314 — no source text, no body copy — and fetch the article to get the
text. (Operator decision: "Enforce, but fetch the article".)**

Pass the result URLs into the build prompt; require every card to link its source;
make `href="#"` a hard verifier issue on a research-grounded build. Then, so cards
are not empty, fetch each source for real summary text.

> ⚠️ **SECURITY CONSTRAINT ON THIS DECISION — read before it is built.**
> Google News RSS does not return publisher URLs. It returns an opaque
> redirector (`https://news.google.com/rss/articles/CBMi…`). `web-search.js`'s
> own comment at `:104-118` records that fetching one *"would walk an
> attacker-influenced redirect chain — the same shape as the two SSRF bypasses
> already recorded in web-fetch.js"* (IPv4-mapped loopback at `:30`, a 302 to
> cloud metadata at `:116`). Not fetching those links is currently a deliberate
> safety property, not an oversight.
>
> Your call stands and I will build it — but only through the hardened path, not
> a bare `fetch`:
> - route every article fetch through the **BUG-303-hardened** `web_fetch`, whose
>   agent re-validates **every resolved address at dial time** (`net-address.js`,
>   `web-fetch.js:45,66,204`). That is the check-and-connect fix that closed the
>   rebinding hole; it is the only correct way to follow an untrusted redirect.
> - cap redirect hops, require the final host to be a public address, require a
>   `text/html` content type, and size-cap the body.
> - if the chain is refused, the card falls back to **headline + link, no body** —
>   the strict option. A refused fetch must never become invented prose.
>
> Memory note `two-web-fetch-copies-one-guarded` applies: this must use the
> *guarded* copy, and the test must exercise the **registered tool**, not the
> module.

*Tests (`test/bug-314-no-invented-body-copy.test.js`):*
- A build grounded on snippet-less results contains no `href="#"`. Fails on HEAD.
- The verifier rejects a placeholder image host (`picsum.photos`,
  `placehold.co`, `via.placeholder.com`) presented with a named-person `alt`.
- Body copy appears only when an article fetch actually returned text.
- **SSRF regression:** a Google-News-shaped redirector whose chain lands on
  `127.0.0.1`, an IPv4-mapped loopback, or `169.254.169.254` is refused, and the
  card degrades to headline-and-link rather than fetching it. Fails on HEAD
  (HEAD does not fetch these at all, so this test is what makes the new surface
  safe rather than assumed safe).

## Phase 3 — verifier quality

**7. BUG-313 — give the LLM judge a window that contains content.**
Strip `<style>` and `<script>` blocks before slicing, or sample head *and* body.

*Test:* a 6 KB inline-style page yields a window containing the `<h1>` text.
Fails on HEAD, measurably (`<body>` at 3 329 of 5 436).

## Phase 4 — honesty and hygiene

**8. BUG-317 — signed artifact URL. (Operator decision: signed URL.)**

Mint a short-lived signed query token onto the artifact URL so the browser can
load it without a header, and preflight *that* URL — the one the browser will
actually request — instead of a header-authenticated one. This removes the
TOCTOU: the thing checked becomes the thing used.

Auth-surface rules for it, since this is new authenticated surface:
- signature over `path + expiry` with an HMAC keyed on `MYTHOS_AUTH_TOKEN`; no
  new secret to manage.
- short expiry (single-digit minutes), verified server-side in the same
  `requireToken` path so there is one door, not two.
- scoped to `/vault/builds/**` only — never a general vault-read bypass.
- constant-time compare; expiry checked before the signature is trusted for
  anything.

*Tests (`test/bug-317-signed-artifact-url.test.js`):*
- With `MYTHOS_AUTH_TOKEN` set, a header-less GET of the URL `open_artifact`
  returns succeeds. Fails on HEAD (401).
- `open_artifact` never reports `opened: true` for a URL a header-less request
  cannot load. Fails on HEAD.
- An expired token is refused. A token for `builds/a.html` does not open
  `builds/b.html`. A token cannot reach outside `/vault/builds/`.
- Tampering with the path or the expiry invalidates the signature.

**9. BUG-319** — `open_artifact` reports artifact age, and refuses a path-only
call whose file predates process start unless `jobId` is given.
*Test:* a 10-day-old file, path-only → refusal naming the age.

**10. BUG-318 — WITHDRAWN, nothing to do.** Not a defect: `actionStatus()`
already honours the evidence contract, and the `FAIL` came from my own dump
script. See the BUG-318 section above.

**11. BUG-320** — strip `[[ ]]` in `note_read`. *Test:* `"[[Foo]]"` resolves the
note `Foo`.

**12. BUG-321** — suppress the install hint when the probe reports online and
version-matched. *Test:* a load-time crash with `online:true` produces a message
containing no `--install` instruction.

**13. BUG-322 — WITHDRAWN, and the proposed fix would have been harmful.** The
detector has no false positives; re-checking after the field set would have
suppressed 23 true reports of real data loss. See the BUG-322 section above. The
number itself now belongs to an unrelated barge-in fix (`ee11585`).

**13b. BUG-324 (added 2026-08-23) — two anomalies must report the cause they
already know.** Measured on the wired chain: `confirm-expired-silently` and
`live-turn-stalled` are both spoken as *"I do not yet know the cause"* while the
emitter holds the cause — the leash writes `confirm-ttl-expired` into the audit
row three lines above its own emit, and the Live session holds the `waitedMs` it
just missed. Fixed at the emitters, not downstream. `needsOperator: true` on the
confirm expiry (a person answering IS the remedy, so no mechanical remedy is
guessed and no brain round-trip is spent); deliberately NOT on the stall, because
nobody can make a reply arrive.
*Tests:* `test/bug-324-anomaly-must-report-a-cause-it-knows.test.js` — 5, including
a vacuity guard that an anomaly with genuinely no cause still says so, and a
disposition test that neither kind gains a playbook.

**13c. BUG-323 (added 2026-08-23) — tool-name suggestions match on segment
boundaries.** The last instance of the BUG-309 class. See the corrected entry
under "Sixteen sites, enumerated".
*Tests:* `test/bug-323-tool-suggestions-respect-word-boundaries.test.js` — 7,
including all nine good suggestions measured on HEAD, so a fix that over-fires is
caught too.

**14. Operational, no code — REVISED 2026-08-23, and one part is NOT safe to do
unattended.**

- **Gmail re-auth** still needs the operator: `node scripts/google-auth.js`, then
  a fresh `GOOGLE_REFRESH_TOKEN` in `mythos/.env`. Requires a browser consent
  flow, so it cannot be done from a session.
- **Canonical vault — MEASURED, and bigger than this line implied.** There are
  **three** vaults with real data, not two:

  | Path | Files | Size | Written since Aug 1 |
  |---|---|---|---|
  | `%APPDATA%\MYTHOS\vault` (canonical per operator decision) | 694 | 169 MB | all 694 |
  | `<repo>\mythos\vault` (batch/dev launcher) | 412 | 154 MB | 197 |
  | `%APPDATA%\agent-os\vault` (pre-v0.1.9 Electron name) | 84 | 12 MB | 84 |

  Switching `DEFAULT_VAULT_ROOT` before merging would make 154 MB of real memory
  invisible while reporting healthy — which is the exact "factory-reset MYTHOS"
  incident `src/core/config/schema.js`'s own header was written to prevent, and
  `scripts/merge-vault.js` says in its header that picking the canonical path is
  a separate, deliberate decision for this reason.
  **Correct order: merge (dry run, read, then `--write`), verify, and only then
  switch the default — with the app closed.** Left for the operator's live
  session; a dry-run report is the safe prep and costs nothing.
  Note the switch must also stay cross-platform per the portability rule: the
  default cannot be a literal `%APPDATA%` path.
- **The Aether 4480 collision is a separate writer**, not fixed by the vault
  decision alone.
- **The 160-item incident ledger** is untouched.

## Constraint I will hit, flagged now

The 800-line rule is already violated by three files this touches:
`from-dashboard.js` (1 418), `from-computer.js` (997), `web-search.js` (928),
with `agent-actions.js` at 885. I will **not** refactor them as part of these
fixes — that is exactly the "touch only what the task needs" rule — but I am not
going to pretend the fixes bring those files back under the limit either. The new
logic goes into small new modules (`keyword-match.js`, and the completion-status
change stays inside its existing 51-line file) rather than growing the offenders.

---

## Verification

Per fix: red-then-green on the named test. No fix is done until its test has been
seen failing on HEAD.

End-to-end, after Phase 2, re-run the operator's original request through the live
system — not simulated — and check on the resulting job record and card that:

- `risk` is `feature`, not `tiny-fix`
- `researchStatus` is `grounded`
- the first `generate()` prompt contained the design-system block
- `refineStatus` is `passed-first-look` or `refined`, not `reverted`
- `reviewStatus` is a verdict a reviewer actually produced
- the artifact contains a font `@import`, real source links, no `href="#"`, no
  `picsum.photos`
- the stories are AI stories

Suite, with the port overrides this repo requires (the app will be running):

```bash
cd mythos && MYTHOS_PORT=4999 EDGE_TTS_PORT=5099 EDGE_TTS_URL=http://127.0.0.1:5099 node --test
```

Then the count gate — and only after the suite is green, because `--write` records
a red run into the docs:

```bash
cd mythos && node scripts/sync-test-count.js --check
```

**Two items get a security pass before they merge, because both add new
attacker-reachable surface:** the signed artifact URL (step 8) and the article
fetch (step 6). Both go through the nine-class check, and both ship with the
negative tests named above — an expired/tampered token refused, and a redirector
chain landing on loopback or cloud metadata refused.

## What this plan does not cover

*Revised 2026-08-23, after all four phases shipped.*

- **No live re-run of the build has happened.** This is the largest remaining gap
  and it is the one thing that cannot be closed from a session: every fix here is
  unit-verified only. The end-to-end check in the Verification section — `risk`
  is `feature`, `researchStatus` is `grounded`, the design system is in the FIRST
  prompt, real source links, no `href="#"`, no `picsum.photos`, and the stories
  are actually about AI — needs the operator to run the original request.
  Given that the whole failure was things passing their own checks, an
  unexercised fix set is exactly the state this audit exists to distrust.
- **`hub.js:144` is now FIXED** (BUG-323), and this bullet's earlier framing of it
  as a "tool scorer" was wrong — corrected in place above.
- **The `live-turn-no-user-transcript` events are all REAL** — the "5 of 13 false
  positives" claim is withdrawn (bad join on a per-session counter). 23 turns of
  operator speech reached Gemini and came back untranscribed in one day, several
  with substantial audio. Unexplained, vendor-side, and needs its own
  investigation using the release log's `framesDropped`/`heldMs`. **This is now
  the most serious unresolved finding in this document.**
- **Anomaly playbooks — the premise was wrong for all three, in two different
  directions.** Measured on the wired chain 2026-08-23:
  - `gmail-reauth-required` is **already correct** and must be left alone. Its
    sensor sets `needsOperator: true` with the full instruction, so BUG-273 C2
    short-circuits, the brain is never asked, and the operator hears the real
    remedy. Adding a playbook would route it off that path and announce a heal
    that never happened.
  - `confirm-expired-silently` and `live-turn-stalled` did **not** need playbooks
    either — they needed a `reason`. Fixed as BUG-324. An `acknowledge` playbook
    would have resolved with outcome `applied`, which `immune/announcer.js`
    speaks as "Self-healed: …" — reintroducing exactly the BUG-311/316 class this
    branch spent four phases removing.

    The general lesson: **"no playbook" is not the same as "unhandled".** The
    no-match path runs the explainer, which is often the right answer. Measure
    what the operator actually hears before adding a remedy.
- **The Linear-incident attribution question** cannot be settled from these logs.
- Nothing here touches the licensing gate or the post-parity plan.
