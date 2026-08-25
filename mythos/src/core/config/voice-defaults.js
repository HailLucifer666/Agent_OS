'use strict';

// voice-defaults.js — pick a TTS chain from what the machine actually HAS.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the packaged .exe spoke with the
// flat browser speechSynthesis voice while the dev server spoke with the Gemini
// voice. Nothing in the voice code differed — the configuration did. package.json
// build.files excludes mythos/.env, and dev's .env is the only place that ever set
// VOICE_TTS_CHAIN. The schema default is '' (providers/tts.js:parseChain then falls
// back to 'edge'), edge-tts was excluded from the build too, kokoro needs
// mythos/models which is also excluded — so nothing server-side could speak and the
// HUD took its browser fallback (ui/public/js/voice/voice-loop.js).
//
// The fix is to derive the chain from key presence instead of shipping a chain that
// assumes an engine is installed. A GOOGLE_API_KEY entered through the first-run
// wizard is enough to get the Gemini voice, with no file to edit.
//
// SAME VOICE, NOT SAME LATENCY. 'gemini' here is Gemini TTS, not Gemini Live:
// providers/tts.js voiceFor() maps gemini-tts to GEMINI_LIVE_VOICE (default Aoede),
// so the operator hears the same person as the duplex path — but at ~3.9s/sentence
// rather than streaming. Duplex stays behind an explicit VOICE_S2S_ENABLED=true,
// which this module deliberately NEVER sets: a Live session that opens before the
// operator has spoken is metered, and the schema comment already says so.

// True only when the operator left this key completely alone. An empty string is
// the schema's own "unset", not a choice.
function unset(env, key) {
  return env[key] === undefined || String(env[key]) === '';
}

// The operator's own configuration always wins. If either key is set — even to
// something this module would never produce — it is a deliberate choice and we
// return nothing rather than argue with it.
function deriveVoiceDefaults(rawEnv) {
  const env = rawEnv || {};
  const chosen = env.VOICE_TTS_CHAIN || env.VOICE_TTS_PROVIDER;
  if (chosen !== undefined && String(chosen) !== '') return {};

  // BUG-274 T1 (2026-08-19) — KOKORO MOVES AHEAD OF EDGE AND PIPER, ON LICENCE.
  //
  // Verified against the GitHub API, not against articles or this repo's own older
  // comments: rhasspy/piper (MIT) was ARCHIVED 2025-08-26 and its only maintained
  // fork, OHF-Voice/piper1-gpl, is GPL-3.0; upstream edge-tts is LGPLv3 and labelled
  // personal/hobby use. hexgrad/kokoro is Apache-2.0 for the code AND the weights.
  // So the derived default reached for two engines with copyleft or personal-use
  // exposure before the one that is clean end to end — while providers/kokoro-tts.js
  // already existed and kokoro-js was already a runtime dependency.
  //
  // A REORDER, NOT A REMOVAL. edge and piper stay: they are the fallback when Kokoro
  // has no weights cached yet (it fetches them from Hugging Face on first use, and
  // isAvailable() bounds that with a timeout), and dropping them would trade a licence
  // problem for a mute assistant on first boot — a worse failure.
  //
  // gemini keeps the lead when its key is present, deliberately: providers/tts.js maps
  // gemini-tts to GEMINI_LIVE_VOICE, so it is the only entry that makes MYTHOS sound
  // like the same person as the duplex path. Licence ordering must not change who it
  // sounds like.
  return {
    VOICE_TTS_CHAIN: env.GOOGLE_API_KEY
      ? 'gemini,kokoro,edge,piper'
      : 'kokoro,edge,piper',
  };
}

// THE PARITY SWITCH (operator, 2026-08-11). "Make the installer work the way
// Start Electron App.bat works" — and the difference between the two, measured
// rather than assumed, is this one flag.
//
// Dev's .env sets VOICE_S2S_ENABLED=true, so the HUD runs the Gemini Live duplex
// bridge. The packaged build had no way to receive that flag, so it fell to
// voice-loop.js's record-transcribe loop, which ducks system volume at every
// mic-hot boundary (server/index.js duckAudio). With music playing that ducking
// oscillates — the operator's installed build logged 58 set_volume calls in one
// session, all actor:'voice-ducking'. The repo's own vault has ZERO ducking rows
// across every dev session ever recorded, because that path is never entered
// when Live is on. Turning Live on is therefore not a workaround for the volume
// bug; it is the configuration difference that produced it.
//
// HONEST COST, which is why this was NOT the default before: a Live session is
// metered and opens when the HUD connects, before the operator has said
// anything. That is exactly how dev has run for months, and it is what was
// asked for. live-session.js's MAX_IDLE_ROTATIONS_WITHOUT_SPEECH still stops an
// unattended session from rotating forever. Set VOICE_S2S_ENABLED=false to opt
// out; this never overrides that.
//
// Requires the key for the same reason server/index.js's liveForSpeech() does:
// without GOOGLE_API_KEY the session cannot open, and claiming otherwise would
// just move the failure later.
function deriveLiveVoiceDefaults(rawEnv) {
  const env = rawEnv || {};
  if (!unset(env, 'VOICE_S2S_ENABLED')) return {};
  if (!env.GOOGLE_API_KEY) return {};
  return { VOICE_S2S_ENABLED: 'true' };
}

// Weights on disk are what makes the wake word real, so they are what decides
// the default. Before this, installing the models from the wizard's Components
// step left them inert — WAKEWORD_ENABLED stayed false with no UI anywhere to
// flip it, so the operator downloaded 3 files and nothing happened. The check is
// deliberately the same "all three present" rule the /api/config/wakeword route
// already applies, so the flag and the route can never disagree.
//
// hasWakewordModels is injected by the caller (loadConfig passes a real fs
// check) — this module stays pure, like the rest of the config layer.
function deriveWakewordDefaults(rawEnv, hasWakewordModels) {
  const env = rawEnv || {};
  if (!unset(env, 'WAKEWORD_ENABLED')) return {};
  if (!hasWakewordModels) return {};
  return { WAKEWORD_ENABLED: 'true' };
}

// Every key whose presence in the environment SUPPRESSES derivation above. Not
// the same set as the keys derivation produces: VOICE_TTS_PROVIDER is never
// derived, but setting it stops VOICE_TTS_CHAIN from being derived, so an
// override report that ignored it would miss a real suppression.
//
// WHY THIS LIST EXISTS AT ALL. BUG-274 T1 was fixed in this file, shipped, and
// stayed inert on the operator's machine for a day because their .env carried
// the pre-fix chain — an explicit override beats a derived default, silently.
// loadConfig uses this list to compute what derivation WOULD have produced had
// the environment set none of them, and reports the difference so the next T1 is
// visible at boot rather than a day later.
//
// GOOGLE_API_KEY is deliberately NOT here: it is read as a capability probe, and
// its presence ENABLES derivation rather than suppressing it.
//
// A list is exactly the thing that goes stale, so it is not trusted:
// test/derived-default-override-visibility.test.js scans this file for the
// override reads it actually performs and fails if any is unregistered here.
const OVERRIDE_KEYS = [
  'VOICE_TTS_CHAIN',
  'VOICE_TTS_PROVIDER',
  'VOICE_S2S_ENABLED',
  'WAKEWORD_ENABLED',
];

module.exports = { deriveVoiceDefaults, deriveLiveVoiceDefaults, deriveWakewordDefaults, OVERRIDE_KEYS };
