'use strict';

// WAVE 8 — a send the operator just asked for out loud is confirmed out loud.
//
// The operator's complaint: the popup is friction on something they explicitly
// asked for. The deeper point from 2026-07-31 is that it was also protecting
// nothing — they approved a Notepad type in the modal and the text went into the
// IDE anyway, because a confirmation gates INTENT while only evidence gates
// OUTCOME. Waves 1 and 2 supply the outcome half, which is why this wave is safe
// to land now and would have been reckless first.
//
// What must NOT change: the leash. Same tier, same confirm.create/accept
// plumbing, same audit trail. Only the UI moves — and only for sends, and only
// for the operator's own voice.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createVoiceAgent } = require('../src/core/voice/voice-agent');

// A leash that confirm-gates exactly the tools named, mirroring the real T3 path.
function fakeLeash(confirmTools) {
  const pending = new Map();
  let n = 0;
  const api = {
    created: [], accepted: [], rejected: [],
    check: (decision) => (confirmTools[decision.tool]
      ? { allow: false, requireConfirm: true, tier: 3 }
      : { allow: true, requireConfirm: false, tier: 1 }),
    confirm: {
      create: (summary, payload, connectionId) => {
        const id = 'c' + (++n);
        pending.set(id, payload);
        api.created.push({ id, summary, payload, connectionId });
        return id;
      },
      accept: (id, connectionId) => {
        api.accepted.push({ id, connectionId });
        const p = pending.get(id);
        pending.delete(id);
        return p || null;
      },
      reject: (id, connectionId) => {
        api.rejected.push({ id, connectionId });
        pending.delete(id);
        return true;
      },
    },
  };
  return api;
}

function agentWith(opts) {
  const o = opts || {};
  const events = [];
  const dispatched = [];
  const leash = o.leash || fakeLeash({ whatsapp_send: true });

  // The brain emits one turn: a whatsapp_send (or whatever the test wants).
  let turn = 0;
  const brain = {
    think: async () => {
      turn++;
      const script = o.turns || [{ say: 'Sending that now.', actions: [{ tool: 'whatsapp_send', args: { to: 'dad', text: 'on my way' } }], needs_result: false }];
      const t = script[Math.min(turn - 1, script.length - 1)];
      return { content: JSON.stringify(t), parsed: t, offline: false };
    },
  };

  const agent = createVoiceAgent({
    brain,
    leash,
    config: o.config || null,
    bus: { emit: (type, payload) => events.push({ type, payload }), subscribe: () => () => {} },
    dispatch: async (decision) => {
      dispatched.push(decision);
      return o.dispatchResult || { ok: true, result: { sent: true } };
    },
    // The catalog is derived from the hub, not passed in — a hub-less agent falls
    // back to the module CATALOG, which does not carry whatsapp_send, and every
    // action would come back "Unknown tool".
    hub: {
      catalog: () => [
        { name: 'whatsapp_send', description: 'send a whatsapp', params: { to: 'string', text: 'string' } },
        { name: 'delete_file', description: 'delete a file', params: { path: 'string' } },
      ],
    },
  });

  return { agent, events, dispatched, leash };
}

describe('WAVE 8 — spoken confirm for operator-initiated sends', () => {
  it('a voice-initiated send speaks the recipient and exact text, and shows NO modal', async () => {
    const { agent, events } = agentWith();
    const res = await agent.handleUtterance({ text: 'whatsapp dad that I am on my way', ctx: { channel: 'voice', connectionId: 'ws1' } });

    assert.deepEqual(events.filter((e) => e.type === 'confirm-request'), [],
      'no confirm-request means no HUD modal — that is the whole point of the wave');
    assert.match(res.say, /dad/, 'the operator confirms a real recipient, not a tool name');
    assert.match(res.say, /on my way/, 'and the real text');
    assert.match(res.say, /say send/i, 'and must be told how to accept');
    assert.ok(res.confirmPending, 'the action is still gated — it has not been sent');
  });

  it('the leash is untouched: the same confirm is created at the same tier', async () => {
    const { agent, leash } = agentWith();
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.equal(leash.created.length, 1, 'confirm.create still runs — this is a UI change, not a policy change');
    assert.equal(leash.created[0].payload.tier, 3);
  });

  it('"send it" on the next utterance actually sends, through leash.confirm.accept', async () => {
    const { agent, dispatched, leash } = agentWith();
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.deepEqual(dispatched, [], 'nothing dispatched while pending');

    const res = await agent.handleUtterance({ text: 'send it', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.equal(leash.accepted.length, 1, 'it must go through the real accept path, for the session grant and audit');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].tool, 'whatsapp_send');
    assert.match(res.say, /^Sent\.?$/i);
  });

  it('a decline word cancels it and nothing is sent', async () => {
    const { agent, dispatched, leash } = agentWith();
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    const res = await agent.handleUtterance({ text: "no, don't", ctx: { channel: 'voice', connectionId: 'ws1' } });

    assert.deepEqual(dispatched, []);
    assert.equal(leash.rejected.length, 1);
    assert.match(res.say, /not sent/i);
  });

  it('an unrelated utterance SUPERSEDES the pending send rather than leaving it armed', async () => {
    // A stale send accepted three turns later by a stray "yes" is exactly the
    // class of accident this plan exists to remove.
    const { agent, dispatched, leash } = agentWith({
      turns: [
        { say: 'Sending.', actions: [{ tool: 'whatsapp_send', args: { to: 'dad', text: 'hi' } }], needs_result: false },
        { say: 'The time is late.', actions: [], needs_result: false },
        { say: 'Sure.', actions: [], needs_result: false },
      ],
    });
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    await agent.handleUtterance({ text: 'what time is it', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.equal(leash.rejected.length, 1, 'the pending send must be dropped, not parked');

    await agent.handleUtterance({ text: 'yes', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.deepEqual(dispatched, [], 'a later "yes" must not resurrect it');
  });

  it('an EXPIRED confirm sends nothing, even on a clear "send it"', async () => {
    // Real expiry, via the configurable TTL — not a stand-in assertion.
    const { agent, dispatched, leash } = agentWith({
      config: { VOICE_SPOKEN_CONFIRM_TTL_MS: 1 },
      turns: [
        { say: 'Sending.', actions: [{ tool: 'whatsapp_send', args: { to: 'dad', text: 'hi' } }], needs_result: false },
        { say: 'Nothing is pending.', actions: [], needs_result: false },
      ],
    });
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.equal(leash.created.length, 1, 'precondition: a confirm was armed');

    await new Promise((r) => setTimeout(r, 20)); // outlive the 1ms TTL

    await agent.handleUtterance({ text: 'send it', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.deepEqual(dispatched, [], 'an expired confirm must never dispatch');
    assert.equal(leash.accepted.length, 0, 'and must not be accepted');
    assert.equal(leash.rejected.length, 1, 'it is explicitly released, not left dangling in the registry');
  });

  it('a NON-send T3 tool still uses the modal', async () => {
    const { agent, events, leash } = agentWith({
      leash: fakeLeash({ delete_file: true }),
      turns: [{ say: 'Deleting.', actions: [{ tool: 'delete_file', args: { path: 'x.txt' } }], needs_result: false }],
    });
    const res = await agent.handleUtterance({ text: 'delete x.txt', ctx: { channel: 'voice', connectionId: 'ws1' } });

    const modal = events.filter((e) => e.type === 'confirm-request');
    assert.equal(modal.length, 1, 'a destructive local change deserves a deliberate click, not a spoken "yes"');
    assert.equal(leash.created.length, 1);
    assert.ok(!/say send/i.test(res.say || ''));
  });

  it('a send from a NON-operator channel keeps the modal', async () => {
    // cortex / engagements / goals must never get the spoken path, whatever tier
    // arithmetic says. (They are additionally capped at AUTONOMOUS_MAX_TIER=2.)
    const { agent, events } = agentWith();
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'cortex', connectionId: 'ws1' } });
    assert.equal(events.filter((e) => e.type === 'confirm-request').length, 1);
  });

  it('an ABSENT channel falls back to the modal (fail safe, not fail open)', async () => {
    const { agent, events } = agentWith();
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { connectionId: 'ws1' } });
    assert.equal(events.filter((e) => e.type === 'confirm-request').length, 1,
      'an unknown caller must not inherit the operator\'s spoken privilege');
  });

  it('an accepted send whose outcome is unverified is NOT reported as sent', async () => {
    // Wave 0's contract does not bend because a human said yes.
    const { agent } = agentWith({
      dispatchResult: { ok: true, unverified: true, reason: 'WhatsApp never confirmed the message left the box' },
    });
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    const res = await agent.handleUtterance({ text: 'send', ctx: { channel: 'voice', connectionId: 'ws1' } });

    assert.match(res.say, /couldn't confirm|could not confirm/i);
    assert.match(res.say, /never confirmed/i);
    assert.ok(!/^Sent\.$/i.test(res.say), 'a bare "Sent." would be the old lie with a human co-signature');
  });

  it('a send that fails after acceptance says so plainly', async () => {
    const { agent } = agentWith({ dispatchResult: { ok: false, result: 'WhatsApp is not running' } });
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    const res = await agent.handleUtterance({ text: 'send it', ctx: { channel: 'voice', connectionId: 'ws1' } });
    assert.match(res.say, /didn't send/i);
    assert.match(res.say, /not running/i);
  });

  it('the pending confirm is per connection — another connection cannot accept it', async () => {
    const { agent, dispatched } = agentWith({
      turns: [
        { say: 'Sending.', actions: [{ tool: 'whatsapp_send', args: { to: 'dad', text: 'hi' } }], needs_result: false },
        { say: 'Nothing to send.', actions: [], needs_result: false },
      ],
    });
    await agent.handleUtterance({ text: 'whatsapp dad hi', ctx: { channel: 'voice', connectionId: 'ws1' } });
    await agent.handleUtterance({ text: 'send it', ctx: { channel: 'voice', connectionId: 'ws2' } });
    assert.deepEqual(dispatched, [], 'ws2 saying "send it" must not send ws1\'s message');
  });
});
