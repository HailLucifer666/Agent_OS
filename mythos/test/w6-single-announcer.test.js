'use strict';
// W6 regression: exactly ONE announcer speaks on health.diagnosed.
// Pre-W6 both immune/announcer and conversation/announcer subscribed to
// health.diagnosed — every diagnosis was spoken twice. W6 made
// conversation/announcer the single speaker; immune/announcer kept heal and
// crash-recovery speech only.
//
// 2026-09-23, BUG-447 (operator decision D5): immune/announcer is DELETED — a
// successful heal and a crash recovery are no longer spoken at all. The W6
// invariant (one speaker per diagnosis) is unchanged and still pinned below; the
// two cases that pinned heal/recovery SPEECH now pin its absence.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');

function fakeBrainOnline() {
  // Always-online brain so generate() returns its content; predictable for assertions.
  return { think: async () => ({ content: 'spoken text', offline: false }) };
}

describe('W6: single speaker for health.diagnosed', () => {
  it('a critical diagnosis is spoken exactly once', async () => {
    const bus = createBus({ historySize: 50 });
    const speakCalls = [];
    const convoAnnouncer = createConversationAnnouncer({
      bus, brain: fakeBrainOnline(), speak: (text) => { speakCalls.push(text); return Promise.resolve(); },
    });
    convoAnnouncer.start();
    bus.emit('health.diagnosed', { kind: 'cortex-stall', target: 'tick-loop', severity: 'critical' });
    await new Promise((r) => setTimeout(r, 30));
    convoAnnouncer.stop();
    assert.equal(speakCalls.length, 1,
      'health.diagnosed must be spoken exactly once (got ' + speakCalls.length + ' — double-speak regression?)');
  });

  it('BUG-447: no module speaks a successful heal or a crash recovery any more', async () => {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'core', 'immune', 'announcer.js')), false,
      'the heal speaker is back');
    const bus = createBus({ historySize: 50 });
    const spoken = [];
    const convoAnnouncer = createConversationAnnouncer({
      bus, brain: fakeBrainOnline(), speak: (t) => { spoken.push(t); return Promise.resolve(); },
    });
    convoAnnouncer.start();
    bus.emit('health.healed', { playbookId: 'stall-restart', outcome: 'applied' });
    bus.emit('lifecycle.recovered', {});
    await new Promise((r) => setTimeout(r, 30));
    convoAnnouncer.stop();
    assert.deepEqual(spoken, [], 'the remaining announcer must not pick up heal or recovery speech');
  });
});
