'use strict';

// acknowledgement.js — is this WHOLE utterance a conversational acknowledgement?
// B2a of the Stage 1 repair campaign (2026-09-25), BUG-460, plan A5.
//
// Why it exists. fragment-guard.js corrects MYTHOS ("I missed what you said")
// when the operator's words are one short token and the reply is long. It had no
// notion of a recognised word, so "Okay." answered with a normal sentence drew the
// correction — live on 2026-09-25 at 02:11:41 ("Okay." then "Glad to hear it…").
// Replayed over all 2286 Live turns in the four vault copies, the rule fired on six
// acknowledgements ("Okay." x2, "No." x2, "Sure.", "Right.") and every one of the
// six was the operator being understood.
//
// What it is NOT, by construction:
//   - not consent. Nothing that authorises an action may use this; the authority
//     gate has its own whole-utterance reply check (operator-authority.js
//     isAffirmativeReply), and a test pins that only fragment-guard.js imports
//     this module. "Okay" answering a proposal is a conversation, not a yes.
//   - not a command. "browser", "music", "further" are words, but they are
//     requests, and whether a reply to one was earned is not decided here.
//   - not voice-agent.js's NEGATIVE_RE / AFFIRMATIVE_RE, which are unanchored and
//     include action words ("send"). This matches the whole utterance or nothing.
//
// The list is closed and short on purpose: a word missing from it keeps today's
// behaviour (the correction), which is the safe direction for a rule whose job is
// to catch MYTHOS asserting things on input it did not understand. English plus
// the operator's two other languages, in native script and romanised; nothing
// else is assumed about which language the transcriber will return. Filler SOUNDS
// ("hmm", "mm", "uh-huh") are deliberately left out: noise is transcribed as them,
// and none appeared in the replayed history.
const ACKNOWLEDGEMENTS = new Set([
  // English
  'ok', 'okay', 'okey', 'alright', 'right', 'sure', 'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah',
  'fine', 'cool', 'great', 'good', 'nice', 'perfect', 'correct', 'exactly', 'thanks', 'gotcha',
  // Bengali
  'হ্যাঁ', 'হ্যা', 'না', 'আচ্ছা', 'ঠিক', 'ঠিকআছে',
  // Hindi
  'हाँ', 'हां', 'हा', 'जी', 'नहीं', 'नही', 'ठीक', 'अच्छा',
  // romanised Bengali / Hindi
  'haan', 'han', 'haa', 'ji', 'nahi', 'nahin', 'theek', 'thik', 'accha', 'acha', 'achha', 'achcha',
]);

// Punctuation the transcriber puts around a spoken word, including the Bengali
// and Hindi full stop (danda). Only stripped at the EDGES: "no1" or "o.k.ay" are
// not acknowledgements. One character class for both edges, so they cannot drift
// apart (a hand-written pair did, under mutation, 2026-09-25).
const PUNCT = '[\\s"\'“”‘’¡¿.,!?…।॥-]+';
const EDGE_PUNCTUATION = new RegExp('^' + PUNCT + '|' + PUNCT + '$', 'gu');

function isAcknowledgement(text) {
  const word = String(text || '').replace(EDGE_PUNCTUATION, '').toLowerCase();
  return ACKNOWLEDGEMENTS.has(word);
}

module.exports = { isAcknowledgement, ACKNOWLEDGEMENTS };
