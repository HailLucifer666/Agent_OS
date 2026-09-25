'use strict';

// providers/tts-circuit.js — per-engine circuit state for the TTS chain.
// BUG-450, 2026-09-23.
//
// THE BUG, measured on the 2026-09-23 attended run. The chain (providers/tts.js) is
// sticky — it moves off an engine only when a LATER engine succeeds — and nothing
// remembered a failure between calls. So:
//   * three sentences in flight at once each walked gemini (429) -> kokoro
//     (timeout, up to 60 s) -> edge: Gemini answered 429 six times in 34 s before
//     the failover stuck;
//   * Kokoro failed twice more AFTER the failover — calls already in flight;
//   * a crash restart rebuilt the chain and Gemini 429'd again from the top.
// Kokoro's timeout ends in its worker being terminated mid-inference, the prime
// suspect for BUG-422's native crash, so every repeat was also a crash risk.
//
// THE STATE MACHINE, one circuit per engine (and per credential — see keyFor):
//   unproven  never succeeded in this process: ONE call is admitted at a time and
//             the others WAIT for its answer, rather than all paying for it;
//   healthy   last call succeeded: unlimited concurrency, as before;
//   cooling   parked until `until`: not admitted at all, the chain skips it;
//   probing   the cooldown ran out: ONE call is admitted as the probe, as unproven.
// A park is caused by any failure the chain would fail over for. A quota error
// (429) is parked for the retry delay Google sent, if it is sane (1 s..24 h),
// else for the ladder; any other failure for the ladder. Each consecutive failed
// probe climbs the ladder; any success resets it. A CANCELLATION (barge-in, an
// abort) never counts — the caller changed its mind, the engine did nothing wrong.
//
// CALLS ADMITTED BEFORE THE PARK are tracked separately: they cannot be recalled,
// so their later failures are counted as `failedAfterPark` and do NOT climb the
// ladder again — one outage is one park.
//
// SHARING IS EXPLICIT. `sharedCircuits` is the registry the server hands to every
// chain it builds (boot, and the voice-picker rebuild in routes/tts-voices.js), so
// a rebuilt chain remembers what is parked. A chain given no registry gets its
// own: that keeps every test that swaps functions on the real engine modules
// isolated from the next one, which a module-level default would not.
//
// ATTACK RECORD (rules/core.md §11): Q1 the classifier is by structure first
// (err.status, then the message), and anything it cannot place is an ordinary
// failure — it can only ever park, never admit. Q2 every park is a
// `tts.provider-parked` line naming the cause and the length. Q5 LADDER_MS starts
// at five minutes because a Kokoro timeout costs up to 60 s: a one-minute park
// would re-pay it most minutes. Q8 the voice DOES change back when a better engine
// recovers — one probe after its cooldown, never per sentence.

const LADDER_MS = [5 * 60 * 1000, 30 * 60 * 1000, 4 * 60 * 60 * 1000];
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

function classify(err, signal) {
  const msg = String((err && err.message) || err || '');
  if ((signal && signal.aborted) || /^aborted$/i.test(msg) || (err && err.name === 'AbortError')) return 'cancelled';
  if ((err && err.status === 429) || /\b429\b|quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'quota';
  if (/timed out|timeout/i.test(msg)) return 'timeout';
  if (/empty audio|returned no audio/i.test(msg)) return 'empty';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|\b5\d\d\b/i.test(msg)) return 'transport';
  return 'error';
}

function saneRetry(ms) {
  return Number.isFinite(ms) && ms >= RETRY_MIN_MS && ms <= RETRY_MAX_MS ? ms : null;
}

function createCircuit(name, { now, logger }) {
  let state = 'unproven';
  let until = 0;
  let level = 0;
  let epoch = 0;            // bumped by every park; a ticket remembers the epoch it was admitted in
  let gate = null;          // { promise, resolve } while a single probe call is in flight
  const counts = { parks: 0, failedAfterPark: 0, successes: 0, failures: 0 };

  function openGate() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    gate = { promise, resolve };
  }
  function closeGate() { if (gate) { const g = gate; gate = null; g.resolve(); } }

  function park(cause, retryAfterMs, inFlightAtPark) {
    const cooldownMs = cause === 'quota' && saneRetry(retryAfterMs) ? retryAfterMs : LADDER_MS[Math.min(level, LADDER_MS.length - 1)];
    state = 'cooling';
    until = now() + cooldownMs;
    epoch += 1;
    counts.parks += 1;
    logger.warn('tts.provider-parked', { provider: name, cause, cooldownMs, until: new Date(until).toISOString(), level, inFlightAtPark });
    level += 1;
  }

  let inFlight = 0;

  // admit(signal) -> ticket | null. Null means "skip this engine now".
  async function admit(signal) {
    for (;;) {
      if (state === 'cooling') {
        if (now() < until) return null;
        state = 'probing';
      }
      if (state === 'healthy') return ticket(false);
      if (gate) {
        // Someone is already asking this engine; wait for the answer rather than
        // ask again. A waiter that is cancelled leaves without penalty.
        await new Promise((resolve, reject) => {
          if (signal && signal.aborted) { reject(new Error('aborted')); return; }
          const onAbort = () => reject(new Error('aborted'));
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
          gate.promise.then(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
        });
        continue;
      }
      openGate();
      return ticket(true);
    }
  }

  // A ticket settles exactly once. A probe that is cancelled hands the question
  // back UNANSWERED — the state stays unproven/probing — so the next caller asks.
  function ticket(isProbe) {
    const myEpoch = epoch;
    inFlight += 1;
    let settled = false;
    function settle() {
      if (settled) return false;
      settled = true;
      inFlight -= 1;
      return true;
    }
    function success() {
      if (!settle()) return;
      counts.successes += 1;
      state = 'healthy'; level = 0; until = 0;
      if (isProbe) closeGate();
    }
    function cancelled() {
      if (!settle()) return;
      if (isProbe) closeGate();
    }
    function failure(err, signal) {
      const cause = classify(err, signal);
      if (cause === 'cancelled') { cancelled(); return; }
      if (!settle()) return;
      counts.failures += 1;
      if (myEpoch !== epoch) { counts.failedAfterPark += 1; if (isProbe) closeGate(); return; }
      park(cause, err && err.retryAfterMs, inFlight);
      if (isProbe) closeGate();
    }
    return { isProbe, success, cancelled, failure };
  }

  function snapshot() {
    return { state, until, level, parks: counts.parks, failedAfterPark: counts.failedAfterPark, successes: counts.successes, failures: counts.failures };
  }

  return { admit, snapshot, get state() { return state; } };
}

// Registry: one circuit per (engine object, credential fingerprint). Keyed by the
// OBJECT, not the name, so two fakes that share a name never share a circuit.
function createCircuitRegistry({ now = Date.now, logger } = {}) {
  const byProvider = new WeakMap();
  const all = [];
  let log = logger || { warn() {}, info() {} };
  function keyFor(provider, config) {
    try { return typeof provider.circuitKey === 'function' ? String(provider.circuitKey(config) || '') : ''; } catch (_) { return ''; }
  }
  function forProvider(provider, config) {
    let m = byProvider.get(provider);
    if (!m) { m = new Map(); byProvider.set(provider, m); }
    const k = keyFor(provider, config);
    let c = m.get(k);
    if (!c) {
      c = createCircuit((provider && provider.name) || 'unknown', { now, logger: { warn: (a, b) => log.warn(a, b), info: (a, b) => log.info(a, b) } });
      m.set(k, c);
      all.push({ name: (provider && provider.name) || 'unknown', c });
    }
    return c;
  }
  function useLogger(l) { if (l) log = l; }
  function stats() {
    const byName = {};
    let parks = 0;
    for (const { name, c } of all) { const s = c.snapshot(); byName[name] = s; parks += s.parks; }
    return { parks, byProvider: byName };
  }
  return { forProvider, useLogger, stats };
}

const sharedCircuits = createCircuitRegistry();

module.exports = { createCircuitRegistry, sharedCircuits, classify, LADDER_MS, RETRY_MIN_MS, RETRY_MAX_MS };
