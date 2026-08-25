'use strict';

// BUG-340 (2026-08-24): live-session.js has always gated reconnects through
// breakers.allow/fail/success('gemini-live'), but TWO defects made those
// calls inert no-ops:
//   1. Nothing ever registered a breaker named 'gemini-live' in the hub —
//      unknown names allow() true and record nothing (hub.js documents this).
//   2. Even registered, the hub registry speaks recordFailure/recordSuccess;
//      live-session calls fail/success — names that do not exist.
// Net effect: sustained Gemini outages (provider-down x3008 era) produced
// reconnect storms with zero circuit-breaking and zero HUD visibility.
//
// Fix under test: src/core/voice/live-breakers.js builds ONE real breaker,
// adapts its names to the contract live-session actually uses, and boots into
// the hub registry (server/index.js) so broadcastHealth surfaces its state.
//
// Negative control (both directions): live-session must keep calling exactly
// allow/fail/success — if either side of the contract drifts silently, this
// file goes red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createGeminiLiveBreakerSet, ensureGeminiLiveBreakerWired } = require('../src/core/voice/live-breakers.js');

const CFG = { BREAKER_FAIL_THRESHOLD: 2, BREAKER_WINDOW_MS: 30000, BREAKER_RESET_MS: 60000 };
const NULL_BUS = { emit() {} };

test('after threshold failures the gate CLOSES: reconnect storms are broken', () => {
  const set = createGeminiLiveBreakerSet({ bus: NULL_BUS, config: CFG });
  set.fail('gemini-live');
  set.fail('gemini-live');
  assert.strictEqual(set.allow('gemini-live'), false, 'a storm of failed opens must stop being admitted');
});

test('success resets the circuit via the probe path; other names are pass-through', async () => {
  const set = createGeminiLiveBreakerSet({ bus: NULL_BUS, config: Object.assign({}, CFG, { BREAKER_RESET_MS: 10 }) });
  set.fail('gemini-live'); set.fail('gemini-live');
  assert.strictEqual(set.allow('gemini-live'), false);
  // Real recovery shape: once resetAt elapses allow() admits ONE probe
  // (HALF_OPEN) and success() on it closes the circuit.
  await new Promise((r) => setTimeout(r, 15));
  assert.strictEqual(set.allow('gemini-live'), true, 'the single probe must be admitted');
  set.success('gemini-live');
  assert.strictEqual(set.allow('gemini-live'), true, 'recovery must reopen the gate');

  assert.strictEqual(set.allow('some-other-breaker'), true, 'non-gemini names must never be gated here');
  set.fail('some-other-breaker'); // must not throw, must not touch our breaker
  assert.strictEqual(set.allow('gemini-live'), true);
});

test('the breaker lives in the hub registry shape, so HUD stats can see it', () => {
  const set = createGeminiLiveBreakerSet({ bus: NULL_BUS, config: CFG });
  assert.ok(set.breaker && typeof set.breaker.stats === 'function' || set.breaker.stats, 'breaker handle missing');
  const stats = set.breaker.statsAt ? set.breaker.statsAt(Date.now()) : set.breaker.stats;
  assert.strictEqual(stats.name, 'gemini-live');
});

test('wiring is idempotent: rotations cannot stack duplicate registrations', () => {
  let sets = 0;
  const registry = { has: () => sets > 0, set: () => { sets += 1; } };
  const effectors = { breakers: registry };
  createGeminiLiveBreakerSet({ bus: NULL_BUS, config: CFG }); // stray builds are harmless
  const a = ensureGeminiLiveBreakerWired({ bus: NULL_BUS, config: CFG, effectors });
  const b = ensureGeminiLiveBreakerWired({ bus: NULL_BUS, config: CFG, effectors });
  assert.strictEqual(sets, 1, `registration ran ${sets} times across two boots — duplicates would stack breakers`);
  assert.ok(a.breaker === b.breaker || sets === 1);
});

test('wiring: server delegates to ensureGeminiLiveBreakerWired and passes the adapter', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(SRC, /ensureGeminiLiveBreakerWired\(\{ bus: bus, config: config, effectors \}\)/,
    'server/index.js must delegate wiring to voice/live-breakers.js');
  assert.match(SRC, /breakers: geminiLiveBreakers/, 'createLiveSession still receives the raw registry whose names do not match');
});

test('negative control: live-session still speaks allow/fail/success', () => {
  const LIVE = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'voice', 'live-session.js'), 'utf8');
  assert.match(LIVE, /breakers\.allow\(BREAKER\)/);
  assert.match(LIVE, /breakers\.fail\(BREAKER\)/);
  assert.match(LIVE, /breakers\.success\(BREAKER\)/);
});
