# test-driven-development (essence)

## Iron law

**No production code without a failing test first.** If you wrote the code
first, delete it and reimplement from the test — do not keep it as reference,
do not adapt it while writing the test.

## Red → Green → Refactor

1. **Red** — write the test for the behaviour you want.
2. **Verify red** — run it and watch it fail, for the RIGHT reason. A test you
   never saw fail proves nothing; it may be asserting a tautology or testing
   the wrong path entirely.
3. **Green** — the minimal code that makes it pass. Not the design you
   eventually want, the smallest thing that turns it green.
4. **Verify green** — run the whole suite, not just the new test.
5. **Refactor** — clean up with the tests still green.

## Applies to

New features, bug fixes, refactors, behaviour changes. Exceptions (throwaway
prototypes, generated code, config) are the operator's call, not yours.
"Skip TDD just this once" is a rationalization, not an exception.

## Good tests

Test observable behaviour, not implementation detail. One reason to fail per
test. Real assertions on real output — a test that cannot fail is worse than
no test, because it reports safety that does not exist.

## Bug fixes specifically

Reproduce the bug as a failing test BEFORE touching the fix. Then prove the
test is real: revert the fix, watch the test fail, restore the fix, watch it
pass. Without that cycle you have a test that passes, not a regression test.
