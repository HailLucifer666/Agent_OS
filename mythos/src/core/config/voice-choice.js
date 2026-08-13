'use strict';

// voice-choice.js — the operator's PICKED voice, expressed as config.
//
// WHY THIS EXISTS (operator, 2026-08-11): every voice id in this app is an
// environment variable — GEMINI_LIVE_VOICE, PIPER_VOICE, KOKORO_VOICE,
// VOICE_TTS_VOICE — living in mythos/.env, a file the packaged installer
// deliberately does not ship. So the desktop operator had no way to change the
// voice at all, and no way to hear one before committing to it. The HUD's voice
// picker writes a small JSON file instead (voice-choice-store.js); this module
// turns that file into the same config keys the existing code already reads.
//
// NOTHING NEW IS INVENTED HERE. VOICE_ENV_KEY mirrors providers/tts.js's
// voiceFor() exactly. If a provider ever changes which key it reads, these two
// tables must move together or the picker will store a value nothing consults —
// the failure would be silent, which is why they are named the same way.
//
// PRECEDENCE, and the reason for it: a real environment variable ALWAYS wins.
// An operator running from a .env, a Dockerfile or render.yaml has said what they
// want in the loudest way the system has; a click in a HUD must not quietly
// out-rank it. Below that comes this file, and below that the derived defaults
// in voice-defaults.js. loadConfig() expresses that as spread order, and
// applyVoiceChoice() ALSO self-guards, so the rule holds even if a future caller
// reorders the spread.

const KNOWN_PROVIDERS = ['gemini-tts', 'edge-tts', 'piper-tts', 'kokoro-tts'];

// provider name (as the provider module reports it) -> the short token used in
// VOICE_TTS_CHAIN. providers/tts.js's BY_NAME is keyed by the short form.
const SHORT_NAME = {
  'gemini-tts': 'gemini',
  'edge-tts': 'edge',
  'piper-tts': 'piper',
  'kokoro-tts': 'kokoro',
};

// The env key each engine takes its voice id from — see providers/tts.js
// voiceFor(). edge (and any other engine) falls through to VOICE_TTS_VOICE.
const VOICE_ENV_KEY = {
  'gemini-tts': 'GEMINI_LIVE_VOICE',
  'piper-tts': 'PIPER_VOICE',
  'kokoro-tts': 'KOKORO_VOICE',
  'edge-tts': 'VOICE_TTS_VOICE',
};

const MAX_VOICE_LEN = 200;

function isValidChoice(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (KNOWN_PROVIDERS.indexOf(obj.provider) === -1) return false;
  if (typeof obj.voice !== 'string') return false;
  const voice = obj.voice.trim();
  return voice.length > 0 && voice.length <= MAX_VOICE_LEN;
}

// Put the chosen engine at the FRONT of the chain and keep everything else in
// its existing order. Deliberately not "chain = [chosen]": the sticky failover in
// providers/tts.js is what keeps the entity speaking when the chosen engine has a
// bad minute, and a one-entry chain would throw that away. A picked voice is a
// preference, not a restriction.
function chainWithFirst(baseChainCsv, short) {
  const rest = String(baseChainCsv || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s) => s !== short);
  return [short].concat(rest).join(',');
}

// applyVoiceChoice(rawEnv, stored, baseChainCsv) -> config overlay
//   rawEnv       — process.env (merged with any envOverrides), read ONLY to see
//                  whether the operator has configured the chain themselves.
//   stored       — the parsed voice-choice.json, or null.
//   baseChainCsv — the chain that would apply without a stored choice.
// Returns {} — meaning "change nothing" — for an absent, malformed or
// out-of-date-shape file. A corrupt file must degrade to the previous behaviour,
// never to a plausible-but-wrong voice and never to a boot failure.
function applyVoiceChoice(rawEnv, stored, baseChainCsv) {
  const env = rawEnv || {};
  const configuredChain = env.VOICE_TTS_CHAIN || env.VOICE_TTS_PROVIDER;
  if (configuredChain !== undefined && String(configuredChain) !== '') return {};
  if (!isValidChoice(stored)) return {};

  const short = SHORT_NAME[stored.provider];
  const out = { VOICE_TTS_CHAIN: chainWithFirst(baseChainCsv, short) };

  // The voice id itself is a second, independent override — and it loses to a
  // real env var of its own accord, for the same reason the chain does.
  const voiceKey = VOICE_ENV_KEY[stored.provider];
  if (voiceKey && (env[voiceKey] === undefined || String(env[voiceKey]) === '')) {
    out[voiceKey] = stored.voice.trim();
  }
  return out;
}

// Wave 6 (2026-08-13) — "switch back" for the LIVE Gemini voice specifically.
// server/index.js's setLiveVoice() closes any open Live session and lets the
// next turn reopen with the new GEMINI_LIVE_VOICE — that mechanism already
// does the actual work of switching. What was missing was any memory of what
// the voice WAS before a switch, so "switch back to the old voice" had
// nothing to revert to except the operator re-typing the exact prior id.
//
// Deliberately in-memory, process-lifetime state, not another vault file:
// this is "undo my last live-voice switch", a runtime action bounded to the
// current run, not a durable preference (that's voice-choice-store.js's job,
// unaffected by this). A restart naturally forgets it, which is correct —
// there is nothing to revert to before any switch has happened.
//
// undefined (never assigned) is a THIRD state, distinct from both a real
// voice id and null (recorded-as-"no override was active"): "nothing has
// ever been recorded". Collapsing that into null would make "revert to no
// override" (a real, valid target) indistinguishable from "there is no
// history to revert" — exactly the bug a first version of this shipped with.
let previousLiveVoice;

// Call BEFORE applying a new voice, passing the value that is ABOUT TO BE
// REPLACED (may be null, meaning "no override was active"). Returns nothing;
// this only records history for popPreviousLiveVoice() below.
function recordLiveVoiceSwitch(outgoingVoice) {
  previousLiveVoice = outgoingVoice || null;
}

// Consumes the recorded previous voice so a SECOND revert (with nothing new
// recorded since) reports "nothing to revert to" instead of toggling forever
// on stale history. Returns undefined when nothing was ever recorded (the
// caller's signal to say so honestly), null when the recorded state IS "no
// override" (a real, valid revert target), or the previous voice id string.
function popPreviousLiveVoice() {
  const v = previousLiveVoice;
  previousLiveVoice = undefined;
  return v;
}

// Test seam only — production code has no legitimate reason to reset this
// mid-process; a real revert always goes through popPreviousLiveVoice().
function _resetLiveVoiceHistory() {
  previousLiveVoice = undefined;
}

module.exports = {
  KNOWN_PROVIDERS,
  SHORT_NAME,
  VOICE_ENV_KEY,
  MAX_VOICE_LEN,
  isValidChoice,
  applyVoiceChoice,
  recordLiveVoiceSwitch,
  popPreviousLiveVoice,
  _resetLiveVoiceHistory,
};
