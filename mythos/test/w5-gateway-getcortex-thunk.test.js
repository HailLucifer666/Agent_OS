'use strict';
// W5 regression: conversation-gateway constructed with cortex=null (boot step 12,
// before cortex exists at step 19) must still fire its cortex-fallback route once
// cortex is assigned later. Pre-W5 the gateway captured cortex directly, so the
// fallback route was permanently dead.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createConversationGateway } = require('../src/core/assistant/gateway');

function capturedIntents(bus) {
  const intents = [];
  bus.subscribe('conversation.intent', (e) => intents.push(e.payload));
  return intents;
}

describe('W5: conversation-gateway getCortex() thunk', () => {
  it('fallback route is dead when cortex is null, fires once cortex arrives (thunk)', () => {
    const bus = createBus({ historySize: 50 });
    const intents = capturedIntents(bus);

    // Boot step 12: gateway constructed BEFORE cortex exists. getCortex returns
    // the live binding (null at this point).
    let cortex = null;
    const gateway = createConversationGateway({
      bus, config: {},
      getCortex: () => cortex
    });

    // A non-engagement chat message should route to the cortex fallback.
    // Cortex is still null → fallback must NOT fire (dead route, pre-cortex).
    gateway.route({ type: 'chat' }, { text: 'what can you do' });
    assert.equal(intents.length, 0,
      'fallback must not fire before cortex exists');

    // Boot step 19: cortex now exists. The thunk resolves it at route() time.
    cortex = { tick: () => {} };
    gateway.route({ type: 'chat' }, { text: 'what can you do' });
    assert.equal(intents.length, 1,
      'fallback must fire once cortex is live (the W5 fix)');
    assert.equal(intents[0].type, 'chat');
  });

  it('backward-compat: a directly-passed cortex still gates the fallback', () => {
    const bus = createBus({ historySize: 50 });
    const intents = capturedIntents(bus);
    const gateway = createConversationGateway({
      bus, config: {},
      cortex: { tick: () => {} }   // no getCortex — legacy path
    });
    gateway.route({ type: 'chat' }, { text: 'what can you do' });
    assert.equal(intents.length, 1, 'directly-passed cortex must still work');
  });

  it('a gateway with no cortex and no getCortex never fires the fallback', () => {
    const bus = createBus({ historySize: 50 });
    const intents = capturedIntents(bus);
    const gateway = createConversationGateway({ bus, config: {} });
    gateway.route({ type: 'chat' }, { text: 'what can you do' });
    assert.equal(intents.length, 0);
  });

  it('engagement-action intents are handled before the cortex fallback fires', () => {
    const bus = createBus({ historySize: 50 });
    const intents = capturedIntents(bus);
    const engagementEmits = [];
    bus.subscribe('engagement.action.list', (e) => engagementEmits.push(e.payload));
    let cortex = { tick: () => {} };
    // engagementManager is required for the engagement-action branch (route() gates
    // on `classification.type === 'action' && engagementManager`); a truthy stub is
    // enough — the branch emits the engagement.action.<action> event directly.
    const gateway = createConversationGateway({
      bus, config: {}, engagementManager: {}, getCortex: () => cortex
    });
    // Action intent: "list engagements" → engagement.action.list, handled=true,
    // so the cortex fallback must NOT also fire.
    gateway.route({ type: 'action', action: 'list' }, { text: 'list engagements' });
    assert.equal(engagementEmits.length, 1);
    assert.equal(intents.length, 0, 'handled actions must not fall through to cortex');
  });
});
