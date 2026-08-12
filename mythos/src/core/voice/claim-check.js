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
    tools: ['search_code', 'search_files'],
    // "found" is deliberately absent. It is first-person past tense and still
    // not a search-tool claim: "I found that in your calendar" is a memory or
    // calendar read, and "I found three results" after a real search is backed
    // by that search anyway. Keeping it flagged a lookup that legitimately
    // used a different tool, so the verb earns its place only when the ACT of
    // searching is stated.
    re: /\b(?:i(?:'ve| have) |i )(searched|looked up)\b/i,
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
function detectUnbackedClaims(assistantText, actionsThisTurn) {
  const text = String(assistantText || '');
  if (!text) return [];

  const successfulTools = new Set(
    (Array.isArray(actionsThisTurn) ? actionsThisTurn : [])
      .filter((a) => a && a.ok === true)
      .map((a) => a.tool),
  );

  const claims = [];
  const flaggedCategories = new Set();
  for (const sentence of splitSentences(text)) {
    if (FUTURE_RE.test(sentence)) continue;
    for (const category of CLAIM_CATEGORIES) {
      if (flaggedCategories.has(category.name)) continue; // one flag per category per reply
      const match = category.re.exec(sentence);
      if (!match) continue;
      const backed = category.tools.some((tool) => successfulTools.has(tool));
      if (backed) continue;
      flaggedCategories.add(category.name);
      claims.push({
        category: category.name,
        phrase: match[0],
        sentence,
        candidateTools: category.tools.slice(),
      });
    }
  }
  return claims;
}

module.exports = { detectUnbackedClaims, CLAIM_CATEGORIES };
