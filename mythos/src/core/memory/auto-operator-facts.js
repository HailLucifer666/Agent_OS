'use strict';

// auto-operator-facts.js — the one switch for every BACKGROUND writer of what
// MYTHOS infers about the operator (BUG-464 widened, operator decision 2026-10-06:
// "nothing goes into permanent memory unless the operator asked for it or
// approved the exact text read back").
//
// A background writer runs with no operator turn at all — every ~15 turns, at
// shutdown, after a third play — so there is nobody to read a text back to, and
// the consent token (leash/consent.js) cannot apply. The precedent is BUG-463's
// step 3b in memory/index.js: off unless MEMORY_AUTO_USER_FACTS is exactly "true",
// the operator's own written opt-in. Same variable, same literal, so one setting
// means one thing: "MYTHOS may write down what it infers about me without asking."
// Gated by it (test/bug-464-background-writers-need-the-operator.test.js (d1)
// re-derives the writers on every run):
//   memory/index.js step 3b       user-facts from conversation (BUG-463, literal kept there)
//   identity/reflection.js runNow learned preferences, speaking style, operator profile
// Not gated, by design: the operator's own requests (remember, note_take,
// write_note), which carry a consent token instead; and, by the operator's
// second decision of 2026-10-06, the habit promoter, which stays on and promotes
// only behaviour repeated on 2+ days (memory/habit-promoter.js MIN_HABIT_DAYS).
//
// `env` is injectable so a test never has to mutate process.env.

const SWITCH = 'MEMORY_AUTO_USER_FACTS';

function autoOperatorFactsOn(env) {
  return (env || process.env)[SWITCH] === 'true';
}

module.exports = { autoOperatorFactsOn, SWITCH };
