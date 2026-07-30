'use strict';

// V2 §11 / §13 row 6 — persona unclamp (merged-order step 3).
//
// Covers the four buildable rows of the persona-unclamp phase:
//   1. lane-aware brevity tail in brain/index.js (voice loses it, build keeps it)
//   3. the raised DEFAULT_LEVELS dials in identity/index.js
//   4. the new character-brief persona seeded via memory/identity.js SEED_SELF_MD
// plus the one non-negotiable invariant: STYLE_GUARDRAIL survives at every
// dial setting, because that sentence is the entire reason humor 8 / sass 7
// are safe to run.
//
// CORRECTION 2 (see roadmap + CLAUDE.md open-source portability rule): the
// new dials and persona brief must reach a FRESH CLONE with an EMPTY vault,
// not just this machine's gitignored vault/Identity/*. Every test below
// constructs its own tempVaultDir() with no pre-existing persona.json or
// self.md — i.e. exactly what a fresh clone looks like on first boot.

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createBrain } = require('../src/core/brain/index');
const chain = require('../src/core/brain/chain');

function fakeConfig(overrides) {
  return Object.assign({ MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 }, overrides);
}

// ---------------------------------------------------------------------------
// Fresh-clone identity: new dials + new persona brief, from an empty vault
// ---------------------------------------------------------------------------
describe('persona unclamp — fresh clone (empty vault)', () => {
  let dir, fsStore, store, identity, bus;

  beforeEach(async function() {
    dir = tempVaultDir(); // no persona.json, no self.md — a genuine fresh clone
    bus = fakeBus();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config: fakeConfig(), fs: fsStore, identityStore: store });
    await identity.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('a fresh/empty vault yields the unclamped dials, not the old blend', () => {
    assert.deepEqual(identity.getPersonaLevels(), {
      humor: 8, warmth: 7, formality: 5, sass: 7, proactivity: 8, terseness: 5, strictness: 4
    });
  });

  it('humor 8 resolves to the >=8 band ("weave in dry wit freely"), not the >=5 band', () => {
    const p = identity.persona();
    assert.match(p, /Weave in dry wit freely/);
    assert.doesNotMatch(p, /Use dry wit occasionally/);
  });

  it('sass 7 lands on the >=5 band (light teasing), proactivity 8 crosses into the >=8 band (volunteer observations)', () => {
    const p = identity.persona();
    // sass 7 is below the >=8 "pointed sarcasm" band — it's the >=5 band.
    assert.match(p, /A light teasing edge is fine; never disrespectful/);
    assert.doesNotMatch(p, /Push back with pointed, confident sarcasm/);
    // proactivity 8 crosses into "volunteer... in most replies".
    assert.match(p, /Volunteer observations, warnings, and next-step suggestions in most replies/);
  });

  it('terseness stays 5 so speech does not get the "Explain thoroughly" directive', () => {
    // V2 §11 row 3 literally says "terseness 5→4, not 3 — <5 lands on 'Explain
    // thoroughly', which over-swings for speech." That rationale defeats itself:
    // 4 is also <5, so 3 and 4 hit the identical else-branch in
    // styleDirectives() and both emit "Explain thoroughly; detail is welcome."
    // Lowering the dial at all would have shipped exactly what V2 wanted to
    // avoid. So the default stays 5 and this test pins the intent, not the
    // plan's arithmetic slip.
    assert.match(identity.persona(), /Keep replies short; expand only when the matter is complex/);
    assert.doesNotMatch(identity.persona(), /Explain thoroughly; detail is welcome/);
    // The bands themselves are untouched, so the verbose directive is still
    // reachable — it just isn't the shipped default.
    identity.setPersonaLevel('terseness', 4);
    assert.match(identity.persona(), /Explain thoroughly; detail is welcome/);
  });

  it('seeds the new character-brief persona from the tracked SEED_SELF_MD template, not the old flat JARVIS line', () => {
    const raw = store.readRaw();
    assert.match(raw, /## Persona\nYou are MYTHOS/);
    // Distinctive phrases from the new brief that were not in the old
    // one-line-flat persona — proves the tracked template actually shipped,
    // not just that some text exists under the header.
    assert.match(raw, /unhurried/);
    assert.match(raw, /caught bluffing twice/);
    assert.match(raw, /never use markdown, asterisks, or bullet lists/);
  });

  it('STYLE_GUARDRAIL is present in persona() at the fresh-clone default levels', () => {
    assert.match(identity.persona(), /Regardless of style settings.*errors, failures, confirmations, and safety warnings are always delivered plainly/);
  });
});

// ---------------------------------------------------------------------------
// STYLE_GUARDRAIL survives at EVERY dial setting — the safety property that
// makes humor 8 / sass 7 safe to ship. Loop the full 0-10 range per trait.
// ---------------------------------------------------------------------------
describe('persona unclamp — STYLE_GUARDRAIL is byte-present at every dial setting', () => {
  let dir, fsStore, store, identity, bus;
  const GUARDRAIL_RE = /Regardless of style settings: errors, failures, confirmations, and safety warnings are always delivered plainly and directly, with no humor or sass\./;

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config: fakeConfig(), fs: fsStore, identityStore: store });
    await identity.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('every trait at every value 0-10 still carries the guardrail verbatim', () => {
    const traits = ['humor', 'warmth', 'formality', 'sass', 'proactivity', 'terseness', 'strictness'];
    for (const trait of traits) {
      for (let v = 0; v <= 10; v++) {
        identity.setPersonaLevel(trait, v);
        const p = identity.persona();
        assert.match(p, GUARDRAIL_RE, `guardrail missing for ${trait}=${v}`);
      }
      identity.setPersonaLevel(trait, 6); // reset between traits
    }
  });
});

// ---------------------------------------------------------------------------
// Lane-aware brevity (V2 §11 row 1): voice loses "Be concise and
// actionable.", build/simple keep it. Same chain.complete-stubbing pattern
// as the existing P8 identity-persona-injection tests in brain.test.js.
// ---------------------------------------------------------------------------
describe('persona unclamp — lane-aware brevity tail', () => {
  after(function() {
    const spend = require('../src/core/brain/spend');
    spend._reset();
  });

  function captureMessages(lane) {
    const origComplete = chain.complete;
    let capturedMsgs = null;
    chain.complete = function(opts) {
      capturedMsgs = opts.messages;
      const err = new Error('chain exhausted (test)');
      err.chainExhausted = true;
      return Promise.reject(err);
    };
    const identity = { persona: function() { return 'You are MYTHOS. Dry, warm, unhurried.'; } };
    const brain = createBrain({ config: { MYTHOS_NAME: 'MYTHOS' }, bus: null, identity });
    return brain.think({ lane, messages: [{ role: 'user', content: 'hi' }] })
      .then(function() { chain.complete = origComplete; return capturedMsgs; })
      .catch(function(err) { chain.complete = origComplete; throw err; });
  }

  it('voice lane gets NO "Be concise and actionable." tail', async () => {
    const msgs = await captureMessages('voice');
    assert.equal(msgs[0].role, 'system');
    assert.ok(msgs[0].content.startsWith('You are MYTHOS. Dry, warm, unhurried.'));
    assert.equal(msgs[0].content.indexOf('Be concise and actionable.'), -1, 'voice lane must not carry the actionability tail');
  });

  it('build lane still gets "Be concise and actionable."', async () => {
    const msgs = await captureMessages('build');
    assert.ok(msgs[0].content.indexOf('Be concise and actionable.') !== -1, 'build lane must keep the actionability tail');
  });

  it('simple lane still gets "Be concise and actionable."', async () => {
    const msgs = await captureMessages('simple');
    assert.ok(msgs[0].content.indexOf('Be concise and actionable.') !== -1, 'simple lane must keep the actionability tail');
  });
});
