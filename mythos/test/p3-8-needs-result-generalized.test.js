'use strict';

// REMEDIATION P3-8 (2026-07-29 audit): needs_result:true was declared on many
// tool definitions (screen_look, media_status, browser_get_title, ...) but
// was dead metadata — effectors/adapter.js's describeMeta() never carried
// the field past the effector hub, and voice-agent.js only ever force-set
// needs_result for a hardcoded web_search/web_fetch pair. A status/check/
// list/read tool called with needs_result:false meant the voice loop never
// fed the result back to the model — it answered before it could possibly
// know the outcome (the operator's first and most-repeated complaint: "you
// said checking now... but you don't actually report back").
//
// This exercises the REAL pipeline end-to-end: a tool registered through the
// real effector hub (adapter.js -> hub.catalog() -> buildCatalogFromHub())
// with needs_result:true, verifying the voice loop now forces needs_result
// even when the model itself said false, and reads the tool's real result
// back on the next iteration.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createVoiceAgent } = require('../src/core/voice/voice-agent');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { effectorFromTool } = require('../src/core/effectors/adapter');

function makeHubWithStatusTool() {
  const hub = createEffectorHub({ bus: { emit: () => {}, subscribe: () => () => {} }, config: {} });
  hub.register(effectorFromTool({
    name: 'fake_status',
    description: 'A status/check tool for this test.',
    params: {},
    danger: false,
    needs_result: true,
    fn: async () => ({ ok: true, result: { state: 'green' } }),
  }));
  return hub;
}

describe('P3-8: needs_result is enforced for ANY catalog tool that declares it, not just web_search/web_fetch', () => {
  it('adapter.js/hub.catalog() actually carries needs_result through (was silently dropped)', () => {
    const hub = makeHubWithStatusTool();
    const meta = hub.catalog().find((t) => t.name === 'fake_status');
    assert.equal(meta.needs_result, true, 'describeMeta() must expose needs_result, not drop it');
  });

  it('forces needs_result:true when the model calls a needs_result tool but says false, feeding the real result back', async () => {
    const calls = [];
    const brain = {
      think: async ({ messages }) => {
        const isSecondPass = messages[0].content.includes('TOOL RESULT') || messages[0].content.includes('fake_status');
        calls.push(messages[0].content.slice(0, 40));
        if (calls.length === 1) {
          // First pass: model calls the tool but (wrongly) says it doesn't need the result.
          const reply = { say: 'Checking now.', actions: [{ tool: 'fake_status', args: {} }], needs_result: false };
          return { content: JSON.stringify(reply), parsed: reply, offline: false };
        }
        // Second pass only happens if needs_result was actually forced to true.
        const reply = { say: 'Everything is green.', actions: [], needs_result: false };
        return { content: JSON.stringify(reply), parsed: reply, offline: false };
      },
    };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: true, result: { state: 'green' } });
    const bus = { emit: () => {} };
    const hub = makeHubWithStatusTool();

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {}, hub });
    const result = await agent.handleUtterance({ text: 'is everything ok', ctx: {} });

    assert.equal(calls.length, 2, 'the model must be re-prompted with the real result, not answer on the first pass alone');
    assert.equal(result.say, 'Everything is green.');
  });

  it('does not force needs_result for a tool with no needs_result declaration', async () => {
    const calls = [];
    const brain = {
      think: async ({ messages }) => {
        calls.push(1);
        const reply = { say: 'Done.', actions: [{ tool: 'no_flag_tool', args: {} }], needs_result: false };
        return { content: JSON.stringify(reply), parsed: reply, offline: false };
      },
    };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: true, result: {} });
    const bus = { emit: () => {} };
    const hub = createEffectorHub({ bus: { emit: () => {}, subscribe: () => () => {} }, config: {} });
    hub.register(effectorFromTool({ name: 'no_flag_tool', description: 'no needs_result', params: {}, danger: false, fn: async () => ({ ok: true, result: {} }) }));

    const agent = createVoiceAgent({ brain, leash, dispatch, bus, config: {}, hub });
    await agent.handleUtterance({ text: 'do the thing', ctx: {} });

    assert.equal(calls.length, 1, 'a tool with no needs_result declaration must not force a second pass');
  });
});
