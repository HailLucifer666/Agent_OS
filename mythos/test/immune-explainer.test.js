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

  it('names the condition and applies the suppress_tool remedy', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ remedy: 'suppress_tool' })
    });
    await explainer._onHealed(noMatchEvent('effector-error', 'spotify_play'));
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /effector-error in spotify_play/);
    assert.match(spoken[0], /suppressed spotify_play/);
    assert.equal(healerLib.isToolSuppressed('spotify_play'), true);
  });

  it('remedy "none" explains and asks for a human', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('disk-pressure', 'vault'));
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /needs your attention/);
    assert.equal(healerLib.isToolSuppressed('vault'), false);
  });

  it('cooldown: same kind:target explains once per window', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('weird-thing', 'x'));
    await explainer._onHealed(noMatchEvent('weird-thing', 'x'));
    assert.equal(spoken.length, 1);
  });

  it('ignores matched outcomes', async () => {
    const explainer = createExplainer({ bus, memory: fakeMemory(), config: {}, brain: fakeBrain({ remedy: 'none' }) });
    await explainer._onHealed({ payload: { kind: 'provider-down', target: 'nim', outcome: 'applied' } });
    assert.equal(spoken.length, 0);
  });

  // 2026-08-10: BEHAVIOUR CHANGE. This used to assert silence — the whole spoken
  // line came from brain.think, so an offline brain meant no alert at all. The
  // prose is now built locally (AD-5, see the module header), so a dead brain
  // costs the remedy, not the alert.
  it('an offline brain still delivers the condition, minus a remedy', async () => {
    const explainer = createExplainer({ bus, memory: fakeMemory(), config: {}, brain: fakeBrain(null) });
    await explainer._onHealed(noMatchEvent('other-thing', 'y'));
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /other-thing in y/);
    assert.match(spoken[0], /needs your attention/);
  });

  it('IMMUNE_EXPLAIN=false disables it', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: { IMMUNE_EXPLAIN: 'false' },
      brain: fakeBrain({ remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('anything', 'z'));
    assert.equal(spoken.length, 0);
  });

  // AD-5 regression guard — the 2026-08-10 incident. The operator heard
  // "Something is misfiring when I'm supposedly idle, maybe a tool spinning its
  // wheels and triggering a limit" for a deliberate quiet-session close: no tool
  // was spinning and no limit was hit. The words came from a model asked to
  // explain a bare anomaly kind. Two things are pinned here: a payload with no
  // `reason` must produce NO causal claim, and whatever the brain returns beyond
  // the remedy must never reach the operator's ears.
  it('AD-5: states no cause when the payload carries none, and never speaks brain prose', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({
        remedy: 'none',
        explanation: 'possibly a tool spinning its wheels and triggering a rate limit',
      })
    });
    await explainer._onHealed(noMatchEvent('live-turn-silent', null));
    assert.equal(spoken.length, 1);
    assert.doesNotMatch(spoken[0], /spinning|rate limit/,
      'a field the brain volunteered beyond the remedy must not be spoken');
    assert.doesNotMatch(spoken[0], /\bbecause\b|\bdue to\b|\bpossibly\b|\blikely\b|\bmaybe\b/i,
      'with no reason on the payload there is nothing to attribute — say so, do not guess');
    assert.match(spoken[0], /I do not yet know the cause/);
  });

  it('AD-5: a reason present on the payload IS reported, verbatim and attributed', async () => {
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ remedy: 'none' })
    });
    await explainer._onHealed({
      payload: {
        playbookId: null, kind: 'effector-error', target: 'whatsapp_send', outcome: 'no-match',
        reason: 'typed into the wrong window',
      }
    });
    assert.equal(spoken.length, 1);
    assert.match(spoken[0], /Reported reason: typed into the wrong window/);
  });

  // 2026-08-10: five of these interrupted a live voice conversation to recite
  // "live-turn-no-user-transcript" at the operator, mid-sentence. The words are
  // NOT the defect — AD-5 (bug-123-anomaly-honest-phrasing.test.js) requires the
  // real condition to be named rather than narrated into invented prose. The
  // timing was. So the payload now carries a marker, and server/index.js's
  // action.speak-requested subscriber holds the spoken form back while a Live
  // session is open; the log, the audit and the HUD are unaffected.
  it('marks its speech as an internal diagnostic so a live conversation is not interrupted', async () => {
    const payloads = [];
    const origEmit = bus.emit.bind(bus);
    bus.emit = (type, payload) => {
      if (type === 'action.speak-requested') { spoken.push(payload.text); payloads.push(payload); }
      return origEmit(type, payload);
    };
    const explainer = createExplainer({
      bus, memory: fakeMemory(), config: {},
      brain: fakeBrain({ remedy: 'none' })
    });
    await explainer._onHealed(noMatchEvent('live-turn-no-user-transcript', null));
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].internalDiagnostic, true,
      'everything this module explains is by construction an unplaybooked internal check');
    assert.equal(payloads[0].kind, 'live-turn-no-user-transcript',
      'the kind rides along so a suppressed announcement is still diagnosable');
    // AD-5 still holds: the condition is named in the text itself.
    assert.match(payloads[0].text, /live-turn-no-user-transcript/);
  });
});
