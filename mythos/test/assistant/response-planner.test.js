'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createResponsePlanner } = require('../../src/core/assistant/response-planner');

function fakeCortex() {
  return {
    think: function() { return Promise.resolve({ content: 'response' }); }
  };
}

describe('assistant/response-planner', () => {
  let planner;

  beforeEach(function() {
    planner = createResponsePlanner({ config: {}, cortex: fakeCortex() });
  });

  describe('plan', () => {
    it('handles unknown intent type gracefully', async () => {
      planner = createResponsePlanner({ config: {}, cortex: fakeCortex() });
      var plan = await planner.plan({ type: 'unknown' });
      // Unknown types still have intent set, but no response generated
      assert.equal(plan.intent, 'unknown');
      assert.ok(!plan.response);
    });

    it('plans chat response', async () => {
      var plan = await planner.plan({ type: 'chat', text: 'hello' });
      assert.equal(plan.intent, 'chat');
      assert.ok(plan.response);
    });

    it('plans question response', async () => {
      var plan = await planner.plan({ type: 'question', question: 'what?' });
      assert.equal(plan.intent, 'question');
      assert.ok(plan.response);
    });
  });

  describe('format', () => {
    it('returns empty string for null plan', async () => {
      var result = await planner.format(null);
      assert.equal(result, '');
    });

    it('returns plan response', async () => {
      var plan = await planner.plan({ type: 'chat', text: 'hi' });
      var result = await planner.format(plan);
      assert.ok(result.includes('hi'));
    });
  });
});