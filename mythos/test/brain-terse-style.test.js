'use strict';

// test/brain-terse-style.test.js — BRAIN_TERSE_LANES.
//
// The terse ("caveman") style layer cuts output tokens on prose. It is scoped
// per lane precisely because the wrong scope is expensive in a different
// currency: applied to 'voice' it makes the entity SOUND broken, and applied to
// 'build' it truncates generated source. So the tests worth having are the ones
// about scope and opt-out, not about the wording of the directive.
//
// Same chain.complete monkey-patch as brain.test.js's persona-injection block:
// capture the assembled messages, reject with chainExhausted, restore.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createBrain } = require('../src/core/brain/index');
const { TERSE_STYLE } = require('../src/core/brain/style-terse');
const chain = require('../src/core/brain/chain');

// Runs one think() with chain.complete stubbed, and hands back the messages it
// was called with. Always restores, including on failure.
async function captureMessages(brainOpts, thinkOpts) {
  let captured = null;
  const orig = chain.complete;
  chain.complete = function(opts) {
    captured = opts.messages;
    const err = new Error('chain exhausted (test)');
    err.chainExhausted = true;
    return Promise.reject(err);
  };
  try {
    await createBrain(Object.assign({ bus: null }, brainOpts)).think(thinkOpts);
  } finally {
    chain.complete = orig;
  }
  return captured || [];
}

const hasTerse = (msgs) => msgs.some((m) => m.role === 'system' && m.content === TERSE_STYLE);

describe('BRAIN_TERSE_LANES', function() {
  it('injects the terse style on a configured lane', async function() {
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: 'simple' } },
      { lane: 'simple', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(hasTerse(msgs), 'expected the terse system message on lane simple');
  });

  it('leaves the spoken voice lane alone even when other lanes are terse', async function() {
    // The default config ships 'simple' only, but someone will eventually try
    // adding lanes here. This pins the reason 'voice' must not be one of them:
    // it is read aloud, and clipped fragments sound like a fault, not brevity.
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: 'simple' } },
      { lane: 'voice', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!hasTerse(msgs), 'the voice lane must never carry the terse style');
  });

  it('a caller can opt out per call, for a spoken path on a terse lane', async function() {
    // This is what the boot greeting and the immune explainer do: both use lane
    // 'simple' and both are spoken by proactiveSpeak().
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: 'simple' } },
      { lane: 'simple', terse: false, messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!hasTerse(msgs), 'terse:false must suppress the style');
  });

  it('is off entirely when BRAIN_TERSE_LANES is empty or absent', async function() {
    const empty = await captureMessages(
      { config: { BRAIN_TERSE_LANES: '' } },
      { lane: 'simple', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!hasTerse(empty));
    const absent = await captureMessages(
      { config: {} },
      { lane: 'simple', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!hasTerse(absent));
  });

  it('does not displace a schemaHint — the output contract still comes first', async function() {
    // The style directive says the contract wins; the message ORDER has to
    // agree with it, or a terse model has two instructions and no ranking.
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: 'simple' } },
      { lane: 'simple', schemaHint: '{ "answer": string }', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(hasTerse(msgs));
    const schemaIdx = msgs.findIndex((m) => String(m.content).includes('"answer"'));
    const userIdx = msgs.findIndex((m) => m.role === 'user');
    assert.ok(schemaIdx !== -1, 'schemaHint must survive the terse injection');
    assert.ok(schemaIdx < userIdx, 'schemaHint must still precede the user turn');
  });

  it('the directive protects code and error text from compression', async function() {
    // Load-bearing wording, not decoration: this repo's evidence contract needs
    // error strings and tool payloads to round-trip verbatim.
    assert.match(TERSE_STYLE, /BYTE-FOR-BYTE/);
    assert.match(TERSE_STYLE, /error messages/i);
  });
});
