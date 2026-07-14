'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createProactiveSpeech } = require('../src/core/voice/proactive-speech');
const { splitSentences } = require('../src/core/effectors/voice');
const { sanitizeSpoken } = require('../src/core/voice/spoken-text');

function harness(opts) {
  opts = opts || {};
  const bus = fakeBus();
  const sent = [];
  const edgeTts = {
    isAvailable: async () => opts.ttsUp !== false,
    synthesize: async () => Buffer.from('fake-audio'),
  };
  const config = { PROACTIVE_SPEECH: opts.mute ? false : true, PROACTIVE_SPEECH_MAX_CHARS: 400, VOICE_TTS_VOICE: 'x' };
  const ps = createProactiveSpeech({
    config, edgeTts, sanitizeSpoken, splitSentences,
    logger: { warn() {} }, broadcastAll: (m) => sent.push(m), bus,
  });
  return { ps, sent, bus };
}

describe('proactive-speech — server-initiated speak-push', () => {
  it('broadcasts one chunk per sentence then a final done', async () => {
    const { ps, sent } = harness();
    const res = await ps.speak('First sentence here. Second sentence here.', { kind: 'completion', relatedId: 'j1' });
    assert.equal(res.ok, true);
    const chunks = sent.filter((m) => m.type === 'speak-push' && !m.done);
    const dones = sent.filter((m) => m.type === 'speak-push' && m.done);
    assert.ok(chunks.length >= 1);
    assert.equal(dones.length, 1);
    assert.equal(dones[0].chunked, true);
    assert.equal(dones[0].relatedId, 'j1');
    assert.ok(chunks.every((c) => c.audioB64));
  });

  it('muted config skips entirely', async () => {
    const { ps, sent } = harness({ mute: true });
    const res = await ps.speak('anything');
    assert.equal(res.skipped, true);
    assert.equal(sent.length, 0);
  });

  it('empty text is skipped', async () => {
    const { ps, sent } = harness();
    const res = await ps.speak('   ');
    assert.equal(res.skipped, true);
    assert.equal(sent.length, 0);
  });

  it('TTS unavailable sends only the final done (chunked:false), never throws', async () => {
    const { ps, sent } = harness({ ttsUp: false });
    await assert.doesNotReject(ps.speak('hello there. how are you.'));
    const chunks = sent.filter((m) => !m.done);
    const dones = sent.filter((m) => m.done);
    assert.equal(chunks.length, 0);
    assert.equal(dones.length, 1);
    assert.equal(dones[0].chunked, false);
  });

  it('truncates to PROACTIVE_SPEECH_MAX_CHARS and emits action.speak-requested', async () => {
    const { ps, bus } = harness();
    await ps.speak('x'.repeat(1000));
    const evt = bus._lastEvent('action.speak-requested');
    assert.ok(evt);
    assert.ok(evt.payload.text.length <= 400);
  });
});
