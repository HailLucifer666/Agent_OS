'use strict';

// memory/habit-promoter.js — turn repeated ACTIONS into durable facts.
//
// F9 (2026-08-15). The operator's complaint was "MYTHOS did not remember
// previously requested songs". What the vault shows:
//   - "Radiohead" appears 18x in Episodic and 0x in Semantic.
//   - It was played three times (21:43, 21:44, 22:05) and never became a fact.
//   - The complaint landed at 22:15:36; the music-taste facts were written
//     22:16-22:24, i.e. AFTER it, by the model reacting to being told off.
//   - Those writes then fragmented into eight append-only bullets ("also
//     likes: X", "additions: Y") with one artist recorded twice.
//
// The gap is structural, not a tuning problem. Everything that reaches Semantic
// gets there because the MODEL chose to call `remember`. Playing a track three
// times is not a memory event to any part of the system, so behaviour — the most
// reliable signal there is about what someone likes — produced nothing.
//
// So: count what actually happens, and promote at a threshold. This is
// deliberately NOT a brain call. A count of real dispatches is evidence; asking a
// model to infer preferences from a transcript is how the eight fragmented
// bullets happened.
//
// SCOPE IS NARROW ON PURPOSE. Only tools whose repetition genuinely means a
// preference are watched, and only the argument that identifies the SUBJECT is
// counted. Widening this to every tool would promote "the operator likes
// screen_look", which is noise that costs recall quality for every real fact.

// tool -> the argument that names the thing being chosen, and how a promoted
// fact reads. Adding an entry here is a deliberate act: it must be a tool where
// doing the same thing repeatedly says something durable about the operator.
// Every key here is a real tool name and every `arg` a real parameter of it —
// pinned by a derive-from-source test against TIER_TABLE and the tool catalog,
// because a watch list that names a tool nobody has ever called is a feature
// that silently does nothing. (`play_music`/`play_song` were in the first draft
// of this list and do not exist; the test is what said so.)
const WATCHED = {
  spotify_play: { arg: 'query', fact: function(v) { return 'Listens to ' + v + ' (played repeatedly).'; } },
  launch_app: { arg: 'name', fact: function(v) { return 'Regularly uses the app ' + v + '.'; } },
  whatsapp_send: { arg: 'to', fact: function(v) { return 'Frequently messages ' + v + ' on WhatsApp.'; } },
};

// Three is the number the incident itself supplies: the operator expected MYTHOS
// to have noticed after the third play. Two is coincidence; three is a habit.
const PROMOTE_AFTER = 3;

// Counting normalized text, not raw args: "radiohead", "Radiohead" and
// "  Radiohead " are one preference, and treating them as three is how a
// threshold silently never fires.
function normalize(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// A query that is really an instruction ("play something", "next", "shuffle")
// names no subject and must never become a fact about taste.
const NOT_A_SUBJECT = /^(next|previous|skip|pause|resume|stop|play|shuffle|something|anything|music|a song|some music)$/;

function subjectOf(tool, params) {
  const spec = WATCHED[tool];
  if (!spec) return null;
  const raw = params && params[spec.arg];
  const value = normalize(raw);
  if (!value || value.length < 2 || value.length > 80) return null;
  if (NOT_A_SUBJECT.test(value)) return null;
  return value;
}

// The counter below is keyed on the (tool, subject) PAIR, joined by a NUL: a NUL
// occurs in neither half, so no two pairs can ever produce the same key.
//
// The separator is written as the \u0000 ESCAPE and must never be typed as a raw
// 0x00 byte. A literal NUL anywhere in this file makes git classify the whole file
// as BINARY: `git diff` then reports only "Binary files differ", so the file cannot
// be code-reviewed in a PR, and every line-based tool over it -- grep included --
// goes silently blind. Pinned from both sides: source-has-no-nul-byte.test.js fails
// on the raw byte, habit-promotion.test.js fails if this stops being a NUL.
function keyFor(tool, subject) {
  return tool + '\u0000' + subject;
}

function createHabitPromoter(deps) {
  const semantic = deps && deps.semantic;
  const logger = (deps && deps.logger) || { info: function() {} };
  const promoteAfter = (deps && deps.promoteAfter) || PROMOTE_AFTER;

  // In-process only, and deliberately so. Persisting the counter would make a
  // fact promotable across a restart weeks apart, which is not a habit; and the
  // already-promoted set below is what stops a long session re-writing the same
  // fact every time the count ticks up.
  const counts = new Map();
  const promoted = new Set();

  // Called after a dispatch that actually succeeded. Never throws — this is
  // best-effort bookkeeping sitting on the action path, exactly like
  // skills.recordUse beside it, and a memory failure must not fail an action.
  function observe(tool, params, ok) {
    try {
      if (!ok || !semantic || typeof semantic.write !== 'function') return null;
      const subject = subjectOf(tool, params);
      if (!subject) return null;

      const key = keyFor(tool, subject);
      if (promoted.has(key)) return null;

      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      if (next < promoteAfter) return null;

      const fact = WATCHED[tool].fact(subject);
      // One topic per (tool, subject), NOT an append to a shared topic. The
      // eight fragmented "also likes:" bullets in the 2026-08-14 vault are what
      // appending produces; a stable topic id lets a re-observation update the
      // same entry instead of stacking another line.
      const topic = 'habit-' + tool + '-' + subject.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const saved = semantic.write(topic, [fact], {
        // Observed behaviour, not a stated preference. Below the 0.8 a direct
        // "remember that I like X" earns, above an inference from prose.
        confidence: 0.7,
        sources: ['habit-promoter:' + tool + ':' + next + 'x'],
      });
      // BUG-249: mark promotion only after durable persistence. semantic.write
      // reports a filesystem failure as {ref:null, degraded:true}; it does not
      // normally throw. Marking first silenced every retry for this session,
      // and ignoring its result announced a fact that was never stored.
      // Keep the count so the next successful action can retry the same topic.
      if (!saved || saved.degraded === true || typeof saved.ref !== 'string' || !saved.ref.trim()) return null;
      promoted.add(key);
      logger.info('memory.habit-promoted', { tool: tool, subject: subject, count: next });
      return { topic: topic, fact: fact, count: next };
    } catch (_) {
      return null;   // never let memory bookkeeping break an action
    }
  }

  return { observe: observe, WATCHED: WATCHED };
}

module.exports = {
  createHabitPromoter: createHabitPromoter,
  WATCHED: WATCHED,
  PROMOTE_AFTER: PROMOTE_AFTER,
  subjectOf: subjectOf,
  keyFor: keyFor,
};
