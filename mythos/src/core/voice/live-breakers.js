'use strict';

// BUG-340 (2026-08-24): the gemini-live circuit breaker, finally real.
//
// live-session.js has gated reconnects through breakers.allow/fail/success
// since Slice-2, but nothing ever registered a breaker under that name and
// the names themselves do not exist on the hub registry (which speaks
// recordFailure/recordSuccess) — so every call was an inert no-op and a
// sustained Gemini outage produced unbroken reconnect storms with no HUD
// visibility. This module builds ONE real breaker and adapts it to the exact
// contract live-session uses; server/index.js registers adapter.breaker into
// the hub registry (guarded, so session rotations cannot stack duplicates)
// and passes the ADAPTER to createLiveSession.
//
// Deliberately narrow: only 'gemini-live' routes to the breaker; any other
// name passes through ungated — this adapter exists for exactly one circuit.

const { createBreaker } = require('../immune/breakers');

const BREAKER_NAME = 'gemini-live';

function createGeminiLiveBreakerSet({ bus, config }) {
  const breaker = createBreaker({ name: BREAKER_NAME, bus: bus || { emit() {} }, config });
  return {
    breaker,
    allow(name) {
      if (name !== BREAKER_NAME) return true;
      return breaker.allow();
    },
    fail(name) {
      if (name !== BREAKER_NAME) return;
      breaker.recordFailure();
    },
    success(name) {
      if (name !== BREAKER_NAME) return;
      breaker.recordSuccess();
    },
  };
}

module.exports = { createGeminiLiveBreakerSet, ensureGeminiLiveBreakerWired, BREAKER_NAME };

// Boot-side convenience for server/index.js (ratchet: that file cannot grow):
// builds the set once, registers the breaker into the hub registry guarded so
// session rotations cannot stack duplicates, and returns the NAME ADAPTER.
function ensureGeminiLiveBreakerWired({ bus, config, effectors }) {
  const set = createGeminiLiveBreakerSet({ bus, config });
  if (effectors && effectors.breakers && typeof effectors.breakers.set === 'function' && !effectors.breakers.has(BREAKER_NAME)) {
    effectors.breakers.set(BREAKER_NAME, set.breaker);
  }
  return set;
}
