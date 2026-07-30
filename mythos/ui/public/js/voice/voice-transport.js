// voice-transport.js — the ONE decision that routes a voice toggle to either
// the S2S bridge (s2s-bridge.js, Gemini Live duplex) or the batch-STT loop
// (voice-loop.js). Extracted as a plain pure function for the same reason
// decideBargeIn() lives in voice-loop.js's exports: it is the only part of the
// transport choice that can be tested in node:test (there is no browser, mic
// or AudioContext here) — see test/voice-transport-decision.test.js.
//
// Why this exists at all: VOICE_S2S_ENABLED defaults to false
// (src/core/config/schema.js), and voice-loop.js's 812 lines of VAD /
// echo-guard / pre-roll / barge-in logic are the honest fallback in that case.
// The S2S wiring therefore has to be strictly additive and conditional, and —
// the hard safety property — the two transports must NEVER hold the
// microphone at the same time. Both open their own getUserMedia stream; two
// live captures means the model hears itself and the batch loop transcribes
// the Live model's speech.
//
// Contract: decideVoiceTransport(state) -> plan
//   plan.transport  's2s' | 'batch'   which transport this toggle acts on
//   plan.action     'start' | 'stop'  what to do with it
//   plan.stopOther  's2s' | 'batch' | null   a transport that is currently
//                   capturing and must be released first (or alongside a
//                   stop). Never equal to plan.transport.
// Unknown/undefined input is treated as "S2S off, nothing active" — a config
// fetch that never resolved must not silently enable S2S.

export function decideVoiceTransport(state) {
  const s = state || {};
  const s2sEnabled = Boolean(s.s2sEnabled);
  const s2sActive = Boolean(s.s2sActive);
  const batchActive = Boolean(s.batchActive);

  const transport = s2sEnabled ? 's2s' : 'batch';
  const chosenActive = s2sEnabled ? s2sActive : batchActive;
  const otherActive = s2sEnabled ? batchActive : s2sActive;

  return {
    transport,
    action: chosenActive ? 'stop' : 'start',
    // Released whenever it is holding the mic, on start AND on stop: a stop
    // must not leave a stray capture running just because the other transport
    // was the one that was live.
    stopOther: otherActive ? (s2sEnabled ? 'batch' : 's2s') : null,
  };
}
