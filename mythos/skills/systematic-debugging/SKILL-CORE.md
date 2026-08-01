# systematic-debugging (essence)

## Iron law

**No fix without a root-cause investigation first.** Random fixes waste time
and create new bugs; a patch that hides a symptom is a failure, not a partial
success. Applies especially under time pressure, when the fix looks obvious,
and when a previous fix already failed.

## Phase 1 — Investigate

Read the error text and the whole stack trace; they frequently contain the
answer. Reproduce it consistently before theorizing. Note exact line numbers,
paths and codes rather than a paraphrase of them.

## Phase 2 — Find the pattern

Locate similar code in the same codebase that *works*. Read the reference
implementation completely rather than skimming it. List every difference
between working and broken, however small — "that can't matter" is where the
bug usually lives. Check dependencies, config and environment assumptions.

## Phase 3 — One hypothesis at a time

State it explicitly: "X is the root cause because Y." Test it with the
smallest possible change, one variable at a time. If it fails, form a NEW
hypothesis — never stack another fix on top of the last one. If you do not
understand something, say so instead of guessing.

## Phase 4 — Fix the cause

Write the failing reproduction first, then make ONE change addressing the root
cause. No "while I'm here" refactoring bundled in. Verify the reproduction now
passes and nothing else broke.

## The three-fix rule

After three failed fixes, stop. Do not attempt a fourth. When each fix reveals
new coupling elsewhere or demands a large refactor, the problem is the
architecture, not the hypothesis — raise that with the operator instead of
continuing to patch.

## In this repo specifically

A plausible theory has been wrong more than three times here. Nothing is fixed
until it is verified against the running system or its oracle.
