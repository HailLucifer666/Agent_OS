'use strict';

// tts-chain-sticky.test.js — ONE VOICE PER SESSION.
//
// THE REQUIREMENT (operator, 2026-07-31): "the greeting message as soon as it starts
// should be the same until switch... I should not hear a new voice" — the boot
// greeting and the conversation must come out of the same engine, and the engine
// must not change underfoot.
//
// This is the half that fixing the voice IDs did not cover. Previously the greeting
// went through edge-tts while conversation went through Gemini Live, so the entity
// greeted as a British man and answered as a woman. Matching the ids stops the
// mismatch; making the choice STICK stops it coming back the moment a provider has
// a slow minute.
//
// The properties asserted here, each of which is audible if it breaks:
//   * the chain probes ONCE — a re-probe per utterance could pick a different
//     engine mid-conversation
//   * on a real failure it moves to the next provider AND STAYS there — flapping
//     back and forth would change voice every other sentence
//   * it never walks BACKWARDS to a provider that already failed this session
//   * an abort (barge-in) is not treated as a provider failure
//   * the mime travels per chunk, because the engines emit different containers

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createTtsChain, parseChain } = require('../providers/tts');

// Minimal fake provider with controllable health/synthesis, shaped like the real ones.
function fake(name, opts = {}) {
  const p = {
    name,
    mime: opts.mime || 'audio/wav',
    calls: 0,
    probes: 0,
    available: opts.available !== false,
    fail: opts.fail || false,
    async isAvailable() { p.probes++; return p.available; },
    async synthesize({ signal }) {
      p.calls++;
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (p.fail) throw new Error(name + ' is down');
      return Buffer.from('audio-from-' + name);
    },
  };
  return p;
}

const quiet = { info() {}, warn() {} };

// Build a chain over injected fakes by stubbing parseChain's inputs is awkward, so
// exercise createTtsChain through a config naming real providers and then swap the
// resolved internals is worse. Instead: the chain module is pure over BY_NAME, so
// test the documented behaviours through a hand-rolled equivalent config where
// possible, and through the real registry for ordering.
describe('parseChain() — order and validity', () => {
  test('parses an ordered comma list and keeps the order given', () => {
    const names = parseChain({ VOICE_TTS_CHAIN: 'gemini,edge,piper' }).map((p) => p.name);
    assert.deepEqual(names, ['gemini-tts', 'edge-tts', 'piper-tts']);
  });

  test('unknown entries are dropped, not fatal', () => {
    const names = parseChain({ VOICE_TTS_CHAIN: 'nonsense,piper' }).map((p) => p.name);
    assert.deepEqual(names, ['piper-tts']);
  });

  test('duplicates collapse so a provider is never tried twice in one pass', () => {
    const names = parseChain({ VOICE_TTS_CHAIN: 'edge,edge,piper,edge' }).map((p) => p.name);
    assert.deepEqual(names, ['edge-tts', 'piper-tts']);
  });

  test('an empty or all-invalid chain still yields a working default', () => {
    assert.deepEqual(parseChain({ VOICE_TTS_CHAIN: '' }).map((p) => p.name), ['edge-tts']);
    assert.deepEqual(parseChain({ VOICE_TTS_CHAIN: ',,,' }).map((p) => p.name), ['edge-tts']);
    assert.deepEqual(parseChain({}).map((p) => p.name), ['edge-tts']);
  });

  test('the legacy single-value VOICE_TTS_PROVIDER still works', () => {
    assert.deepEqual(parseChain({ VOICE_TTS_PROVIDER: 'piper' }).map((p) => p.name), ['piper-tts']);
  });
});

const { createTtsChain: realCreate } = require('../providers/tts');

describe('sticky resolution + failover', () => {
  // Uses the real chain over the real provider modules, with their isAvailable /
  // synthesize swapped for the duration of each test. That keeps the test honest
  // about the actual code path rather than a parallel implementation.
  const edge = require('../providers/edge-tts');
  const piper = require('../providers/piper-tts');

  function swap(mod, impl) {
    const saved = { isAvailable: mod.isAvailable, synthesize: mod.synthesize };
    Object.assign(mod, impl);
    return () => Object.assign(mod, saved);
  }

  test('probes ONCE and reuses the winner for every later call', async () => {
    let probes = 0, calls = 0;
    const restore = swap(edge, {
      isAvailable: async () => { probes++; return true; },
      synthesize: async () => { calls++; return Buffer.from('edge-audio'); },
    });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      const a = await chain.synthesize({ text: 'one' });
      const b = await chain.synthesize({ text: 'two' });
      const c = await chain.synthesize({ text: 'three' });
      assert.equal(probes, 1, 'a re-probe per utterance could switch engines mid-conversation');
      assert.equal(calls, 3);
      for (const r of [a, b, c]) {
        assert.equal(r.provider, 'edge-tts');
        assert.equal(r.mime, 'audio/mpeg');
      }
    } finally { restore(); }
  });

  test('skips an unavailable head and resolves to the next', async () => {
    const r1 = swap(edge, { isAvailable: async () => false, synthesize: async () => { throw new Error('nope'); } });
    const r2 = swap(piper, { isAvailable: async () => true, synthesize: async () => Buffer.from('piper-audio') });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      const out = await chain.synthesize({ text: 'hello' });
      assert.equal(out.provider, 'piper-tts');
      assert.equal(out.mime, 'audio/wav', 'the container differs per engine and must travel per chunk');
    } finally { r1(); r2(); }
  });

  test('on a mid-session failure it fails over AND STAYS on the new provider', async () => {
    let edgeCalls = 0, piperCalls = 0;
    let edgeBroken = false;
    const r1 = swap(edge, {
      isAvailable: async () => true,
      synthesize: async () => { edgeCalls++; if (edgeBroken) throw new Error('edge died'); return Buffer.from('edge'); },
    });
    const r2 = swap(piper, { isAvailable: async () => true, synthesize: async () => { piperCalls++; return Buffer.from('piper'); } });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      assert.equal((await chain.synthesize({ text: '1' })).provider, 'edge-tts');

      edgeBroken = true;
      assert.equal((await chain.synthesize({ text: '2' })).provider, 'piper-tts', 'must fail over');

      // The crucial one: even though edge would now "work" again, going back would
      // change the voice again mid-conversation.
      edgeBroken = false;
      const after = edgeCalls;
      assert.equal((await chain.synthesize({ text: '3' })).provider, 'piper-tts',
        'must NOT flap back — a voice change should only ever follow a real failure');
      assert.equal(edgeCalls, after, 'a failed provider must not be retried within the session');
      assert.ok(piperCalls >= 2);
    } finally { r1(); r2(); }
  });

  test('a barge-in abort is not treated as a provider failure', async () => {
    let piperCalls = 0;
    const r1 = swap(edge, {
      isAvailable: async () => true,
      synthesize: async ({ signal }) => { if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return Buffer.from('edge'); },
    });
    const r2 = swap(piper, { isAvailable: async () => true, synthesize: async () => { piperCalls++; return Buffer.from('piper'); } });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      const ctrl = new AbortController();
      ctrl.abort();
      await assert.rejects(() => chain.synthesize({ text: 'x', signal: ctrl.signal }));
      assert.equal(piperCalls, 0, 'aborting playback must not burn the fallback provider');
    } finally { r1(); r2(); }
  });

  test('empty audio counts as a failure and moves on', async () => {
    const r1 = swap(edge, { isAvailable: async () => true, synthesize: async () => Buffer.alloc(0) });
    const r2 = swap(piper, { isAvailable: async () => true, synthesize: async () => Buffer.from('piper') });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      assert.equal((await chain.synthesize({ text: 'x' })).provider, 'piper-tts');
    } finally { r1(); r2(); }
  });

  test('every provider down throws rather than returning silent audio', async () => {
    const r1 = swap(edge, { isAvailable: async () => false, synthesize: async () => { throw new Error('down'); } });
    const r2 = swap(piper, { isAvailable: async () => false, synthesize: async () => { throw new Error('down'); } });
    try {
      const chain = realCreate({ config: { VOICE_TTS_CHAIN: 'edge,piper' }, logger: quiet });
      assert.equal(await chain.isAvailable(), false);
      await assert.rejects(() => chain.synthesize({ text: 'x' }), /no TTS provider available/);
    } finally { r1(); r2(); }
  });
});
