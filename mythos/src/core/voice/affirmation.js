'use strict';

// voice/affirmation.js — pure, zero-LLM classifier for spoken yes/no replies to a
// pending confirm/checkpoint. A short unambiguous "yes"/"no" is resolved by code
// (see server/index.js handleUtterance intercept) BEFORE any brain call, so a bare
// approval costs zero tokens. Anything longer or ambiguous returns null and falls
// through to the normal voice-agent turn.

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'confirmed', 'confirm', 'approved', 'approve', 'affirmative', 'proceed', 'okay', 'ok']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'negative', 'stop', 'cancel', 'deny', 'denied', 'wait']);
const YES_PHRASES = [/^go ahead/i, /^do it/i, /^sounds good/i, /^that works/i];
const NO_PHRASES = [/^hold on/i, /^not now/i, /^don'?t\b/i, /^do not\b/i];

function classifyAffirmation(text, maxWords) {
  if (maxWords === undefined) maxWords = 6;
  const trimmed = String(text || '').trim().replace(/[.!]+$/, '');
  if (!trimmed) return null;
  const words = trimmed.split(/\s+/);
  if (words.length > maxWords) return null; // long sentences always fall through to the model
  if (YES_PHRASES.some((re) => re.test(trimmed))) return 'yes';
  if (NO_PHRASES.some((re) => re.test(trimmed))) return 'no';
  const first = words[0].toLowerCase();
  if (YES_WORDS.has(first)) return 'yes';
  if (NO_WORDS.has(first)) return 'no';
  return null;
}

module.exports = { classifyAffirmation };
