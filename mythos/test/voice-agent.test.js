'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createVoiceAgent, _internal } = require('../src/core/voice/voice-agent');

describe('voice-agent buildPrompt — JARVIS persona + intake state', () => {
  it('RULES carry the JARVIS persona and all three governing rules', () => {
    const p = _internal.buildPrompt({ text: 'hi' });
    assert.match(p, /You are JARVIS/);
    assert.match(p, /PROACTIVE SUGGESTION RULE/);
    assert.match(p, /DANGER TOOLS RULE/);
    assert.match(p, /PROJECT INTAKE RULE/);
  });

  it('OUTPUT_CONTRACT is unchanged (single JSON object, say/actions/needs_result)', () => {
    const p = _internal.buildPrompt({ text: 'hi' });
    assert.match(p, /Respond with ONLY a single JSON object/);
    assert.match(p, /"say":[\s\S]*"actions":[\s\S]*"needs_result": false/);
  });

  it('injects the authoritative INTAKE STATE block and the question-limit line at the cap', () => {
    const p = _internal.buildPrompt({ text: 'a game', intake: { state: 'clarifying', questionsAsked: 3, maxQuestions: 3, spec: 'a chess game' } });
    assert.match(p, /INTAKE STATE \(server-tracked/);
    assert.match(p, /questions asked so far: 3 of 3/);
    assert.match(p, /YOU HAVE REACHED THE QUESTION LIMIT/);
  });

  it('omits the intake block when idle', () => {
    // (RULES itself mentions an "INTAKE STATE block"; the injected block's unique
    // marker is the live question count, which must be absent when idle.)
    const p = _internal.buildPrompt({ text: 'hi', intake: { state: 'idle' } });
    assert.doesNotMatch(p, /questions asked so far/);
  });
});

describe('voice-agent handleUtterance — cap backstop + goalId scoping', () => {
  function brainReturning(sequence) {
    let i = 0;
    return { think: async () => { const r = sequence[Math.min(i, sequence.length - 1)]; i++; return r; }, _count: () => i };
  }
  function parsed(say, actions) { const obj = { say, actions: actions || [], needs_result: false }; return { parsed: obj, content: JSON.stringify(obj), offline: false }; }

  it('forces a re-prompt when the model asks past the question cap', async () => {
    const brain = brainReturning([
      parsed('And what colour scheme, Sir?', []),   // another question — over the cap
      parsed('Plan: a red chess game. Shall I proceed?', []),
    ]);
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const agent = createVoiceAgent({ brain, leash, dispatch: async () => ({ ok: true, result: {} }), bus: fakeBus() });
    const res = await agent.handleUtterance({ text: 'chess', ctx: { intake: { state: 'clarifying', questionsAsked: 3, maxQuestions: 3, spec: 'chess' } } });
    assert.equal(brain._count(), 2, 'cap backstop fired a second call');
    assert.match(res.say, /Shall I proceed/);
  });

  it('scopes goalId to INTAKE_GATED tools only', async () => {
    const checkCalls = [];
    const leash = { check: (d, ctx) => { checkCalls.push({ tool: d.tool, ctx }); return { allow: true, requireConfirm: false, tier: 3 }; } };
    const agent = createVoiceAgent({ brain: brainReturning([parsed('Starting.', [{ tool: 'start_project', args: { description: 'x' } }])]), leash, dispatch: async () => ({ ok: true, result: {} }), bus: fakeBus() });
    await agent.handleUtterance({ text: 'go', ctx: { goalId: 'g1', intake: null } });
    assert.deepEqual(checkCalls[0].ctx, { goalId: 'g1' }, 'intake-gated tool carries goalId');

    const checkCalls2 = [];
    const leash2 = { check: (d, ctx) => { checkCalls2.push({ tool: d.tool, ctx }); return { allow: true, requireConfirm: false, tier: 3 }; } };
    const agent2 = createVoiceAgent({ brain: brainReturning([parsed('Deleting.', [{ tool: 'delete_goal', args: { query: 'groceries' } }])]), leash: leash2, dispatch: async () => ({ ok: true, result: {} }), bus: fakeBus() });
    await agent2.handleUtterance({ text: 'delete groceries', ctx: { goalId: 'g1', intake: null } });
    assert.deepEqual(checkCalls2[0].ctx, {}, 'non-gated tool gets empty goalCtx (no cross-goal grant leak)');
  });
});
