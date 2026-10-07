'use strict';

// operator-lines.js — does a distilled line describe the OPERATOR? (Operator
// decision 2026-10-06.) memory/index.js step 3 distils recent high-salience
// episodes into consolidated-* topics. It stays on, because what it keeps about
// MYTHOS itself ("4 active goals and 160 incidents logged", BUG-463's measured
// output) is its job. But nothing goes into permanent memory about the operator
// unless the operator asked for it or approved the exact text read back, and
// nobody asks this pass for anything. So each line it would write that describes
// the operator is DROPPED.
//
// DROPPED, NOT QUARANTINED. Quarantine (semantic.js's low-confidence write for
// identity claims) still puts the line in permanent memory, still recallable;
// that is exactly what the rule forbids. The operator who wants inferred facts
// about themselves has step 3b behind MEMORY_AUTO_USER_FACTS. The dropped text is
// not logged anywhere either: only a count leaves this module.
//
// DERIVED FROM EXISTING CODE, not a new word list:
//   - OPERATOR_REFERENTS are the words voice/authority-words.js FILLER already
//     lists as how the model names the operator ("my" becomes "the operator's",
//     "I" becomes "User"); test (o2) checks each is still there.
//   - IDENTITY_CLAIM_RE is semantic.js's BUG-080 pattern (name, what to call
//     them), which catches the subjectless "Prefers to be called boss.".
// ATTACKED 2026-10-06: "Superuser", "users' sessions" in a system line — word
// boundaries keep "superuser" out; "users" IS a referent, so a status line about
// "users" is dropped (safe direction: a lost status line costs nothing durable).
// BOUND: a line naming the operator only by their own name ("Arghya likes jazz")
// or only by a pronoun ("He likes jazz") is kept; the model writes "The user"
// in this pass, and nothing here knows the operator's name. A mixed line ("The
// user asked for a restart; 4 goals are active") is dropped whole.

const { IDENTITY_CLAIM_RE } = require('./semantic');

const OPERATOR_REFERENTS = Object.freeze(['user', 'users', 'operator', 'operators', 'sir']);
const REFERENT_RE = new RegExp("\\b(?:" + OPERATOR_REFERENTS.join('|') + ")(?:'s|’s|s')?\\b", 'i');

function describesOperator(line) {
  const s = String(line || '');
  return REFERENT_RE.test(s) || IDENTITY_CLAIM_RE.test(s);
}

// A distillation blob, line by line: { kept: the remaining lines joined as they
// were, dropped: how many lines described the operator }.
function withoutOperatorLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = lines.filter((l) => !describesOperator(l));
  return { kept: kept.join('\n').trim(), dropped: lines.length - kept.length };
}

module.exports = { describesOperator, withoutOperatorLines, OPERATOR_REFERENTS };
