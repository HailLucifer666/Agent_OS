'use strict';

// authority-words.js — how the "ask first" rules compare two pieces of text:
// what MYTHOS would save or type against what the operator said, and what MYTHOS
// read back against what it proposes. (S1, 2026-09-25, audit F03 and F05 in
// mythos/docs/PLAN-AUDIT-2026-09-25.md.) Pure, and kept apart from
// operator-authority.js so each comparison is a table test on its own.
//
// WHY IT IS STRICT. The comparison this replaces (speechCovers) passed at 60%
// overlap of English words four letters or longer. Reproduced against main
// f456217d: it read "I will not remember your favorite color is blue" as a
// read-back of "Your favorite color is blue". It could not see "red" at all
// (three letters), nor any Bengali or Hindi word (the pattern was [a-z]). And
// judgeMemoryWrite had no content check whatsoever, so "Remember my favorite
// color is blue" authorised saving "My favorite color is green".
// Here every content word, every number and the presence of a negation must
// agree. A mismatch never refuses anything: it becomes a read-back question.
//
// NOT A MEANING CHECK. Stemming is a crude English suffix strip, so "prefer" and
// "like" are different words and a paraphrase asks. That is the contract (rev 8
// S1): exact extraction proceeds, anything else is read back and confirmed.

// Negations are compared as a presence, not as words: "don't", "doesn't" and
// "never" all make a sentence negative, and one being dropped or added flips it.
const NEGATION = new Set(['not', 'no', 'never', 'nothing', 'none', 'nobody', 'neither', 'nor']);
// Words that carry no fact of their own. Who the fact is about is the one thing
// the model always rewrites ("my" becomes "the operator's", "I" becomes "User"),
// so pronouns and those labels are ignored on both sides, along with articles
// and the verbs "be", "do" and "have".
const FILLER = new Set(('a an the of to and is are was were be been am being it its this that these those '
  + 'i me my mine myself you your yours he him his she her hers they them their theirs we us our ours '
  + 'user users operator operators sir mythos do does did has have had').split(' '));
const ASCII_WORD = /^[a-z]+$/;
const NUMBER = /^\p{N}+$/u;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// The model routinely appends today's date to a saved fact (the 09-24 14:53:37
// save ended "Current date: September 24, 2026."). The digits are already
// allowed by unsupportedNumbers(); this lets the label go with them.
const DATE_SUFFIX_RE = /\bcurrent date:?[^.;\n]*/gi;

// Unicode letters, marks and digits, so a Bengali or Devanagari word is a word.
// Contractions are expanded first, so "doesn't" carries its "not".
function tokens(text) {
  const s = String(text || '').normalize('NFC').toLowerCase().replace(/[’‘ʼ]/g, "'")
    .replace(/\b(?:can't|cannot)\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
    .replace(/'s\b/g, '').replace(/'/g, '');
  return s.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

// A suffix strip that never leaves fewer than two letters: "owe" and "owes" both
// become "ow", while "red" and "ring" stay whole instead of both becoming "r".
function stem(word) {
  if (!ASCII_WORD.test(word) || word.length < 3) return word;
  const s = word.replace(/(?:ing|ed|es|e|s)$/, '');
  return s.length >= 2 ? s : word;
}

function numberKey(t) {
  return /^[0-9]+$/.test(t) ? String(Number(t)) : t;
}

// { words, seq, numbers, negated } — the facts a text states, in comparable
// form. `seq` keeps the words in order: "I owe Ravi 500" and "Ravi owes me 500"
// have the same words and opposite meanings (attacked 2026-09-25).
function contentOf(text) {
  const words = new Set(); const seq = []; const numbers = new Set(); let negated = false;
  for (const t of tokens(text)) {
    if (NEGATION.has(t)) negated = true;
    else if (NUMBER.test(t)) numbers.add(numberKey(t));
    else if (!FILLER.has(t)) { const w = stem(t); words.add(w); seq.push(w); }
  }
  return { words, seq, numbers, negated };
}

function subset(a, b) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Do `want`'s words occur in `heard` in the same order (not necessarily next to
// each other)? Words `heard` lacks are skipped: presence is checked separately.
function inOrder(want, heard) {
  const present = new Set(heard);
  let i = 0;
  for (const w of want.filter((x) => present.has(x))) {
    while (i < heard.length && heard[i] !== w) i += 1;
    if (i >= heard.length) return false;
    i += 1;
  }
  return true;
}

// Words of `text` that `said` does not contain. Numbers are left to
// unsupportedNumbers(), which also knows today's date. A negation `said` lacks
// is reported as the word "not".
function unsupportedWords(text, said, today) {
  const want = contentOf(String(text || '').replace(DATE_SUFFIX_RE, ' '));
  const heard = contentOf(said);
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    heard.words.add(stem(MONTHS[today.getMonth()])); heard.words.add(stem(WEEKDAYS[today.getDay()]));
  }
  const missing = [...want.words].filter((w) => !heard.words.has(w));
  if (want.negated && !heard.negated) missing.push('not');
  return missing;
}

// Are the words of `text` in the order `said` has them?
function sameOrder(text, said) {
  return inOrder(contentOf(String(text || '').replace(DATE_SUFFIX_RE, ' ')).seq, contentOf(said).seq);
}

// Did `spoken` carry `text` whole: every word, in order, every number, and a
// negation exactly when the text has one? `numbers: 'subset'` lets the speech
// mention other numbers too (a click question may say "the third video"); a
// memory read-back must not, because two values heard is not one value
// confirmed. `ordered: false` is for names: "Never Gonna Give You Up by Rick
// Astley" names "Rick Astley - Never Gonna Give" as surely as the title's order.
function readBackMatches(spoken, text, { numbers = 'exact', ordered = true } = {}) {
  const want = contentOf(text);
  if (!want.words.size && !want.numbers.size) return false;
  const heard = contentOf(spoken);
  if (!subset(want.words, heard.words)) return false;
  if (ordered && !inOrder(want.seq, heard.seq)) return false;
  const numbersOk = numbers === 'subset' ? subset(want.numbers, heard.numbers)
    : subset(want.numbers, heard.numbers) && subset(heard.numbers, want.numbers);
  return numbersOk && want.negated === heard.negated;
}

// The start of a label, as written, up to its `max`-th content word: a YouTube
// title runs to twenty words and a person names it by its start. Five words tell
// most titles apart; telling apart two parts of one series is BUG-471's job.
const LABEL_WORDS = 5;
function leadingWords(label, max = LABEL_WORDS) {
  const s = String(label || '');
  let seen = 0;
  for (const m of s.normalize('NFC').matchAll(/[\p{L}\p{M}\p{N}'’]+/gu)) {
    if (tokens(m[0]).every((t) => FILLER.has(t))) continue;
    seen += 1;
    if (seen === max) return s.normalize('NFC').slice(0, m.index + m[0].length).trim();
  }
  return s.trim();
}

// The fact-bearing heads of a request clause that a save must keep: the word
// after "my" or "our" ("my SISTER's name" — drop it and the fact is about the
// operator instead), and whether the clause is negative.
function requiredOf(clause) {
  const t = tokens(clause);
  const heads = new Set();
  t.forEach((w, i) => { if ((w === 'my' || w === 'our') && t[i + 1] && !FILLER.has(t[i + 1])) heads.add(stem(t[i + 1])); });
  return { heads, negated: t.some((w) => NEGATION.has(w)) };
}

module.exports = { tokens, contentOf, unsupportedWords, sameOrder, readBackMatches, leadingWords, requiredOf };
