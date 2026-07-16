# karpathy-guidelines — essence (distilled; full text in SKILL.md)

Guidelines against the four common LLM coding failure modes.

1. **Think before coding.** State assumptions explicitly; if multiple readings exist, present them —
   never pick silently. If a simpler approach exists, say so. If unclear, stop and name what's confusing.
2. **Simplicity first.** Minimum code that solves the actual problem. No speculative features,
   no abstractions for single-use code, no unrequested configurability, no error handling for
   impossible states. If 200 lines could be 50, write 50.
3. **Surgical changes.** Touch only what the task needs. Don't improve adjacent code, comments, or
   formatting. Match existing style. Remove orphans YOUR change created; mention (don't delete)
   pre-existing dead code. Every changed line traces to the request.
4. **Goal-driven execution.** Turn the task into a verifiable goal ("make X pass", "behave Y"),
   plan step → check, and loop until verified. Report failures honestly with output.
