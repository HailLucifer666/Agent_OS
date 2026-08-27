'use strict';
// claim-check.js — F3: a promised action is either performed or retracted.
//
// Twice in one operator session the model reported work it had not done
// ("I can see some headlines" before the fetch tool even ran; "I've logged
// that" with no log_incident call). This module is the detector half of the
// fix — it is pure and side-effect free; onLiveTurnComplete (live-tool-
// adapter.js) is the only caller, and it is the one that decides what to do
// with a flagged claim (emit health.anomaly). This file never touches the
// bus, never rewrites assistantText, and never suppresses the reply — the
// plan is explicit that the operator-facing reply is not this module's to
// change, only to report on.
//
// SCOPE DECISION — present-tense result claims ("I can see some headlines")
// are NOT covered here. That class needs to know whether a *specific* tool
// call is still in flight vs. already resolved vs. never existed, which is
// exactly the kind of judgment call that produces false positives on ordinary
// perception narration ("I can see the Chrome window is focused" said WHILE
// screen_look is legitimately resolving is not a lie). Only first-person
// completed-aspect claims are matched below — deliberately narrow.
//
// FIRST PERSON IS MANDATORY, NOT OPTIONAL. Every category regex requires an
// explicit "I " / "I've " / "I have " prefix (the reminders category also
// accepts its passive "the reminder has been set" form, which is still a
// claim about MYTHOS's own action). Making that prefix optional looks
// harmless and is not: a past-tense verb then matches anywhere in the reply,
// including sentences about the OPERATOR rather than about MYTHOS. All six of
// these were flagged before the prefix was made mandatory, and every one is a
// false positive:
//   "The meeting is at 3. I found that in your calendar."  (a memory read)
//   "Nothing found."                                       (a report of absence)
//   "That saved me a lot of time."                         (idiom, not an action)
//   "No files were found matching that name."              (passive, about files)
//   "You went to the dentist last Tuesday."                (about the operator)
//   "Your package was sent yesterday."                     (about a package)
// The cost of the mandatory prefix is that a bare elliptical claim ("Sent it.")
// is missed. That is the correct trade for a detector whose output is an
// anomaly an operator has to triage: this module favours misses over false
// positives everywhere, and a noisy honesty alarm is one nobody reads.
//
// UNVERIFIED DECISION — a call that ran but could not be confirmed
// (outcome.unverified) does NOT count as backing a claim. This mirrors the
// Wave 0 evidence contract already enforced throughout live-tool-adapter.js
// (evaluateOutcome: `ok: dispatchOk && !isUnverified`) — actionsThisTurn
// entries already fold `unverified` into `ok`, so this module only needs to
// check `ok === true` and the unverified case falls out for free. Treating
// "ran but unconfirmed" as sufficient backing for a claim of success would
// undermine the exact discipline BUG-068/Wave 0 exist to enforce.

// Claim categories, mapped to the REAL tool names registered in this repo
// (grepped from the effector files, not guessed):
//   logging/noting   -> from-memory.js (log_incident, remember, incident_status),
//                        from-pc.js (write_note)
//   sending          -> from-whatsapp.js (whatsapp_send), from-gmail.js (gmail_send),
//                        from-android.js (phone_sms_send)
//   opening/launching/navigating
//                    -> from-pc.js (launch_app), from-browser.js (browser_navigate),
//                        from-dashboard.js (open_web, navigate)
//   reminders/timers -> from-calendar.js (reminder_add, timer_add)
//   searching/fetching
//                    -> from-code-search.js (search_code), from-computer.js (search_files)
const CLAIM_CATEGORIES = [
  {
    name: 'logging',
    tools: ['log_incident', 'remember', 'incident_status', 'write_note'],
    // Past-tense/perfect forms only — "log"/"logging" (base/continuous) never
    // match here, which is what keeps a future promise out of this regex
    // without needing a separate tense check.
    re: /\b(?:i(?:'ve| have) |i )(logged|noted|wrote down|saved|remembered)\b/i,
  },
  {
    name: 'sending',
    tools: ['whatsapp_send', 'gmail_send', 'phone_sms_send'],
    re: /\b(?:i(?:'ve| have) |i )(sent|texted|emailed|messaged)\b/i,
    // A3 (2026-08-14): the measured false claim was "Message sent to Alex, sir."
    // at 17:29:26, in the same turn as whatsapp_send=FAIL — and the mandatory
    // first-person prefix above missed it, exactly as this file's header predicts
    // ("a bare elliptical claim (\"Sent it.\") is missed"). That trade is still
    // right for the general case, so the prefix is NOT relaxed. This second tier
    // is EVIDENCE-GATED instead: it is only consulted when a tool from this
    // category actually ran and did not succeed within the evidence window
    // (this turn plus the caller-supplied recentActions window — BUG-357). Every
    // false positive the header lists survives that gate — "Your package was
    // sent yesterday" can only be flagged when a send tool was really attempted
    // and really did not succeed nearby, which is a turn where the sentence is a
    // lie regardless of who it is about.
    //
    // BUG-357 — 2026-08-24 20:23:44 UTC, verbatim from the vault episodic log:
    // "Confirmed, Sir. 'Hi' has been sent to mom on WhatsApp." with NO send
    // dispatched behind it (the audit shows every real whatsapp_send that day
    // ending outcome:"fail"). The quoted message CONTENT sat in subject position,
    // outside {message,text,email,mail}, and slipped past. The third alternative
    // accepts any short subject before the PERFECT aspect only ("has been sent")
    // — "was sent" stays excluded, which is what keeps the package sentence out.
    // Negation cannot match because "has been" must be adjacent: "has NOT been
    // sent" has no "has been sent" substring.
    ellipticalRe: /\b(message|text|email|mail)\s+(?:has been\s+|was\s+)?(sent|delivered)\b|\bsent\s+(?:it|that|the message)\b|\b[\w"'\u2018\u2019][\w\s"'\u2018\u2019.,'-]{0,24}\s+has been\s+(?:sent|delivered)\b/i,
  },
  {
    name: 'opening',
    tools: ['launch_app', 'browser_navigate', 'open_web', 'navigate'],
    re: /\b(?:i(?:'ve| have) |i )(opened|launched|navigated(?: to)?|went to)\b/i,
  },
  {
    name: 'reminders',
    tools: ['reminder_add', 'timer_add'],
    // "set" is its own past tense (irregular, unchanged), so it is ambiguous
    // between present and past on its own — require it alongside a perfect
    // marker or "just" to keep this from firing on a plain instruction like
    // "I will set a reminder", and require the reminder/timer noun nearby.
    re: /\b(?:i(?:'ve| have) |i just )(set|scheduled)\b(?:(?!\.).){0,25}\b(reminder|timer|alarm)\b|\b(reminder|timer|alarm) (?:is|has been) set\b/i,
  },
  {
    name: 'searching',
    // F1b (2026-08-15): this list used to hold ONLY the two code-search tools,
    // so "I searched the web for X" after a real, successful web_search was
    // scored as an unbacked claim and MYTHOS was fed a [SYSTEM] CORRECTION
    // telling it to retract a true statement. Twice in one session. A detector
    // that makes the assistant lie in the other direction is worse than no
    // detector, because it also trains the operator to distrust correct answers.
    // Pinned by a derive-from-source test (test/claim-check-categories.test.js)
    // against leash/tiers.js's TIER_TABLE — the same class of bug as the lane
    // names and the vault path: a second, hand-kept copy of something the
    // system already knows.
    tools: ['search_code', 'search_files', 'web_search', 'web_fetch'],
    // "found" is deliberately absent. It is first-person past tense and still
    // not a search-tool claim: "I found that in your calendar" is a memory or
    // calendar read, and "I found three results" after a real search is backed
    // by that search anyway. Keeping it flagged a lookup that legitimately
    // used a different tool, so the verb earns its place only when the ACT of
    // searching is stated.
    re: /\b(?:i(?:'ve| have) |i )(searched|looked up)\b/i,
  },
  // BUG-383 (2026-08-27), Track D-6's `fabrication` item, BUG-275's mechanism.
  //
  // EVERY CATEGORY ABOVE CATCHES A CLAIM ABOUT WHAT MYTHOS DID. This one catches
  // a claim about WHAT IS TRUE IN THE WORLD, which is the other half of the
  // recorded incident and the half nothing was looking at:
  //
  //   "Claimed 'Claude Mythos 5' leads the LiveBench coding board."
  //
  // There is no "I did X" in that sentence, so no amount of tuning the regexes
  // above could ever have reached it. It is an assertion of external fact,
  // volunteered in a turn where the tool that could have established it did not
  // succeed. The second recorded instance was the faked 30-second timer count,
  // and BUG-289 already fixed its parser cause — but the model reaching for a
  // fact it did not have is the pattern, not the parser.
  //
  // EVIDENCE-GATED, HARD. `re` is null on purpose: this category has ONLY the
  // gated tier, so it can fire only when a fact-finding tool was actually
  // attempted this window and did not succeed. Without that gate a pattern this
  // broad would flag ordinary conversation — "the meeting is at four" — every
  // turn. With it, the state is rare: the model tried to look something up, the
  // lookup did not come back, and it then stated the answer anyway.
  //
  // SCOPE, HONESTLY: this REDUCES fabrication, it does not eliminate it. A
  // fabricated fact phrased as plain narration with no ranking, quantity or
  // citation shape will pass, and a turn where no fact-finding tool was
  // attempted at all is invisible to it by construction. The measured catch rate
  // is recorded in the BUG-383 entry rather than implied here.
  {
    name: 'external-fact',
    // `tools` IS EMPTY ON PURPOSE, and `gateTools` carries the list instead.
    //
    // test/claim-check-categories.test.js enforces that no tool is claimed by two
    // categories, and that invariant is correct: it keeps ownership unambiguous
    // for the categories that flag an ACTION, so exactly one category can say
    // "this tool should have backed that claim". This category is cross-cutting —
    // it watches the same fact-finding tools `searching` owns, for a completely
    // different claim — so it declares them separately. The invariant is
    // preserved rather than weakened to accommodate a new case.
    tools: [],
    // The tools whose FAILURE leaves the model without an answer it has just
    // told the operator it had. Used for the evidence gate, for the backed
    // check, and for candidateTools.
    gateTools: [
      'web_search', 'web_fetch', 'get_weather', 'get_directions',
      'screen_look', 'screen_read_text', 'camera_look',
      'document_search', 'document_answer', 'search_code', 'search_files',
      'media_status', 'spotify_status', 'browser_snapshot',
    ],
    re: null,
    // Assertion SHAPES, not topics. Each alternative is a way of stating a fact
    // as settled: a ranking or superlative, a citation, a bare quantity with a
    // unit, or a definite "X is Y" about a named thing. Deliberately requires a
    // shape — plain narration is not matched, which is exactly the honest limit
    // recorded above.
    ellipticalRe: new RegExp([
      // ranking / superlative: "leads the board", "is the fastest", "tops the"
      '\\b(?:leads|tops|ranks|beats|outperforms|is\\s+(?:the\\s+)?(?:best|fastest|top|leading|highest|number\\s*one))\\b',
      // citation of an external source as settled fact
      '\\baccording to\\b|\\bper\\s+(?:the\\s+)?(?:latest|current|official)\\b',
      // a bare quantity with a unit, stated as current fact
      '\\b(?:is|are|was|sits\\s+at|stands\\s+at)\\s+(?:currently\\s+)?[-+]?\\d[\\d,.]*\\s*(?:%|percent|degrees|c\\b|f\\b|km|miles|mph|kph|dollars|usd|inr)',
      // "the current/latest X is Y"
      '\\bthe\\s+(?:current|latest|most\\s+recent)\\s+\\w+\\s+is\\b',
    ].join('|'), 'i'),
  },
];

// Future/intent markers. Belt-and-suspenders alongside the past-tense-only
// regexes above — a sentence carrying one of these is a promise, not a
// completed-aspect claim, and must never be flagged.
const FUTURE_RE = /\b(i'll|i will|i'm going to|im going to|going to|about to|let me|i'm about to|gonna|i plan to|i intend to)\b/i;

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pure, exported, separately testable. Returns [] when nothing is flagged.
// Each entry: { category, phrase, sentence, candidateTools }.
//
// BUG-357: recentActions extends the evidence window beyond the current turn.
// The 2026-08-24 session produced "Message sent to mom" in a turn whose only
// whatsapp_send rows (a pending confirm, then a voice-cancel) belonged to
// EARLIER turns — with a this-turn-only window the elliptical gate found no
// attempted-unproven send and stayed shut for both false claims. Recent actions
// join BOTH sets, so they back real successes as well as exposing failures; a
// genuine ok:true send still silences a later "it was sent" reference. Entries
// carry their own `status` when the caller precomputed one (live-tool-adapter's
// ledger does); anything without one is derived here from ok/unverified, same
// as actionStatus() would.
function detectUnbackedClaims(assistantText, actionsThisTurn, recentActions) {
  const text = String(assistantText || '');
  if (!text) return [];

  const current = Array.isArray(actionsThisTurn) ? actionsThisTurn : [];
  const recent = Array.isArray(recentActions) ? recentActions : [];
  const actions = current.concat(recent);
  const successfulTools = new Set(
    actions.filter((a) => a && a.ok === true).map((a) => a.tool),
  );
  // A3: tools from this category that WERE attempted this turn and did not
  // succeed (failed, pending, unverified). This is the gate on the elliptical
  // tier — see the sending category's comment. `ok !== true` is the same test
  // used everywhere else in this file, so a pending ack (ok:null) counts as
  // "attempted and unproven", which is the case that produced the incident.
  const attemptedUnproven = new Set(
    actions.filter((a) => a && a.tool && a.ok !== true).map((a) => a.tool),
  );

  const claims = [];
  const flaggedCategories = new Set();
  for (const sentence of splitSentences(text)) {
    if (FUTURE_RE.test(sentence)) continue;
    for (const category of CLAIM_CATEGORIES) {
      if (flaggedCategories.has(category.name)) continue; // one flag per category per reply
      // BUG-383: `re` may be null. The external-fact category has ONLY the
      // evidence-gated tier, because an ungated pattern that broad would flag
      // ordinary conversation every turn. A null `re` therefore means "never
      // fires unless a tool from this category was attempted and did not
      // succeed", which is the whole safety property of that category.
      // A cross-cutting category declares its tools under `gateTools` so the
      // one-tool-one-category invariant stays true (see external-fact's note).
      // Everything downstream — the gate, the backed check, candidateTools —
      // reads this one resolved list.
      const gate = (category.gateTools && category.gateTools.length)
        ? category.gateTools : category.tools;
      let match = category.re ? category.re.exec(sentence) : null;
      if (!match && category.ellipticalRe
          && gate.some((tool) => attemptedUnproven.has(tool))) {
        match = category.ellipticalRe.exec(sentence);
      }
      if (!match) continue;
      // A fact-finding tool that SUCCEEDED backs the claim. This is what stops
      // the detector telling the assistant to retract a statement it had just
      // earned — the F1b lesson recorded in the searching category above.
      const backed = gate.some((tool) => successfulTools.has(tool));
      if (backed) continue;
      flaggedCategories.add(category.name);
      claims.push({
        category: category.name,
        phrase: match[0],
        sentence,
        candidateTools: gate.slice(),
      });
    }
  }
  return claims;
}

// BUG-357 — the affirmative twin of the spoken-no cancellation. "Yeah. Yeah. Go
// ahead." arrived over two pending whatsapp_send confirms, nothing dispatched,
// and NOTHING told the model so — it filled the silence with "'Hi' has been
// sent". This is the matcher and the honest notice for that state.
//
// Q8 — WHY NOT voice-agent.js's AFFIRMATIVE_RE: that matcher is fully anchored
// (^…$) because the batch path uses it as a whole-utterance verdict, and it
// matches none of that session's real shapes ("Yeah. Yeah. Go ahead.", "da app
// is open go ahead send hi to mom", "I already clicked on approve"). This is a
// different question — "does this utterance READ as approval" — so a different,
// deliberately loose matcher is correct here, not drift of the old one. The cost
// asymmetry runs the same way as NEGATIVE_RE's: an over-fire is one honest
// notice naming what still awaits approval (recoverable), whereas a missed
// go-ahead is another fabricated completion spoken into the gap. Noise bound:
// the caller fires this only while confirms are actually pending, and confirms
// are rare and TTL-bounded — it cannot fire on ordinary conversation.
const SPOKEN_GO_AHEAD_RE =
  /\b(?:ok(?:ay)?|yes|yeah|yep|yup|sure|go ahead|go on|do it|send it|approved?|approval|confirm(?:ed)?|please do|i did|already (?:clicked|gave|approved)|affirmative)\b/i;

// Pure: returns { tool, verdict, instruction } or null. The adapter supplies the
// raw utterance, its NEGATIVE_RE decision, and the pending tool names; matcher
// and wording both live HERE so they cannot drift apart from the rest of the
// claim vocabulary.
function buildSpokenGoAheadNotice(utterance, pendingToolNames, opts) {
  const o = opts || {};
  const t = String(utterance || '');
  const names = [...new Set(Array.isArray(pendingToolNames) ? pendingToolNames : [])];
  if (!names.length || o.negative === true) return null;
  if (!t.trim() || !SPOKEN_GO_AHEAD_RE.test(t)) return null;
  return {
    tool: names.join(', '),
    verdict: 'Your spoken go-ahead did NOT dispatch anything. Still awaiting explicit operator approval: '
      + names.join(', ') + '.',
    instruction: 'Do NOT tell the operator anything has been sent, executed or confirmed. Say plainly '
      + `that ${names.length === 1 ? 'that action' : 'those actions'} ${names.length === 1 ? 'is' : 'are'} waiting for approval.`,
  };
}

module.exports = { detectUnbackedClaims, CLAIM_CATEGORIES, buildSpokenGoAheadNotice };
