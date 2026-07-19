'use strict';
// W6 regression: exactly ONE announcer speaks on health.diagnosed.
// Pre-W6 both immune/announcer and conversation/announcer subscribed to
// health.diagnosed — every diagnosis was spoken twice. W6 makes
// conversation/announcer the single speaker; immune/announcer keeps
// breaker/heal lifecycle speech only.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createAnnouncer } = require('../src/core/immune/announcer');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');

function fakeBrainOnline() {
  // Always-online brain so generate() returns its content; predictable for assertions.
  return { think: async () => ({ content: 'spoken text', offline: false }) };
}

describe('W6: single speaker for health.diagnosed', () => {
  it('a critical diagnosis is spoken exactly once across both announcers', async () => {
    const bus = createBus({ historySize: 50 });
    const speakCalls = [];
    const track = () => (text) => { speakCalls.push(text); return Promise.resolve(); };

    const immuneAnnouncer = createAnnouncer({ bus, speak: track() });
    const convoAnnouncer = createConversationAnnouncer({
      bus, brain: fakeBrainOnline(), speak: track()
    });
    immuneAnnouncer.start();
    convoAnnouncer.start();

    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: 'tick-loop', severity: 'critical' });
    // Both announcers' speak paths are async (conversation/announcer generates via brain.think).
    await new Promise((r) => setTimeout(r, 30));

    immuneAnnouncer.stop();
    convoAnnouncer.stop();

    // Pre-W6 this would have been 2 (one per announcer). Post-W6: exactly 1.
    assert.equal(speakCalls.length, 1,
      'health.diagnosed must be spoken exactly once (got ' + speakCalls.length + ' — double-speak regression?)');
  });

  it('immune/announcer still speaks on health.healed (breaker/heal lifecycle unaffected)', async () => {
    const bus = createBus({ historySize: 50 });
    const spoken = [];
    const announcer = createAnnouncer({
      bus, speak: (t) => { spoken.push(t); return Promise.resolve(); }
    });
    announcer.start();
    bus.emit('health.healed', { playbookId: 'stall-restart', outcome: 'applied' });
    await new Promise((r) => setTimeout(r, 10));
    announcer.stop();
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].indexOf('stall-restart') !== -1);
  });

  it('immune/announcer still speaks on lifecycle.recovered (crash recovery unaffected)', async () => {
    const bus = createBus({ historySize: 50 });
    const spoken = [];
    const announcer = createAnnouncer({
      bus, speak: (t) => { spoken.push(t); return Promise.resolve(); }
    });
    announcer.start();
    bus.emit('lifecycle.recovered', {});
    await new Promise((r) => setTimeout(r, 10));
    announcer.stop();
    assert.equal(spoken.length, 1);
    assert.ok(spoken[0].indexOf('Recovered') !== -1);
  });
});
