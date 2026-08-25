# Why MYTHOS's landing page was worse than the one Claude wrote by hand

**Date:** 2026-08-23
**Occasion:** the operator asked MYTHOS and Claude for the same thing — search the web for
this week's AI news, pick five, build a premium dark AI-digest landing page. Both
attempts were run live and measured. This is what the difference actually was, and
the plan to close it.

---

## First, what did NOT happen

**MYTHOS did not put random Indian government news on a page.** Asked to research
and build in one task, it could not reach the web, said so, and shipped **nothing** —
the verifier rejected the refusal text as "not the requested HTML landing page", the
job retried once and failed honestly. No artifact, no invented headlines.

The unrelated news (a sinking cargo ship, Canada tariffs) came from a *separate*
call to `/api/news`, which has its own defect (RC2 below).

Getting this right matters, because "it hallucinated news" and "it refused because it
has no web access" need opposite fixes. The honesty gates from the 2026-08-22 audit
worked exactly as designed. The capability behind them is missing.

---

## The measured difference

Both pages, same brief, same day:

| | Claude, by hand | MYTHOS |
|---|---|---|
| Web research | live search, stories 2h old | none — engine has no web access |
| Fonts actually loaded | Newsreader + Roboto, 48 faces | **0** — declared, never loaded |
| Hero headline | 76px serif | 20px, fallback sans |
| Hero | 720px, full-bleed | 350px, boxed |
| Page height | 2,066px | 1,189px |
| Horizontal scroll at 375px | none | — |
| Content accuracy | 5/5 sourced | 5/5 sourced |

**The most important row is the fonts.** MYTHOS chose *the same typeface pairing
Claude did* — Newsreader/Roboto, editorial black, accent `#EC4899` — because both got
it from the same `ui-ux-pro-max` skill. It then never emitted the `<link>` that loads
them, so the whole page fell back to default sans and lost its editorial character.
The judgement was right; the execution dropped one line.

---

## Root causes, each with the evidence that proves it

### RC1 — The build engine cannot reach the web, and research/design are mutually exclusive

`buildPack.classifyDeliverable(brief)` returns **one** kind. A `ui` build gets the
design system; a `research` build gets agent-reach findings. There is no kind that
gets both, so "research the news **and** design a page" resolves to `ui` and silently
loses the research half.

*Evidence:* the brief classified `ui`; job failed with
`"No live web research or AI news selection was performed"`. Today's audit ledger has
zero `web_search` / `web_fetch` entries for the build.

*Impact:* the single biggest capability gap. MYTHOS cannot turn live data into a
deliverable in one step, which is most of what the operator wants from it.

### RC2 — `/api/news` ignores its query

`server/routes/news.js:24` calls `newsFeed.fetchNews()` with **no arguments**. Any
`?q=` is silently discarded and the caller gets the general feed.

*Evidence:* `GET /api/news?q=artificial+intelligence` returned a cargo-ship sinking,
Canada tariffs, and BJP social-media strategy. Zero AI stories.

*Related:* this is the BUG-315 shape (one general-news index answering every query)
resurfacing in the HUD route rather than the effector.

### RC3 — One incidental noun in the brief picks the entire design language

`designQuery()` already strips article *content* — a fix from 2026-07-31, after a
news card mentioning "price-performance" and "security tests" resolved to a **pricing
page with SOC2 badges**. It is not enough. The query still carries layout nouns and
the product name, and `search.py` does bag-of-words matching where a single token
dominates.

*Evidence, measured today:*

| query | style returned |
|---|---|
| `AI news editorial magazine digest dark premium tech journalism` (clean) | **Dark Mode (OLED)** ✓ |
| the real brief, containing the words *story cards* | **Bento Box Grid** ✗ |
| the first brief, opening *"Research the live web…"* | **Marketplace / Directory — search bar is the CTA"** ✗ |

`cards` is a keyword of Bento Box Grid. Two words of copy overrode "dark-theme
editorial magazine".

Worse: for a brief that says **dark**, the resolver returned `Background #FAFAFA` —
a light palette. MYTHOS overrode it correctly, but it should never have been handed.

### RC4 — There is no output contract, so supplied instructions are optional

The design-system block **does** contain the exact line needed:

```css
@import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap');
```

The model received it and did not use it. The `ui` pack block (7,226 chars) contains
taste-frontend's rules and mentions responsiveness, contrast and self-containment —
but has **no OUTPUT CONTRACT section**, and never says "if you name a webfont you must
emit the tag that loads it."

*Precedent:* this repo already learned this once. Both build harnesses failed the same
verifier rule until a single `OUTPUT_CONTRACT` line took the score from 2/9 to 8/9.
Guidance that is merely *available* gets skipped; guidance stated as a contract gets
followed.

### RC5 — The verifier checks that elements are *mentioned*, not that they *work*

`design/verify.js` derives required elements from spec keywords — hero, cta,
dark-theme — and checks the HTML for them. Nothing checks:

- that a declared webfont is actually loaded
- heading hierarchy (a 20px "hero" headline passes)
- page substance (a 1,189px page passes as a landing page)
- that the page renders without external files it never fetches

*Impact:* a page that declares Newsreader and loads nothing is **verified as correct**.

---

## The plan

Ordered by value per unit of risk, not by size. Each step ships with a test that is
red before and green after, per the repo's prime rule.

### Step 1 — OUTPUT CONTRACT in the build pack *(smallest change, biggest visible win)*

Add an explicit, numbered contract to `packBlockFor('ui')`, stated as requirements
rather than advice. At minimum:

1. If you name a webfont, emit the `<link>` or `@import` that loads it, with
   `display=swap`. A `font-family` naming a font you did not load is a defect.
2. The hero headline is the largest text on the page — use a `clamp()` scale, minimum
   40px at desktop.
3. A landing page has a full-bleed hero; the hero section spans the viewport width.
4. No external image files. Use CSS gradients or inline SVG so the page renders offline.
5. Never make text visibility depend on JavaScript or on an animation completing.

Rule 5 is there because **Claude shipped that exact bug today** and caught it only by
measuring: an IntersectionObserver reveal left all four stories at `opacity: 0` in a
backgrounded tab, and the `setTimeout` failsafe was throttled too. Then the CSS-only
rewrite failed the same way, because a paused animation holds its first frame. The
fix was to animate movement only and never opacity. If a careful agent walks into it,
a build model will.

**Test:** `test/build-pack-output-contract.test.js` — assert the `ui` pack contains
each numbered rule. Source-shape, loose matching, with a comment saying why an
end-to-end test is not the gate here.

**Done when:** a rebuild of the same card emits a font `<link>` and a hero headline
above 40px, measured in a browser, not asserted.

### Step 2 — Verify execution, not vocabulary

Extend `design/verify.js` with checks that read the built artifact:

- every `font-family` naming a non-system font has a matching `<link>`/`@import`
- the largest heading is at least 2× body size
- page has more than N bytes / sections when the spec says "landing page"
- no `<img src="http…">` when the spec asked for self-contained

Each failure names the rule and the fix, in the style already used by the size ratchet.

**Test:** feed the verifier the artifact MYTHOS produced today — it must now FAIL on
the font rule. That artifact is kept as a fixture; it is the best regression case
available because it is a real failure, not a synthetic one.

**Done when:** today's page fails, Claude's page passes, and both results are asserted.

### Step 3 — Stop incidental nouns choosing the design

Tighten `designQuery()`:

- drop the product/brand name (quoted strings, `called "X"`)
- drop layout nouns that are not style words — `cards`, `grid`, `hero`, `section`,
  `page`, `header`, `footer` — since they name structure, not aesthetic
- keep the STYLE_WORDS allowlist, and *prefer* it: if any style word is present, weight
  the query toward those words rather than the surrounding sentence
- pass the resolved `mode` (dark/light) explicitly instead of hoping the palette matches

**Test:** table-driven, using the three real briefs measured above and their known-bad
outputs. Assert the dark editorial brief no longer resolves to Bento/Marketplace, and
that a light-theme brief still resolves light. This is the same shape as
`bug-274-barge-in-floor-separates-populations` — assert against measured populations,
not against the constant.

**Done when:** all three historical briefs resolve to an editorial/dark system, and the
returned background is dark when the brief says dark.

### Step 4 — Fix `/api/news`

Pass the query through to the news effector and use the topical path (`news-rung`)
rather than the fixed feed; return an honest empty result when a topic yields nothing,
never the general feed as a fallback.

**Test:** request a topic with no coverage and assert the response is empty rather than
generic — the repo already has the `a-source-that-never-returns-zero` lesson written
down; this pins it in the route.

**Done when:** `/api/news?q=artificial intelligence` returns AI stories or nothing.

### Step 5 — Let one build both research and design *(the real capability gap)*

Two options, and this is the operator's call:

**5a — Composable packs (recommended).** Make `classifyDeliverable` return a *set*, not
a single kind, and let `packBlockFor` / `resolveSkillToolFor` merge blocks. A brief that
is both research and UI gets both. Bounded by `MAX_PACK_CHARS`, ordered so design rules
come last (recency wins in-context).

**5b — Research-then-build pipeline.** Keep one kind per build, but add a preliminary
research stage to `build-runner`: when the brief asks for live data, run MYTHOS's own
`web_search` first and inject the findings into the spec, then build. This is exactly
what Claude did by hand today, and it worked.

5b is smaller, safer, and matches the proven manual path. 5a is more general and more
invasive. **Recommendation: 5b first, 5a only if a second case needs it.**

**Test:** a build whose brief says "use today's real X" must show `researchStatus` on
the job and cite at least one fetched source in the artifact. BUG-314 already added the
grounding check that "nothing verified whether a researched build used its research" —
reuse it as the assertion.

**Done when:** the original one-shot brief — *research the live web, pick five, build
the page* — produces a page with real, sourced, dated headlines.

---

## Order and effort

| Step | Effort | Risk | Unblocks |
|---|---|---|---|
| 1 OUTPUT CONTRACT | small | low | most of the visual gap |
| 2 verifier | small–medium | low | stops silent regressions |
| 3 design query | medium | medium | correct archetype + palette |
| 4 `/api/news` | small | low | topical news anywhere |
| 5b research→build | medium | medium | the actual capability |

Steps 1–2 are worth doing before anything else: together they turn "the model chose
well and executed badly" into a caught, named failure rather than a shipped page.

## What is deliberately NOT in this plan

- **No new build engine, no model swap.** The engine picked the right design system and
  the right five facts. It failed on instruction compliance and on missing capability,
  neither of which a different model reliably fixes.
- **No prompt-tuning by feel.** Every change above is pinned by a test against a
  measured case, because this repo has twice shipped opposite-direction regressions by
  adjusting two things at once and judging by eye.
- **No change to the honesty gates.** They were the one part that worked perfectly
  today: MYTHOS refused rather than fabricate, and the verifier caught the refusal.
  Nothing here should make it easier to ship a plausible-but-wrong artifact.
