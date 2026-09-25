'use strict';

// unsearched-current-fact.js — BUG-275's new shape: a fact that can change,
// stated as current, with no web lookup behind it.
//
// THE INCIDENT, 2026-09-23 14:08:59 (attended run). Asked "What do you think
// about the Nothing Phone (4a) Pro?", MYTHOS answered from the model's memory —
// "there hasn't been an official announcement for a Nothing Phone (4a) Pro yet —
// they're on the Phone (2a) right now" — without calling web_search. That was at
// least a generation out of date. Challenged, it searched and was grounded. The
// operator gave the rule in their own words: search when a fact could have
// changed — products, releases, news, prices — and not for stable knowledge,
// because searching everything costs tokens.
//
// THE REPLAY THAT DECIDED THE SHAPE (the plan made it a precondition). Run over
// two whole vault days, 2026-08-19 (BUG-275's own evidence session, 606 reply
// sentences) and 2026-09-23 (167), with every hit read by hand — reproducible
// with `node scripts/replay-ranked-detectors.js <day> --verbose`:
//   * First draft: 13 hits. It MISSED the 09-23 incident, because an unrelated
//     screen_read_text sat in the evidence window and counted as "looked it up".
//     Reading the hits also showed questions ("Should I pull up the latest
//     build?") and promises ("Checking latest headlines now") matching.
//   * Shipped rule: only a WEB lookup counts (WEB_LOOKUP_TOOLS); questions and
//     "checking … now" promises are not assertions. 10 shape matches; 7 had a
//     web lookup behind them and stay silent; 3 had none, and of those 2 are
//     real — the 09-23 incident, and 08-19 08:35 "Latest version is ChatGLM 5.2"
//     while the operator was saying 5.3 had shipped — and 1 is a false positive
//     about MYTHOS's own browser launch ("chrome was launched"). Test (f) pins
//     that false positive as a known, accepted one rather than fitting it away.
//
// WHY SILENT, NOT A SPOKEN CORRECTION. Same decision as BUG-275 H1
// (promoted-rank-anomaly.js): this judges the CONTENT of prose, can be wrong in
// a way a tool outcome cannot, and a false positive spoken aloud would make
// MYTHOS retract a true statement — the one error claim-check.js forbids. At two
// real hits in 773 sentences it is telemetry for the next attended run. Making
// the model search before it answers is the prevention half, and that needs the
// validated text lane (plan decision D7, deferred), so BUG-275 stays open.
//
// NOT COVERED. A stale fact phrased without one of these shapes passes, and so
// does one stated in a turn where some web lookup ran for something else — the
// 08-19 "Based on my memory, … costs eighty dollars per month" had a search in
// its window. Favour misses: this is a detector whose output someone has to read.

const { splitSentences, FUTURE_RE } = require('./claim-check');

// Lookups that return current web content. screen_read_text, think_deeply,
// open_web (opens a page the model cannot read) and read_status do not.
const WEB_LOOKUP_TOOLS = ['web_search', 'web_fetch', 'browser_get_text', 'browser_snapshot'];

// Assertion shapes about something that can change: release state, price,
// "latest/current" product or news, "they're on version N". Shapes, not topics.
const CURRENT_FACT_RE = new RegExp([
  "\\b(?:hasn'?t|has not|haven'?t|have not)\\s+(?:been\\s+)?(?:announced|released|launched|confirmed|unveiled)\\b",
  '\\b(?:is|are|was|were)\\s+(?:now\\s+|currently\\s+)?(?:available|out|on sale|launched|released|announced)\\b',
  '\\b(?:just|recently)\\s+(?:launched|released|announced|unveiled|dropped)\\b',
  '\\b(?:the\\s+)?(?:latest|newest|most recent|current)\\s+(?:model|version|release|phone|update|price|news|headline)s?\\b',
  '\\b(?:costs?|priced at|retails? (?:for|at)|price (?:is|starts at|of))\\b',
  "\\b(?:they'?re|it'?s|we'?re)\\s+(?:on|at)\\s+(?:the\\s+)?(?:phone|version|model|gen(?:eration)?)\\b",
].join('|'), 'i');
const QUESTION_RE = /\?\s*$/;
const PROMISE_RE = /\b(?:checking|looking|searching|pulling)\b[^.]{0,60}\bnow\b|\bi'?m\s+(?:checking|looking|searching|pulling)\b/i;
// The sentence kept on the anomaly row.
const CLAIM_CHARS = 240;

// One row per reply: the first sentence with the shape, when no web lookup is in
// the evidence window (this turn plus the recent-action ledger). An ATTEMPTED
// lookup that failed also counts as looked: a fact stated over a failed search
// is claim-check's external-fact category, not this one.
function detectUnsearchedCurrentFacts(assistantText, actionsThisTurn, recentActions) {
  const text = String(assistantText || '');
  if (!text) return [];
  const actions = [].concat(Array.isArray(actionsThisTurn) ? actionsThisTurn : [], Array.isArray(recentActions) ? recentActions : []);
  if (actions.some((a) => a && WEB_LOOKUP_TOOLS.includes(a.tool))) return [];
  for (const sentence of splitSentences(text)) {
    if (FUTURE_RE.test(sentence) || QUESTION_RE.test(sentence) || PROMISE_RE.test(sentence)) continue;
    const m = CURRENT_FACT_RE.exec(sentence);
    if (!m) continue;
    return [{
      sentence: sentence.slice(0, CLAIM_CHARS), phrase: m[0],
      sawTools: [...new Set(actions.filter((a) => a && a.tool).map((a) => a.tool))],
    }];
  }
  return [];
}

function reasonFor(hit) {
  return 'the reply stated something that can change ("' + hit.phrase + '") as current fact, and no web lookup ran in its evidence window';
}

// `reason` is mandatory: immune/explainer.js narrates an unplaybooked anomaly from
// `target` + `reason`. The healer acknowledges this kind (known-conditions.js).
function reportUnsearchedCurrentFacts({ bus, assistantText, actionsThisTurn, recentActions }) {
  if (!bus || typeof bus.emit !== 'function') return 0;
  const hits = detectUnsearchedCurrentFacts(assistantText, actionsThisTurn, recentActions);
  for (const hit of hits) {
    bus.emit('health.anomaly', {
      kind: 'unsearched-current-fact', tool: 'unsearched-current-fact', target: 'unsearched-current-fact',
      claim: hit.sentence, phrase: hit.phrase, sawTools: hit.sawTools, reason: reasonFor(hit),
    });
  }
  return hits.length;
}

module.exports = { detectUnsearchedCurrentFacts, reportUnsearchedCurrentFacts, reasonFor, WEB_LOOKUP_TOOLS, CLAIM_CHARS };
