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
// OPERATOR DECISION 2026-10-06: habits stay ON ("this will be your PA": learn
// likes, dislikes, taste and repetitive work), but only behaviour that is really
// repeated. THE RULE: at least PROMOTE_AFTER (3) successful actions on the same
// subject, falling on at least MIN_HABIT_DAYS (2) different LOCAL days
// (util/day-key.js, the vault's one date basis), all within HABIT_WINDOW_DAYS.
// WHY a second day: three plays in one sitting are a session, not a taste. The
// "listens to lofi" fact came from lofi played while TESTING "play the second /
// third video" — three plays, one sitting. Raised from the existing threshold,
// not beside it: the count still applies (two plays on two days stay coincidence).
// WHY 7 days: Episodic recall's own default window, which is where the days are
// read from (below) — so a habit is "repeated this week", and the old comment's
// worry (two plays weeks apart are not a habit) still holds.
const MIN_HABIT_DAYS = 2;
const HABIT_WINDOW_DAYS = 7;
const { dayKey } = require('../util/day-key');

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
// The subject of a past play, read back from its Episodic summary, which
// dispatch-action.js writes as `tool(<args JSON cut at 80 chars>)`. A value cut
// mid-string does not match and is not counted: it can only undercount a habit,
// never invent one. Attacked 2026-10-06: another tool whose name ends the same
// ("xspotify_play(") does not start with `tool + '('`; an arg named like ours
// inside another value ("{\"q\":\"\\\"query\\\":...") needs a raw `"query":"`,
// which JSON escaping inside a string value never produces.
function subjectFromSummary(tool, summary) {
  const s = String(summary || '');
  if (!WATCHED[tool] || s.indexOf(tool + '(') !== 0) return null;
  const arg = WATCHED[tool].arg;
  const m = new RegExp('[{,]"' + arg + '":("(?:[^"\\\\]|\\\\.)*")').exec(s);
  if (!m) return null;
  try { return subjectOf(tool, { [arg]: JSON.parse(m[1]) }); } catch (_) { return null; }
}

function keyFor(tool, subject) {
  return tool + '\u0000' + subject;
}

function createHabitPromoter(deps) {
  const semantic = deps && deps.semantic;
  // Not behind MEMORY_AUTO_USER_FACTS (operator decision 2026-10-06): see the
  // rule above PROMOTE_AFTER. `now`, `minDays` and `promoteAfter` are for tests.
  const logger = (deps && deps.logger) || { info: function() {} };
  const promoteAfter = (deps && deps.promoteAfter) || PROMOTE_AFTER;
  const minDays = (deps && deps.minDays) || MIN_HABIT_DAYS;
  const now = (deps && deps.now) || Date.now;
  // The days must survive a restart, or "two different days" needs a process
  // that stays up past midnight and the rule would never fire. Episodic already
  // records every dispatched action (dispatch-action.js step 3, BEFORE it calls
  // observe in 4.5), so the plays are read from there: no new store, no second
  // copy of the operator's behaviour. Without an Episodic store (unit tests,
  // hub-less callers) the same rule runs on an in-process record of days.
  const episodic = deps && deps.episodic;
  const daysSeen = new Map(); // key -> [dayKey, ...] one entry per play (in-process fallback only)
  const promoted = new Set();

  function playDays(tool, subject, key) {
    if (episodic && typeof episodic.recall === 'function') {
      const since = now() - HABIT_WINDOW_DAYS * 24 * 3600 * 1000;
      const hits = episodic.recall('', { kind: 'action', limit: 1000, windowDays: HABIT_WINDOW_DAYS }) || [];
      return hits.map(function(h) { return (h && h.record) || h; })
        // An unverified play is stored as outcome 'ok' with detail.unverified (2026-10-07):
        // it might not have happened, so it is no evidence of a habit (see dispatch-action).
        .filter(function(r) { return r && r.outcome === 'ok' && !(r.detail && r.detail.unverified) && (r.ts || 0) >= since && subjectFromSummary(tool, r.summary) === subject; })
        .map(function(r) { return dayKey(r.ts); });
    }
    const days = (daysSeen.get(key) || []).concat(dayKey(now()));
    daysSeen.set(key, days);
    return days;
  }

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

      const days = playDays(tool, subject, key);
      const next = days.length;
      if (next < promoteAfter || new Set(days).size < minDays) return null;

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
  MIN_HABIT_DAYS: MIN_HABIT_DAYS,
  HABIT_WINDOW_DAYS: HABIT_WINDOW_DAYS,
  subjectFromSummary: subjectFromSummary,
  subjectOf: subjectOf,
  keyFor: keyFor,
};
