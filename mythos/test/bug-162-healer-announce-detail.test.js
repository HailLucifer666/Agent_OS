'use strict';

// BUG-162 — healer opacity (operator incident 2026-08-07 04:27): the spoken
// line was "Self-healed: recurring-failure-record." — a playbook ID and
// nothing else — and when the operator asked what was actually fixed, nothing
// downstream could answer. The heal announcement now names the playbook's
// human title, the diagnosis that triggered it, and the action(s) taken —
// interpolating ONLY fields actually present on the event (the AD-5/BUG-123
// rule: no brain call, no invented causes) and saying plainly when detail was
// not recorded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeBus } = require('./helpers');
const { createHealer, SEED_PLAYBOOKS } = require('../src/core/immune/healer');

// 2026-09-23, BUG-447 (operator decision D5): a successful heal is no longer SPOKEN
// at all — immune/announcer.js, whose sentence the deleted cases here pinned, is
// gone. BUG-162's substance survives unchanged: "what was fixed?" is answerable,
// because the healer puts the playbook's human title, the trigger (kind/target)
// and the actions on health.healed, and that payload is what reaches the HUD's
// health card and the vault's anomaly row. The two cases below pin exactly that.
describe('BUG-162: the heal record says what was healed', () => {
  it('every seed playbook carries a human title, so no future heal regresses to a bare ID', () => {
    for (const p of SEED_PLAYBOOKS) {
      assert.ok(typeof p.title === 'string' && p.title.length > 5, p.id + ' needs a title');
      assert.notEqual(p.title, p.id);
    }
  });

  it('the healer emits title + actions on health.healed (wire shape)', async () => {
    const bus = fakeBus();
    const healer = createHealer({ bus, config: {}, memory: null, getCortex: () => null, getGoals: () => null });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'recurring-failure', target: 'spotify_play', evidence: { detail: 'kept failing' } });
    await new Promise((r) => setTimeout(r, 50));
    healer.stop();
    const healed = bus._emitted().find((e) => e.type === 'health.healed');
    assert.ok(healed, 'a heal must have been emitted');
    assert.equal(healed.payload.title, 'recording of a repeated failure as a lesson');
    assert.deepEqual(healed.payload.actions, ['record-lesson']);
  });

  it('no brain call explains a heal (AD-5, BUG-123 style) — the healer states it from the playbook', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/immune/healer.js'), 'utf8');
    assert.ok(!/brain\.(think|generate)/.test(src), 'the healer must never ask a model to explain a heal');
  });
});
