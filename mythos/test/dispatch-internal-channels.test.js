'use strict';

// dispatch-internal-channels.test.js — the entity must not remember its own
// plumbing as if it were something that happened.
//
// THE INCIDENT (operator, 2026-08-11, installed 0.1.2). Asked "how's it going",
// MYTHOS answered "Volume's at 15 now". Asked why, it said "because you keep
// setting it there". The operator had never touched the volume: the packaged
// build ducks system volume at every mic-hot boundary, and with music playing
// that ducking oscillated — 58 set_volume rows in one session, every one
// channel:'voice-ducking'. Each was ALSO written to episodic memory, and
// server/index.js recalls 12 recent memories per turn, so the entity's own
// microphone plumbing crowded out the conversation and became the thing it had
// to talk about.
//
// The audit trail must survive that fix intact — it is what an operator greps
// when they ask "why did my volume move" — so the two writes deliberately
// diverge: audit always, episodic never, for an internal channel.
//
// Run: cd mythos && node --test test/dispatch-internal-channels.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { createBus } = require('../src/core/bus');

function harness() {
  const episodicWrites = [];
  const auditWrites = [];
  return {
    episodicWrites,
    auditWrites,
    ctx: {
      bus: createBus({ historySize: 10 }),
      effectors: { invoke: async () => ({ ok: true, result: { level: 15 } }) },
      memory: {
        episodic: { write: async (e) => { episodicWrites.push(e); return { ref: 'ep-1' }; } },
        audit: { write: (e) => { auditWrites.push(e); } },
      },
      config: { ACTION_TIMEOUT_MS: 30000 },
    },
  };
}

describe('internal channels are audited but not remembered', () => {
  it('a voice-ducking volume change writes an audit line and NO episodic entry', async () => {
    const h = harness();
    await dispatchAction({ tool: 'set_volume', args: { level: 15 } }, { ...h.ctx, tier: 2, channel: 'voice-ducking' });
    assert.equal(h.auditWrites.length, 1, 'the audit trail is how a volume investigation is done — it must stay');
    assert.equal(h.auditWrites[0].actor, 'voice-ducking');
    assert.equal(h.auditWrites[0].tool, 'set_volume');
    assert.equal(h.episodicWrites.length, 0,
      'ducking its own microphone is not an experience — an episodic row here is what made the entity answer '
      + '"how is it going" with "Volume\'s at 15 now"');
  });

  it('an operator-driven volume change is still remembered normally', async () => {
    const h = harness();
    await dispatchAction({ tool: 'set_volume', args: { level: 80 } }, { ...h.ctx, tier: 2, channel: 'voice' });
    assert.equal(h.auditWrites.length, 1);
    assert.equal(h.episodicWrites.length, 1,
      'only the internal channel is filtered — a volume change the operator asked for is a real event');
    assert.equal(h.episodicWrites[0].channel, 'voice');
  });

  it('the default channel (cortex) is unaffected', async () => {
    const h = harness();
    await dispatchAction({ tool: 'set_volume', args: {} }, { ...h.ctx, tier: 0 });
    assert.equal(h.episodicWrites.length, 1);
    assert.equal(h.episodicWrites[0].channel, 'cortex');
  });

  // TASK B2 code review (2026-08-13): the boot briefing dispatches get_weather
  // and reminder_list every boot through this same sequence, for the same
  // plumbing-not-experience reason as voice-ducking above — an episodic row
  // per boot for "checked the weather" would crowd the same recall window.
  it('a boot-briefing read (e.g. get_weather) writes an audit line and NO episodic entry', async () => {
    const h = harness();
    await dispatchAction({ tool: 'get_weather', args: {} }, { ...h.ctx, tier: 0, channel: 'boot-briefing' });
    assert.equal(h.auditWrites.length, 1);
    assert.equal(h.auditWrites[0].actor, 'boot-briefing');
    assert.equal(h.episodicWrites.length, 0,
      'a boot-time weather/reminder lookup is plumbing for the greeting, not a remembered event');
  });
});
