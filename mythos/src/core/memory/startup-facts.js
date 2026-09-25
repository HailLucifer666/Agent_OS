'use strict';

// BUG-463 (2026-09-25) — notes the operator saved FOR STARTUP ("Upon boot, give a
// status update on ...", "... upon startup") belong to the boot greeting, which runs
// once per process, and to nothing else.
//
// Operator decision, 2026-09-25 ("startup greeting only"). The measurement that came
// before it: on the operator's vault these notes were facts 17, 18 and 20 of 365, so
// they reached no prompt at all — the Live setup frame keeps only the newest ~96
// facts, and a semantic recall snippet only the first three. They were not the cause
// of the bug talk (an ordinary 09-23 fact written by memory/index.js step 3b was).
// This makes them do what they say, and keeps them out of chat by rule rather than by
// the accident of where they sit in the file.
//
// Readers: server/index.js (the Live setup frame drops them; the boot greeting gets
// them as standing instructions) and memory/semantic.js (a recall snippet drops them).
// The vault is only read; nothing here edits a note.
//
// The phrase must name the moment with its preposition — "upon boot", "on startup",
// "at start-up". Checked 2026-09-25 against the operator's 365 facts: exactly the
// three startup notes match. Ordinary facts that merely contain the words stay:
// "wears boots", "reboot the router", "boot camp", "takes a long time to boot",
// "works at a startup". Known edges: a fact like "works at Startup Labs" would be
// read as startup-only, and "each time you start" or "when MYTHOS starts" is not
// matched and stays an ordinary fact (the direction that keeps today's behaviour).
const STARTUP_ONLY_RE = /\b(?:up)?on\s+(?:boot|start-?up)\b|\bat\s+(?:boot|start-?up)\b/i;

function isStartupOnlyFact(text) {
  return typeof text === 'string' && STARTUP_ONLY_RE.test(text);
}

// The startup notes in Semantic/user-facts.md, in file order. `semantic` is the
// memory's semantic store (or anything with its topic()); absent or empty -> [].
function startupOnlyFacts(semantic) {
  const topic = semantic && typeof semantic.topic === 'function' ? semantic.topic('user-facts') : null;
  const facts = topic && Array.isArray(topic.facts) ? topic.facts : [];
  return facts.filter(isStartupOnlyFact);
}

module.exports = { isStartupOnlyFact, startupOnlyFacts, STARTUP_ONLY_RE };
