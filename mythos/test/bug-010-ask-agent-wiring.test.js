'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromDashboard } = require('../src/core/effectors/from-dashboard');

describe('BUG-010: ask_agent wiring verification', () => {
  let dir, hub, bus, dispatchCallCount, dispatchCallArgs;

  before(() => {
    dir = tempVaultDir();
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    // Track how many times the dispatch is called
    dispatchCallCount = 0;
    dispatchCallArgs = [];
  });

  after(() => cleanupVaultDir(dir));

  it('registerFromDashboard exposes setAskAgentDispatch as a public method on returned wiring object', () => {
    const wiring = registerFromDashboard(hub, {});
    assert.ok(wiring, 'registerFromDashboard returns a wiring object');
    assert.equal(typeof wiring.setAskAgentDispatch, 'function', 'wiring has setAskAgentDispatch function');
  });

  it('setAskAgentDispatch stores the dispatch function as a closure and ask_agent uses it', async () => {
    const wiring = registerFromDashboard(hub, {});

    // Wire up a mock dispatch function
    const mockDispatch = async (seat, prompt) => {
      dispatchCallCount++;
      dispatchCallArgs.push({ seat, prompt });
      return `Reply to ${seat}: processed "${prompt}"`;
    };

    wiring.setAskAgentDispatch(mockDispatch);

    // Now call ask_agent via the hub
    const askAgentEffector = hub.get('ask_agent');
    assert.ok(askAgentEffector, 'ask_agent effector is registered');

    const result = await askAgentEffector.invoke({
      seat: 'voice',
      prompt: 'What time is it?'
    });

    assert.equal(result.ok, true, 'ask_agent returned ok:true');
    assert.equal(dispatchCallCount, 1, 'dispatch was called exactly once');
    assert.deepEqual(dispatchCallArgs[0], {
      seat: 'voice',
      prompt: 'What time is it?'
    }, 'dispatch received correct seat and prompt');
    assert.ok(result.result.reply.includes('processed'), 'reply contains the dispatched response');
    assert.ok(result.result.seat === 'voice', 'reply includes the seat');
  });

  it('ask_agent fails gracefully when dispatch is not wired', async () => {
    const wiring2 = registerFromDashboard(hub, {});
    // Do NOT call setAskAgentDispatch, leaving dispatch unwired

    const askAgentEffector = hub.get('ask_agent');
    const result = await askAgentEffector.invoke({
      seat: 'cortex',
      prompt: 'Test without wiring'
    });

    assert.equal(result.ok, false, 'ask_agent returned ok:false');
    assert.ok(result.result.includes('not wired up'), 'error message indicates unwired state');
  });

  it('ask_agent validates required parameters', async () => {
    const wiring3 = registerFromDashboard(hub, {});
    wiring3.setAskAgentDispatch(async (seat, prompt) => 'dummy response');

    const askAgentEffector = hub.get('ask_agent');

    // Test missing seat
    let result = await askAgentEffector.invoke({
      seat: '',
      prompt: 'valid prompt'
    });
    assert.equal(result.ok, false);
    assert.ok(result.result.includes('required'));

    // Test missing prompt
    result = await askAgentEffector.invoke({
      seat: 'voice',
      prompt: ''
    });
    assert.equal(result.ok, false);
    assert.ok(result.result.includes('required'));
  });

  it('both voice and cortex channels use the same single ask_agent dispatch (shared closure)', async () => {
    // This test verifies that there is only ONE ask_agent closure variable,
    // not separate ones per channel, by setting it once and calling from both "channels"
    const wiring4 = registerFromDashboard(hub, {});

    let callLog = [];
    const trackingDispatch = async (seat, prompt) => {
      callLog.push(seat);
      return `Dispatched to ${seat}`;
    };

    wiring4.setAskAgentDispatch(trackingDispatch);

    const askAgentEffector = hub.get('ask_agent');

    // Simulate voice channel call
    let result = await askAgentEffector.invoke({
      seat: 'voice',
      prompt: 'voice query'
    });
    assert.equal(result.ok, true);

    // Simulate cortex channel call
    result = await askAgentEffector.invoke({
      seat: 'cortex',
      prompt: 'cortex query'
    });
    assert.equal(result.ok, true);

    // Both should have used the SAME dispatch function
    assert.deepEqual(callLog, ['voice', 'cortex'], 'both voice and cortex routed through the same dispatch');
  });
});
