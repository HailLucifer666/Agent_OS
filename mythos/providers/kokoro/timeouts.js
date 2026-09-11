'use strict';

// providers/kokoro/timeouts.js — the two tunable bounds, parsed and validated.
//
// WHY NOT src/core/config/schema.js. A schema validation failure is a BOOT-level
// config error: the server refuses to start. Kokoro is an OPTIONAL provider on a
// fallback chain, and a typo in one of its timeouts must not be the reason the
// whole assistant fails to come up. So an invalid value here is DATA, not an
// exception — the facade turns it into an unavailableReason and the TTS chain
// moves to the next rung, exactly as it does for a missing model. Nothing in
// this file throws. (The schema file is also at its own 870-line ratchet
// ceiling, which is a second reason, but the first one is the real one.)
//
// WHY THREE NUMBERS AND NOT ONE. They bound three different things, and
// collapsing them would lose the distinction the provider's contract rests on:
//
//   LOAD_TIMEOUT_MS (15s, fixed)   how long isAvailable() will WAIT before
//                                  answering "no". It does NOT abort the load —
//                                  a cold download keeps running in the
//                                  background so a later probe finds it warm.
//                                  This is a RESPONSE bound, and it is the one
//                                  thing here a caller can feel.
//   KOKORO_LOAD_TIMEOUT_MS (60s)   how long that background initialization may
//                                  actually run before it is abandoned. Without
//                                  it a stalled Hugging Face connection pins a
//                                  worker forever and every later probe reports
//                                  a load "in flight" that will never land.
//   KOKORO_SYNTH_TIMEOUT_MS (60s)  how long one synthesis may take, measured
//                                  from ADMISSION rather than from the start of
//                                  inference, so time spent queued behind
//                                  another utterance is inside the budget.

// Node's setTimeout silently clamps anything above 2^31-1 to 1ms — a 32-bit
// overflow that turns "wait an hour" into "fire immediately". Rejecting it is
// the difference between a config error and a timeout that appears to fire at
// random.
const MAX_TIMER_MS = 2147483647;

const LOAD_TIMEOUT_MS = 15000;
const DEFAULT_INIT_TIMEOUT_MS = 60000;
const DEFAULT_SYNTH_TIMEOUT_MS = 60000;

// Returns { ok: true, ms } or { ok: false, reason }. An UNSET variable is not an
// error — it is the default. An empty or whitespace-only value IS an error,
// because `KOKORO_SYNTH_TIMEOUT_MS=` in a .env file is someone trying to say
// something, and silently treating it as "default" hides a typo.
function parseTimeout(name, raw, defaultMs) {
  if (raw === undefined || raw === null) return { ok: true, ms: defaultMs };
  const text = String(raw);
  if (!text.trim()) {
    return { ok: false, reason: name + ' is set but empty — remove it to use the default of ' + defaultMs + 'ms' };
  }
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMER_MS) {
    return {
      ok: false,
      reason: name + '=' + JSON.stringify(text) + ' is not usable: it must be a whole number of '
        + 'milliseconds between 1 and ' + MAX_TIMER_MS + '. Kokoro is unavailable until it is fixed '
        + 'or removed; the rest of the TTS chain is unaffected.',
    };
  }
  return { ok: true, ms: n };
}

// Reads both tunables at once. Returns { ok, initMs, synthMs } or
// { ok: false, reason } naming the FIRST offending variable — one reason is
// enough to act on, and listing two makes the shorter one easy to miss.
function resolveTimeouts(env) {
  const e = env || process.env;
  const init = parseTimeout('KOKORO_LOAD_TIMEOUT_MS', e.KOKORO_LOAD_TIMEOUT_MS, DEFAULT_INIT_TIMEOUT_MS);
  if (!init.ok) return init;
  const synth = parseTimeout('KOKORO_SYNTH_TIMEOUT_MS', e.KOKORO_SYNTH_TIMEOUT_MS, DEFAULT_SYNTH_TIMEOUT_MS);
  if (!synth.ok) return synth;
  return { ok: true, initMs: init.ms, synthMs: synth.ms };
}

module.exports = {
  parseTimeout,
  resolveTimeouts,
  LOAD_TIMEOUT_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_SYNTH_TIMEOUT_MS,
  MAX_TIMER_MS,
};
