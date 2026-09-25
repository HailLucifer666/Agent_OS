'use strict';

// operator-authority.js — does what the operator SAID authorise this call?
// (BUG-461, BUG-464, 2026-09-24.) Pure: no IO, no clock, no registry — the
// caller passes the words and the ages, so every rule here is a table test.
//
// WHY THIS EXISTS. The leash lets a human connection click, type and press keys
// with no confirmation (operator-present-trusted, leash/index.js), on the
// premise that the operator "asked for out loud". Nothing checked that premise.
// Measured in Episodic 2026-09-23/24, both with a clear transcript:
//   09-24 15:11:24  browser_click, in a turn whose words were "I didn't say
//                   anything. I didn't say anything. It's the background noise."
//                   The request it carried out was the PREVIOUS turn's four-word
//                   noise transcript, "Yep, can you play".
//   09-23 14:05:39  browser_click, in a turn that said "I didn't ask you to play
//                   that video."
// And `remember` (tier 0, no gate at all) wrote "User has not been feeling well"
// to permanent memory in a turn whose transcript was "November" (09-24 14:53:37).
//
// THE RULES, and the replay behind them (every trusted click/type/key call and
// every remember call in 13 days of Episodic, 98 + 10 calls):
//   - An objection in the operator's words ("I didn't say / ask", "not talking",
//     "background noise") stops the action. Catches both measured clicks.
//   - Four words or fewer is too little to act on. The longest measured noise
//     transcripts are four words ("Yep, can you play", "What do you think?").
//     This also asks on real short commands ("further", "Mute the volume.") —
//     the operator chose that trade on 2026-09-24: "repeating it back costs a
//     second, guessing wrong brings the wrong dish".
//   - A longer transcript must contain a request form. The 09-11 16:37:13 click
//     rode on 34 words of a news video's own audio.
//   - A turn with no operator words (started by MYTHOS's own late-result notice)
//     inherits the judgement of the operator's LAST words, if they are recent.
//     It never inherits a free pass.
//   Replayed with this module: 61 of 98 trusted calls proceed, 37 ask. Every
//   ask is a question, never a refusal — a "yes" runs exactly the proposed call.
//   Of 10 remember calls, the 6 the operator asked for proceed; the 2 plainly
//   unrequested and 2 ambiguous 09-02 turns ask.
//
// NOT A MEANING CHECK, AND IT SAYS SO. There is no judge model here (binding
// constraint). These are English lexical proxies: a clear command in another
// language asks; a long, well-formed transcript of something the operator did
// not say proceeds. Both bounds are pinned in the test file.

const SHORT_INPUT_MAX_WORDS = 4;
// A turn MYTHOS started itself (a late tool result) may carry on the operator's
// last request only this soon after it. Late results measured on 09-24 arrive
// within 10 s; a minute leaves room for a slow snapshot and no more.
const CONTINUATION_WINDOW_MS = 60000;
// A spoken memory proposal counts as presented only when MYTHOS's own speech
// carried most of the words it would save.
const PRESENTED_MIN_COVERAGE = 0.6;

const DENIAL_RE = new RegExp([
  /\bI (?:didn'?t|did not|never) (?:say|said|ask|asked|tell|told|want|wanted|mean|meant)\b/.source,
  /\b(?:I'?m|I am|I was) not (?:even )?(?:talking|speaking)\b/.source,
  /\bnot (?:even )?(?:talking|speaking) to you\b/.source,
  /\bbackground (?:noise|sound|audio|voice|chatter)\b/.source,
  /\b(?:that|it) (?:wasn'?t|was not) me\b/.source,
].join('|'), 'i');

const REQUEST_PHRASE_RE = new RegExp([
  /\b(?:can|could|would|will) (?:you|we)\b/.source, /\bshall we\b/.source, /\bplease\b/.source,
  /\bgo ahead\b/.source, /\blet'?s\b/.source, /\bI (?:want|need|would like|'d like)\b/.source,
  /\bI (?:asked|told) you to\b/.source, /\b(?:you|we) (?:need|have) to\b/.source,
  /\byou should\b/.source, /\bI mean\b/.source, /\btry\b/.source, /\bjust\b/.source, /\bmake sure\b/.source,
].join('|'), 'i');
// An imperative at the start of a clause, after any run of fillers.
const IMPERATIVE_RE = new RegExp(
  '(?:^|[.?!;]\\s*)(?:(?:ok(?:ay)?|now|so|and|then|yes|yeah|yep|fantastic|great|right|alright|anyway|also|no)[\\s,.!]*)*'
  + '(?:play|click|open|close|scroll|type|search|press|pause|mute|unmute|go|select|choose|pick|tap|hit|put|write|enter'
  + '|fill|skip|stop|start|resume|show|bring|move|find|exit|maximi[sz]e|minimi[sz]e|full|next|back|add|take|grab|keep'
  + '|continue|do|turn|switch|watch|clear|remove|upload|drag|refresh|reload|zoom)\\b', 'i');

// A whole-utterance yes. Anchored at both ends on purpose (voice-agent.js's
// WAVE 8 AFFIRMATIVE_RE is the precedent): "Yep, can you play" is not a yes.
// Not "right": a bare "Right." is a filler — it is one of the fragments the
// 2026-09-23 replay measured — and WAVE 8's list does not take it either.
const AFFIRM_WORD = "(?:ok(?:ay)?|yes|yeah|yep|yup|sure|correct|exactly|absolutely|affirmative|please|go|go on|go ahead|do it|do that|that one|that'?s right|that'?s it)";
const AFFIRM_ECHO = '(?:(?:please )?(?:remember|save|note|play|click|type|press|open|close) (?:it|that|this)|scroll)';
const AFFIRMATIVE_REPLY_RE = new RegExp('^(?:(?:' + AFFIRM_WORD + '|' + AFFIRM_ECHO + ')[\\s,.!]*)+$', 'i');

// An explicit ask to keep something. Each form is imperative or addressed to
// MYTHOS; "I remember when…", "do you remember…" and "can you remember what…"
// are recollection, not requests.
const RECALL_TAIL = '(?!\\s+(?:what|how|where|who|whether|the time|last time|yesterday)\\b)';
const MEMORY_REQUEST_RES = [
  new RegExp('(?:^|[.?!,;]\\s*|\\b(?:please|also|and|so|just|always|now|then|but)\\s+)remember\\b' + RECALL_TAIL, 'i'),
  new RegExp('\\b(?:can|could|would|will) you (?:please )?(?:remember|memori[sz]e|note|keep)\\b' + RECALL_TAIL, 'i'),
  /\bI (?:want|need|would like|'d like) you to (?:always )?(?:remember|memori[sz]e|note|keep (?:it |this |that )?in mind)\b/i,
  /\b(?:make|take) a note\b/i,
  /(?:^|[.?!,;]\s*|\b(?:please|also|and|so|just)\s+)note (?:that|this|it|down)\b/i,
  /\b(?:don'?t|do not) forget\b/i,
  /\bkeep (?:it |this |that )?in (?:mind|memory|your memory)\b/i,
  /\b(?:save|store|commit|put|add|write) (?:it |this |that )?(?:to|in|into) (?:your )?memory\b/i,
  /\bmemori[sz]e\b/i,
  /\bfrom now on\b/i,
  // A standing instruction addressed forward: "next time don't say it", "next
  // time when I ask you to open that link". Not "I'll try it next time".
  /\bnext time\s+(?:when\s+|if\s+)?(?:I|you|don'?t|do|just|please|always|never)\b/i,
];
// The operator's own 14:55:27 line was "You don't have to remember that."
const MEMORY_NEGATION_RE = new RegExp([
  /\b(?:don'?t|do not|no need to|needn'?t|never|not|shouldn'?t|should not)\s+(?:have to\s+|need to\s+)?(?:remember|memori[sz]e|note|save|store|keep)\b/.source,
  /(?<!\b(?:don'?t|do not)\s)\bforget (?:that|it|this|about it)\b/.source,
].join('|'), 'i');
// "If I say remember my birthday…", 'the word "remember"'.
const MEMORY_HYPOTHETICAL_RE = /\b(?:if|what if|suppose|supposing|when|whenever)\b[^.?!]{0,40}\b(?:I|you)\s+(?:say|said|tell|told|ask|asked)\b[^.?!]{0,20}?["'“‘]?\s*(?:remember|note|don'?t forget|keep in mind)/i;
// A memory phrase inside a quoted span is being mentioned, not said to MYTHOS.
const MEMORY_QUOTED_RE = /["“‘][^"”’]{0,60}\b(?:remember|note that|don'?t forget|keep in mind)\b[^"”’]{0,120}["”’]/i;

const STOP_WORDS = new Set(('that this with from have what when your they them then than there their will would should '
  + 'could about into just also only very even much more most some such been being were does done doing make made like '
  + 'want need user operator mythos current date sure okay yeah').split(' '));

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

// "didn’t" with a typographic apostrophe (a phone keyboard, a pasted line) is
// the same word as "didn't"; every pattern here is written with the ASCII one.
function plain(text) {
  return String(text || '').replace(/[’‘ʼ]/g, "'");
}

function hasRequestForm(text) {
  const s = plain(text);
  return REQUEST_PHRASE_RE.test(s) || IMPERATIVE_RE.test(s);
}

function isAffirmativeReply(text) {
  return AFFIRMATIVE_REPLY_RE.test(plain(text).trim());
}

// `typed`: the words came from the HUD text box, not the microphone. Typing
// cannot be background noise, so only the too-short rule — which exists for
// noise — is skipped; an objection or a non-request still asks.
function judgeWords(said, typed) {
  if (DENIAL_RE.test(plain(said))) return { proceed: false, reason: 'operator-objected' };
  if (!typed && countWords(said) <= SHORT_INPUT_MAX_WORDS) return { proceed: false, reason: 'short-input' };
  if (!hasRequestForm(said)) return { proceed: false, reason: 'not-a-request' };
  return { proceed: true, reason: 'operator-request' };
}

// The words that speak for this turn: its own, or — only when it has none —
// the operator's last words, if recent. Returns null when there are none.
function wordsFor({ current, previous, previousAgeMs, typed, previousTyped }) {
  const now = String(current || '').trim();
  if (now) return { said: now, from: 'current', typed: typed === true };
  const before = String(previous || '').trim();
  if (before && Number.isFinite(previousAgeMs) && previousAgeMs >= 0 && previousAgeMs <= CONTINUATION_WINDOW_MS) {
    return { said: before, from: 'previous', typed: previousTyped === true };
  }
  return null;
}

// A click, type or key press that the leash allowed only because a human is
// connected. proceed:false means ASK, never refuse.
function judgeTrustedAction(input) {
  const words = wordsFor(input || {});
  if (!words) return { proceed: false, reason: 'no-operator-words' };
  const verdict = judgeWords(words.said, words.typed);
  if (words.from === 'previous') {
    return verdict.proceed ? { proceed: true, reason: 'continuation' } : { proceed: false, reason: verdict.reason + '-before' };
  }
  return verdict;
}

function findMemoryRequest(text) {
  const s = plain(text);
  const explicit = MEMORY_REQUEST_RES.some((re) => re.test(s));
  return {
    explicit,
    negated: MEMORY_NEGATION_RE.test(s),
    // Quotes are read from the original text: plain() turns ’ into an apostrophe.
    hypothetical: MEMORY_HYPOTHETICAL_RE.test(s) || MEMORY_QUOTED_RE.test(String(text || '')),
  };
}

// Numbers are the facts a model most often supplies itself (a time, an amount,
// a phone number). Each digit run in the save must be in the operator's words
// or be part of today's date, which the model routinely appends.
function unsupportedNumbers(text, said, today) {
  const heard = new Set((String(said || '').match(/\d+/g) || []).map((d) => String(Number(d))));
  if (today instanceof Date && !Number.isNaN(today.getTime())) {
    [today.getFullYear(), today.getMonth() + 1, today.getDate()].forEach((n) => heard.add(String(n)));
  }
  return (String(text || '').match(/\d+/g) || []).filter((d) => !heard.has(String(Number(d))));
}

// A permanent-memory write. proceed:true only for an explicit, non-negated,
// non-hypothetical ask that carries its own content.
function judgeMemoryWrite({ text, current, previous, previousAgeMs, today } = {}) {
  const words = wordsFor({ current, previous, previousAgeMs });
  if (!words) return { proceed: false, reason: 'not-requested' };
  const found = findMemoryRequest(words.said);
  if (found.negated || DENIAL_RE.test(plain(words.said))) return { proceed: false, reason: 'operator-declined' };
  if (!found.explicit || found.hypothetical) return { proceed: false, reason: 'not-requested' };
  // "Remember that." points at something the model then chooses for itself.
  if (countWords(words.said) <= SHORT_INPUT_MAX_WORDS) return { proceed: false, reason: 'bare-referent' };
  if (unsupportedNumbers(text, words.said, today).length) return { proceed: false, reason: 'unsupported-number' };
  return { proceed: true, reason: 'operator-request' };
}

function contentWords(text) {
  return (String(text || '').toLowerCase().match(/[a-z]{4,}/g) || [])
    .filter((w) => !STOP_WORDS.has(w))
    .map((w) => w.replace(/(?:ing|ed|es|s)$/, ''));
}

// Did MYTHOS's own speech carry the text it proposes to save?
function speechCovers(spoken, text) {
  const wanted = contentWords(text);
  if (!wanted.length) return false;
  const heard = new Set(contentWords(spoken));
  const hits = wanted.filter((w) => heard.has(w)).length;
  return hits / wanted.length >= PRESENTED_MIN_COVERAGE;
}

module.exports = {
  SHORT_INPUT_MAX_WORDS, CONTINUATION_WINDOW_MS, PRESENTED_MIN_COVERAGE,
  DENIAL_RE, AFFIRMATIVE_REPLY_RE,
  countWords, hasRequestForm, isAffirmativeReply,
  judgeTrustedAction, judgeMemoryWrite, findMemoryRequest, unsupportedNumbers, speechCovers,
};
