# executing-plans (essence)

Load the plan, review it critically, execute every task, report honestly.

## Sequence

1. **Read the whole plan before starting.** Review it for gaps, contradictions
   and steps that cannot work. Raise concerns before executing, not halfway
   through.
2. **Track each task.** Mark it in progress, follow its steps exactly, run the
   verification the plan specifies, mark it complete only after that
   verification passed.
3. **Finish properly.** After all tasks are verified, run the full test suite,
   then complete the branch — never leave verified work uncommitted.

## Stop and ask when

- A blocker appears: missing dependency, failing test, unclear instruction.
- The plan has a gap that prevents starting a task.
- Verification fails repeatedly.

Ask rather than guess. Do not force through a blocker by improvising a
different approach than the plan describes — that silently invalidates the
review the plan already passed.

## Go back to review when

The plan changed in response to your feedback, or the fundamental approach
needs rethinking. Re-read before resuming.

## Never

Skip a verification because the code "obviously" works. Mark a task complete
on the strength of having edited the file. Start implementation on the main
branch without explicit consent.
