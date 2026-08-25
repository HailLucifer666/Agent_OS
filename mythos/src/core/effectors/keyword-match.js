'use strict';

// effectors/keyword-match.js — BUG-309/BUG-312: one word-boundary keyword
// matcher for every keyword table in this repo.
//
// THE BUG IT EXISTS FOR. risk-classifier.js and design/verify.js both decided
// "does the spec mention X" with String.indexOf / String.includes. On
// 2026-08-22 an AI-news-digest build wrote itself a spec containing "base 16px
// typography using Geist font pairing". 'typo' is a tiny-fix keyword.
// "typography" contains it. The build was gated as a typo fix: no research, no
// reviewer, no visual gate, and the resolved design system discarded. One
// substring collapsed the whole gate.
//
// WHY A SHARED MODULE AND NOT TWO PATCHES. The same invariant was broken in two
// files and sixteen call sites, which is the point at which patching instances
// stops being the right move. This is deliberately tiny and dependency-free —
// the same shape as completion-status.js, and for the same reason: both the
// classifier and the verifier must ask the question identically or they will
// drift.
//
// WHY NOT A PLAIN \bWORD\b. Because that breaks the ordinary case. 'add' would
// stop matching "adding", 'update' would stop matching "updated", 'rename'
// would stop matching "renamed" — every one of which is how an operator
// actually phrases a request. A guard that reclassifies ordinary work is worse
// than the bug it replaces. So this matches a stem plus a closed set of
// inflectional endings, anchored at a word boundary on the left and a word
// boundary after the ending.
//
// THE E-DROP IS LOAD-BEARING, AND IT FOUND A SECOND BUG. Writing the test for
// this revealed that HEAD's 'migrate' keyword never matched "migrating" or
// "migration" at all — there is no 'e' in either — so architecture-change
// silently missed its own most common phrasing. indexOf was simultaneously too
// loose (typography) and too tight (migrating). Stemming fixes both directions.
//
// WHAT THIS IS NOT. Not a stemmer, not morphology, not a classifier. It is a
// closed list of English endings chosen against the actual keyword tables in
// this repo, and every entry earns its place by a keyword that needs it:
//   ure/ures/ural  <- 'architect' must match "architecture"
//   ement/ements   <- 'improve' must match "improvements"
//   ion/ions       <- 'migrate' must match "migration"
//   ing            <- 'add' must match "adding", 'refactor' "refactoring"
// Adding an ending here widens every table at once. Check what else it lets in
// before you add one: 'ure' was checked against 'fix' ("fixture") and is safe
// only because no bare 'fix' keyword exists.

// Longest-first matters: 'ements' must be tried before 'ement' before 'es',
// otherwise the shorter alternative wins and the \b after it fails.
var ENDINGS = [
  'ements', 'ement', 'ations', 'ation', 'ions', 'ion', 'ings', 'ing',
  'ments', 'ment', 'ures', 'ural', 'ure', 'ally', 'ers', 'er',
  'ies', 'es', 'ed', 's', 'd', 'al', 'ly',
];

// Words that negate the keyword immediately following them. Deliberately short:
// a wide list turns this into a sentiment classifier, and the failure mode of a
// false negation is a requirement silently dropped.
var NEGATORS = [
  'no', 'not', 'never', 'without', 'avoid', 'avoiding', 'exclude', 'excluding',
  'skip', 'omit', 'anti', 'non', 'isnt', 'arent', 'dont', 'wont',
];

// How many tokens before the match are inspected for a negator. Two, because
// "not dark" and "no heavy neon" both need to be caught and "dark theme, not
// light" must NOT be — in that one 'dark' has no negator before it at all.
var NEGATION_WINDOW_TOKENS = 2;

var ENDING_GROUP = '(?:' + ENDINGS.join('|') + ')?';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds the alternation for the final word of a keyword: the word as written,
// plus (when it ends in 'e') the e-dropped stem, each allowed one ending.
function finalWordPattern(word) {
  var base = escapeRegex(word);
  var alts = [base + ENDING_GROUP];
  if (/[a-z]e$/i.test(word)) {
    // migrate -> migrat(e|ed|ing|ion|...)   improve -> improv(ements|...)
    alts.unshift(escapeRegex(word.slice(0, -1)) + ENDING_GROUP);
  }
  return '(?:' + alts.join('|') + ')';
}

var cache = new Map();

function patternFor(keyword) {
  if (cache.has(keyword)) return cache.get(keyword);
  var words = String(keyword).trim().split(/\s+/).filter(Boolean);
  var re = null;
  if (words.length) {
    var head = words.slice(0, -1).map(escapeRegex);
    var tail = finalWordPattern(words[words.length - 1]);
    // \s+ between words so "fix   spelling" and a line break both match.
    var body = head.length ? head.join('\\s+') + '\\s+' + tail : tail;
    re = new RegExp('\\b' + body + '\\b', 'i');
  }
  cache.set(keyword, re);
  return re;
}

// True when `text` mentions `keyword` as a word (or an inflected form of it),
// rather than as a fragment inside a longer word.
//
// opts.negationAware — when set, an occurrence directly preceded by a negator
// ("light theme, not dark") does NOT count as a mention. Off by default: the
// risk classifier wants to know whether a topic is present at all, while the
// design verifier is deciding whether to REQUIRE something, and requiring what
// the spec explicitly ruled out is the bug.
function matchesKeyword(text, keyword, opts) {
  var s = String(text == null ? '' : text);
  if (!s || !keyword) return false;
  var re = patternFor(keyword);
  if (!re) return false;
  if (!(opts && opts.negationAware)) return re.test(s);

  // Negation-aware path: find each occurrence and look at what precedes it.
  var scan = new RegExp(re.source, 'gi');
  var m;
  while ((m = scan.exec(s)) !== null) {
    if (!isNegated(s, m.index)) return true;
    if (scan.lastIndex === m.index) scan.lastIndex += 1; // zero-width guard
  }
  return false;
}

function isNegated(text, matchIndex) {
  var before = text.slice(0, matchIndex);
  // Strip punctuation to tokens; keep only the last few.
  var tokens = before.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').trim().split(/\s+/);
  var window = tokens.slice(-NEGATION_WINDOW_TOKENS);
  for (var i = 0; i < window.length; i++) {
    if (NEGATORS.indexOf(window[i]) !== -1) return true;
  }
  return false;
}

// Convenience for the tables: returns the first keyword in `keywords` that
// `text` mentions, or null. Keeps the call sites as short as the indexOf loops
// they replace.
function firstMatch(text, keywords, opts) {
  for (var i = 0; i < keywords.length; i++) {
    if (matchesKeyword(text, keywords[i], opts)) return keywords[i];
  }
  return null;
}

// True when `text` mentions ANY of `keywords`.
function matchesAny(text, keywords, opts) {
  return firstMatch(text, keywords, opts) !== null;
}

module.exports = {
  matchesKeyword: matchesKeyword,
  matchesAny: matchesAny,
  firstMatch: firstMatch,
  _ENDINGS: ENDINGS,
  _NEGATORS: NEGATORS,
  _patternFor: patternFor,
};
