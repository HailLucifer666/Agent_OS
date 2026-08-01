# verification-before-completion (essence)

## Iron law

**No completion claim without fresh verification evidence.** If the command
that proves the claim was not run just now, the claim cannot be made. Claiming
work is done without checking is dishonesty, not efficiency.

## The gate

Before any statement of status, success, or satisfaction:

1. Identify the command that would prove the claim.
2. Run it fully — fresh, complete, not a subset.
3. Read the whole output: exit code, failure count, warnings.
4. Does the output actually confirm the claim? If not, report the real state
   with the evidence attached.
5. Only then make the claim, and state it with the evidence.

## What proves what

| Claim | Requires | Not sufficient |
|---|---|---|
| Tests pass | Test output showing 0 failures | An earlier run, "should pass" |
| Build succeeds | Build exit 0 | Linter passing, logs looking fine |
| Bug fixed | Original symptom retested | Code changed, assumed fixed |
| Regression test works | Red→green cycle observed | It passed once |
| Delegated work done | The diff inspected | The agent reported success |
| Requirements met | Line-by-line checklist | Tests passing |

## Red flags

"Should", "probably", "seems to". Celebrating before running anything.
Committing or pushing without a verification run. Trusting a subagent's own
success report. Deciding partial verification is enough. "Just this once."

## Applies to

Exact phrases, paraphrases, and anything that merely implies success. Evading
the wording while skipping the check is still a violation.
