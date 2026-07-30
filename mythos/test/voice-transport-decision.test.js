'use strict';
// test/voice-transport-decision.test.js — pure node:test coverage for
// decideVoiceTransport(), the mic-exclusivity decision that routes a voice
// toggle to EITHER the S2S bridge (ui/public/js/voice/s2s-bridge.js) or the
// batch-STT loop (ui/public/js/voice/voice-loop.js), never both.
//
// Same extraction pattern as test/voice-barge-in-decision.test.js: the DOM /
// getUserMedia / AudioWorklet shell stays in app.js, the decision lives in a
// plain ES module that Node can dynamic-import with no bundler and no jsdom.
//
// The load-bearing invariant this file exists to guard: VOICE_S2S_ENABLED
// defaults to FALSE, and in that case the toggle MUST land on the mature
// batch loop, unchanged. And whichever transport is chosen, the other one is
// never left holding the microphone.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const TRANSPORT_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-transport.js')
).href;

describe('decideVoiceTransport (mic exclusivity, S2S vs batch)', () => {
  it('flag OFF (the default) from a cold idle HUD: starts the batch loop, touches nothing else', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: false, s2sActive: false, batchActive: false }),
      { transport: 'batch', action: 'start', stopOther: null }
    );
  });

  it('flag OFF with the batch loop already listening: stops it (plain toggle, no S2S involvement)', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: false, s2sActive: false, batchActive: true }),
      { transport: 'batch', action: 'stop', stopOther: null }
    );
  });

  it('flag ON from a cold idle HUD: starts S2S instead of the batch loop', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: true, s2sActive: false, batchActive: false }),
      { transport: 's2s', action: 'start', stopOther: null }
    );
  });

  it('flag ON while the batch loop holds the mic: S2S starts ONLY after batch is told to stop', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: true, s2sActive: false, batchActive: true }),
      { transport: 's2s', action: 'start', stopOther: 'batch' }
    );
  });

  it('flag ON with S2S already open: stops S2S', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: true, s2sActive: true, batchActive: false }),
      { transport: 's2s', action: 'stop', stopOther: null }
    );
  });

  it('flag flipped OFF while an S2S session is still open: the batch start must release S2S first', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: false, s2sActive: true, batchActive: false }),
      { transport: 'batch', action: 'start', stopOther: 's2s' }
    );
  });

  it('both transports somehow active (a bug elsewhere): a toggle stops BOTH, never leaves one on the mic', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: true, s2sActive: true, batchActive: true }),
      { transport: 's2s', action: 'stop', stopOther: 'batch' }
    );
    assert.deepEqual(
      decideVoiceTransport({ s2sEnabled: false, s2sActive: true, batchActive: true }),
      { transport: 'batch', action: 'stop', stopOther: 's2s' }
    );
  });

  it('missing/undefined inputs are treated as "off" — a config fetch that never resolved must not silently enable S2S', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    assert.deepEqual(
      decideVoiceTransport({}),
      { transport: 'batch', action: 'start', stopOther: null }
    );
    assert.deepEqual(
      decideVoiceTransport(),
      { transport: 'batch', action: 'start', stopOther: null }
    );
  });

  it('never returns a plan in which the chosen transport is also the one to stop', async () => {
    const { decideVoiceTransport } = await import(TRANSPORT_URL);
    for (const s2sEnabled of [false, true]) {
      for (const s2sActive of [false, true]) {
        for (const batchActive of [false, true]) {
          const plan = decideVoiceTransport({ s2sEnabled, s2sActive, batchActive });
          assert.notEqual(plan.stopOther, plan.transport,
            `stopOther must never equal transport (${JSON.stringify({ s2sEnabled, s2sActive, batchActive })})`);
          assert.ok(plan.transport === 's2s' || plan.transport === 'batch');
          assert.ok(plan.action === 'start' || plan.action === 'stop');
        }
      }
    }
  });
});
