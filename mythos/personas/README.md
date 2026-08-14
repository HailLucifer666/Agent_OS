# Agent personas

One markdown file per role. The file's whole content becomes the **system
message** for that agent's `brain.think()` call (see `src/core/brain/index.js` —
a per-call `persona` replaces the global identity, and only on lanes that
accept one: `voice`, `build`, `simple`, `reasoning`, `memory`).

## What goes in a persona file

The **identity**: who this agent is, what it is expert in, what standards it
holds, and what it refuses to do.

## What must NOT go in a persona file

The **task** and the **output contract**. Those belong to the caller's preamble
— `review-rubric.js`'s `buildReviewerPreamble()` and `REALITY_CHECK_PREAMBLE`
already specify the criteria list and the exact JSON shape each seat must
return. Restating a JSON shape here would create a second source of truth for
it, and the two would drift apart silently: the preamble is what the parser is
written against, so a persona file disagreeing with it produces output that
parses to nothing and a seat that looks like it merely had no findings.

## Where these are read from

First match wins:

1. `$MYTHOS_PERSONAS_DIR` — explicit override, `path.delimiter`-separated.
2. `mythos/vault/Personas/<role>.md` — **your own edits**. Gitignored, per
   machine, and deliberately ranked above the defaults: a customisation that
   loses to a shipped file is a customisation that does nothing. Copy a file
   from this directory there and edit it.
3. `mythos/personas/<role>.md` — this directory, tracked in git, so a fresh
   clone has real personas with no setup.

## History

Until 2026-08-15 only `vault/Personas/` was searched, and it is gitignored and
did not exist — so `loadPersona()` returned `null` for every role on every
machine and each seat silently fell back to the global MYTHOS identity. Nothing
threw and no test failed; the reviewer simply reviewed as generic MYTHOS. It
became worth fixing when the 2026-08-14 lane rewire moved these seats onto a
measured 4/4 reasoning model — a strong model with no brief is confidently
generic, which is a more expensive failure than a weak one.
