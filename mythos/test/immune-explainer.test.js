'use strict';

// Phase-6 Jarvis upgrade: self-error explanation on the healer's no-match path.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { createExplainer } = require('../src/core/immune/explainer');
const healerLib = require('../src/core/immune/healer');

function fakeBrain(reply) {
  return {
    async think() {
      if (!reply) return { offline: true };
      return { content: JSON.stringify(reply), parsed: reply, offline: false };
    }
  };
}

function fakeMemory() {
  return { episodic: { recall: () => [{ record: { summary: 'action spotify_play FAILED: window not found' } }] } };
}

function noMatchEvent(kind, target) {
  return { payload: { playbookId: null, kind, target, outcome: 'no-match', detail: { evidence: 'x' } } };
}

describe('immune explainer', () => {
  let bus, spoken;

  beforeEach(() => {
    bus = fakeBus();
    spoken = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = (type, payload) => {
      if (type === 'action.speak-requested') spoken.push(payload.text);
      return origEmit(type, payload);
    };
  });

  it('explains a no-match anomaly and applies the suppress_tool remedy', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ explanation: 'spotify_play keeps failing because the window cannot be found.', remedy: 'suppress_tool' })
    });
    await explainer._onHealed(noMatchEvent('effector-error', 'spotify_play'));
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /window cannot be found/);
    assert.match(spoken[0], /suppressed spotify_play/);
    assert.equal(healerLib.isToolSuppressed('spotify_play'), true);
  });

  it('remedy "none" explains and asks for a human', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ explanation: 'The vault disk is nearly full.', remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('disk-pressure', 'vault'));
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /needs your attention/);
    assert.equal(healerLib.isToolSuppressed('vault'), false);
  });

  it('cooldown: same kind:target explains once per window', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ explanation: 'Something broke.', remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('weird-thing', 'x'));
    await explainer._onHealed(noMatchEvent('weird-thing', 'x'));
    assert.equal(spoken.length, 1);
  });

  it('ignores matched outcomes and stays silent when brain is offline', async () => {
    const explainer = createExplainer({ bus, memory: fakeMemory(), config: {}, brain: fakeBrain(null) });
    await explainer._onHealed({ payload: { kind: 'provider-down', target: 'nim', outcome: 'applied' } });
    await explainer._onHealed(noMatchEvent('other-thing', 'y'));
    assert.equal(spoken.length, 0);
  });

  it('IMMUNE_EXPLAIN=false disables it', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: { IMMUNE_EXPLAIN: 'false' },
      brain: fakeBrain({ explanation: 'x'.repeat(20), remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('anything', 'z'));
    assert.equal(spoken.length, 0);
  });
});
