# brainstorming (essence)

Turn an idea into an approved design before any code is written.

## Hard gate

Do not scaffold, write code, or invoke an implementation skill until a design
has been presented and the operator has approved it. This applies to every
project regardless of how simple it looks — "too simple to need a design" is
exactly where unexamined assumptions do the most damage. A simple project's
design may be three sentences, but it still gets presented and approved.

## Order of work

1. **Explore context** — existing files, docs, recent commits. Reuse beats
   invention; find what already does the job before proposing new code.
2. **Ask clarifying questions one at a time.** Purpose, constraints, success
   criteria. Not a questionnaire dump.
3. **Propose 2–3 approaches** with real trade-offs, and name a recommendation.
4. **Present the design in sections**, scaled to their complexity, taking
   approval section by section rather than as one wall of text.
5. **Write the design down** so it survives the session, then re-read it for
   placeholders, contradictions, ambiguity and scope creep.
6. **Hand off** to writing-plans for the implementation plan.

## Signals of a bad brainstorm

A single mega-question. Approaches that are the same idea reworded. A design
that restates the request instead of deciding anything. Silent assumption of a
stack, a schema, or a UI shape the operator never mentioned.
