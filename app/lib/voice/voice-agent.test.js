// voice-agent.test.js — the voice brain's JSON tool loop, with a stubbed model chain.
//
// The chain is stubbed by monkey-patching lib/models/chain.js's exported `complete` function
// in place (Node module singleton semantics — voice-agent.js holds a reference to the same
// exports object). This avoids network calls / real model dependency entirely. Chain-internal
// behavior (provider ranking, cooldowns, key rotation) is covered by models/chain.test.js —
// this file only proves voice-agent.js's own JSON tool loop against whatever text the chain
// hands back.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('../test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const chain = require('../models/chain');
const voiceAgent = require('./voice-agent');
const confirm = require('./confirm');

describe('voice-agent.js', () => {
  let originalComplete;
  let originalIsAvailable;

  beforeEach(() => {
    originalComplete = chain.complete;
    originalIsAvailable = chain.isAvailable;
  });

  afterEach(() => {
    chain.complete = originalComplete;
    chain.isAvailable = originalIsAvailable;
    rmrf(TMP);
  });

  // ---- transport-agnostic proof ----

  test('handleUtterance is transport-agnostic: works with a plain object, zero WS/socket scaffolding', async () => {
    chain.complete = async () => ({ content: JSON.stringify({ say: 'Hello.', actions: [], needs_result: false }), provider: 'test', model: 'test' });
    // Note: no WebSocket, no mock socket, no reqId anywhere in this call or in voice-agent.js.
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: { dashboard: { route: 'mission-control' } } });
    assert.equal(result.say, 'Hello.');
    assert.deepEqual(result.actions, []);
  });

  // ---- canned-JSON dispatch order ----

  test('executes multiple actions in the array order returned by the model', async () => {
    chain.complete = async () => ({ content: JSON.stringify({
      say: 'Doing two things.',
      actions: [{ tool: 'create_goal', args: { text: 'first' } }, { tool: 'create_goal', args: { text: 'second' } }],
      needs_result: false,
    }), provider: 'test', model: 'test' });
    const result = await voiceAgent.handleUtterance({ text: 'create two goals', ctx: {} });
    assert.equal(result.actions.length, 2);
    assert.equal(result.actions[0].args.text, 'first');
    assert.equal(result.actions[1].args.text, 'second');
    assert.equal(result.actions[0].ok, true);
    assert.equal(result.actions[1].ok, true);
  });

  // ---- malformed JSON: repair-succeeds ----

  test('malformed JSON on first attempt, valid JSON on repair retry -> succeeds, never throws', async () => {
    let call = 0;
    chain.complete = async () => {
      call += 1;
      if (call === 1) return { content: 'not json at all, sorry', provider: 'test', model: 'test' };
      return { content: JSON.stringify({ say: 'Fixed now.', actions: [], needs_result: false }), provider: 'test', model: 'test' };
    };
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: {} });
    assert.equal(call, 2, 'expected exactly one repair retry (2 total calls)');
    assert.equal(result.say, 'Fixed now.');
  });

  // ---- malformed JSON: repair-fails degrades ----

  test('malformed JSON on both attempts -> degrades to {say: rawText, actions: []}, never throws', async () => {
    let call = 0;
    chain.complete = async () => {
      call += 1;
      return { content: `garbage output attempt ${call}`, provider: 'test', model: 'test' };
    };
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: {} });
    assert.equal(call, 2, 'expected exactly one repair retry (2 total calls) before degrading');
    assert.match(result.say, /garbage output attempt 2/);
    assert.deepEqual(result.actions, []);
  });

  test('fence-wrapped JSON (```json ... ```) parses correctly without needing repair', async () => {
    let call = 0;
    chain.complete = async () => {
      call += 1;
      return { content: '```json\n' + JSON.stringify({ say: 'Fenced.', actions: [], needs_result: false }) + '\n```', provider: 'test', model: 'test' };
    };
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: {} });
    assert.equal(call, 1, 'fence-wrapped valid JSON should parse on the first attempt');
    assert.equal(result.say, 'Fenced.');
  });

  test('<think> blocks are stripped before JSON parsing', async () => {
    chain.complete = async () => ({ content: `<think>reasoning about the request</think>${JSON.stringify({ say: 'Thought it through.', actions: [], needs_result: false })}`, provider: 'test', model: 'test' });
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: {} });
    assert.equal(result.say, 'Thought it through.');
  });

  // ---- iteration cap ----

  test('a stubbed LLM that always returns needs_result:true is force-stopped at exactly 4 calls, not 5', async () => {
    let call = 0;
    chain.complete = async () => {
      call += 1;
      return { content: JSON.stringify({ say: `Iteration ${call}.`, actions: [{ tool: 'read_status', args: {} }], needs_result: true }), provider: 'test', model: 'test' };
    };
    await voiceAgent.handleUtterance({ text: 'keep going forever', ctx: {} });
    assert.equal(call, voiceAgent.MAX_ITERATIONS);
    assert.equal(call, 4);
  });

  // ---- danger-tool: no execution, confirm.create called ----

  test('a danger:true tool is NOT executed — confirm.create is called instead, action never invoked', async () => {
    const dashboardTools = require('./tools-dashboard');
    let deleteGoalCalled = false;
    const originalDeleteGoal = dashboardTools.delete_goal;
    const originalToolFn = voiceAgent.TOOL_REGISTRY.get('delete_goal').fn;
    voiceAgent.TOOL_REGISTRY.get('delete_goal').fn = (...args) => {
      deleteGoalCalled = true;
      return originalToolFn(...args);
    };

    let confirmCreateCalled = false;
    const originalCreate = confirm.create;
    confirm.create = (summary, action) => {
      confirmCreateCalled = true;
      return originalCreate(summary, action);
    };

    try {
      chain.complete = async () => ({ content: JSON.stringify({
        say: 'Deleting the goal about tests.',
        actions: [{ tool: 'delete_goal', args: { query: 'tests' } }],
        needs_result: false,
      }), provider: 'test', model: 'test' });
      const result = await voiceAgent.handleUtterance({ text: 'delete the goal about tests', ctx: {} });

      assert.equal(deleteGoalCalled, false, 'the underlying delete_goal tool function must never be invoked');
      assert.equal(confirmCreateCalled, true, 'confirm.create must be called for a danger:true tool');
      assert.ok(result.confirmPending, 'result must carry a confirmPending marker');
      assert.equal(result.actions[0].confirmPending, true);
      assert.equal(typeof result.actions[0].confirmId, 'string');
    } finally {
      voiceAgent.TOOL_REGISTRY.get('delete_goal').fn = originalToolFn;
      confirm.create = originalCreate;
      void dashboardTools; void originalDeleteGoal;
    }
  });

  test('danger-tier action stops the turn: subsequent actions in the same response are not executed', async () => {
    let killSessionCalled = false;
    const originalKillFn = voiceAgent.TOOL_REGISTRY.get('kill_session').fn;
    voiceAgent.TOOL_REGISTRY.get('kill_session').fn = (...args) => {
      killSessionCalled = true;
      return originalKillFn(...args);
    };
    let createGoalCalled = false;
    const originalCreateGoalFn = voiceAgent.TOOL_REGISTRY.get('create_goal').fn;
    voiceAgent.TOOL_REGISTRY.get('create_goal').fn = (...args) => {
      createGoalCalled = true;
      return originalCreateGoalFn(...args);
    };

    try {
      chain.complete = async () => ({ content: JSON.stringify({
        say: 'Killing session then creating a goal.',
        actions: [{ tool: 'kill_session', args: { pid: 123, agentCli: 'claude' } }, { tool: 'create_goal', args: { text: 'after' } }],
        needs_result: false,
      }), provider: 'test', model: 'test' });
      const result = await voiceAgent.handleUtterance({ text: 'kill it and add a goal', ctx: {} });
      assert.equal(killSessionCalled, false, 'kill_session must be confirm-gated, not executed');
      assert.equal(createGoalCalled, false, 'the action AFTER a danger-gated action must not run this turn');
      assert.equal(result.actions.length, 1, 'only the danger-gated action should appear in the result — the turn stops there');
    } finally {
      voiceAgent.TOOL_REGISTRY.get('kill_session').fn = originalKillFn;
      voiceAgent.TOOL_REGISTRY.get('create_goal').fn = originalCreateGoalFn;
    }
  });

  // ---- per-invocation danger override (pipeline_advance's "reject" action) ----

  test('pipeline_advance with action:"reject" is confirm-gated even though the tool itself is danger:false', async () => {
    const dashboardTools = require('./tools-dashboard');
    let pipelineAdvanceCalled = false;
    const originalFn = dashboardTools.pipeline_advance;
    voiceAgent.TOOL_REGISTRY.get('pipeline_advance').fn = (...args) => {
      pipelineAdvanceCalled = true;
      return originalFn(...args);
    };

    try {
      chain.complete = async () => ({ content: JSON.stringify({
        say: 'Rejecting the card.',
        actions: [{ tool: 'pipeline_advance', args: { query: 'some card', action: 'reject' } }],
        needs_result: false,
      }), provider: 'test', model: 'test' });
      const result = await voiceAgent.handleUtterance({ text: 'reject that pipeline card', ctx: {} });
      assert.equal(pipelineAdvanceCalled, false, 'reject must be confirm-gated, never executed directly');
      assert.ok(result.confirmPending, 'reject must produce a confirmPending result');
    } finally {
      voiceAgent.TOOL_REGISTRY.get('pipeline_advance').fn = originalFn;
    }
  });

  test('pipeline_advance with action:"approve" executes immediately, no confirm gate', async () => {
    const dashboardTools = require('./tools-dashboard');
    let pipelineAdvanceCalled = false;
    const originalFn = dashboardTools.pipeline_advance;
    voiceAgent.TOOL_REGISTRY.get('pipeline_advance').fn = (...args) => {
      pipelineAdvanceCalled = true;
      return originalFn(...args);
    };

    try {
      chain.complete = async () => ({ content: JSON.stringify({
        say: 'Approving the card.',
        actions: [{ tool: 'pipeline_advance', args: { query: 'some card', action: 'approve' } }],
        needs_result: false,
      }), provider: 'test', model: 'test' });
      const result = await voiceAgent.handleUtterance({ text: 'approve that pipeline card', ctx: {} });
      assert.equal(pipelineAdvanceCalled, true, 'approve should execute directly, not be confirm-gated');
      assert.equal(result.confirmPending, null);
    } finally {
      voiceAgent.TOOL_REGISTRY.get('pipeline_advance').fn = originalFn;
    }
  });

  // ---- isAvailable() ----

  test('isAvailable() returns true when the model chain has at least one live entry', async () => {
    chain.isAvailable = async () => true;
    const available = await voiceAgent.isAvailable();
    assert.equal(available, true);
  });

  test('isAvailable() returns false (never throws) when the model chain reports unavailable, or throws', async () => {
    chain.isAvailable = async () => false;
    assert.equal(await voiceAgent.isAvailable(), false);

    chain.isAvailable = async () => { throw new Error('unexpected'); };
    assert.equal(await voiceAgent.isAvailable(), false);
  });

  // ---- abort signal ----

  test('handleUtterance bails out cleanly when the signal is already aborted before the first call', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    chain.complete = async () => { called = true; return { content: '{"say":"x","actions":[]}', provider: 'test', model: 'test' }; };
    const result = await voiceAgent.handleUtterance({ text: 'hello', ctx: {}, signal: controller.signal });
    assert.equal(called, false, 'the model must not be called once the signal is already aborted');
    assert.equal(result.aborted, true);
  });

  // ---- onAction callback ----

  test('onAction is invoked once per executed/confirm-gated action with the result', async () => {
    chain.complete = async () => ({ content: JSON.stringify({
      say: 'Listing goals.',
      actions: [{ tool: 'list_goals', args: {} }],
      needs_result: false,
    }), provider: 'test', model: 'test' });
    const seen = [];
    await voiceAgent.handleUtterance({ text: 'list my goals', ctx: {}, onAction: (r) => seen.push(r) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, 'list_goals');
    assert.equal(seen[0].ok, true);
  });
});
