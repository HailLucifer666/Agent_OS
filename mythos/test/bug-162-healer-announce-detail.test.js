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
const { createAnnouncer } = require('../src/core/immune/announcer');
const { createHealer, SEED_PLAYBOOKS } = require('../src/core/immune/healer');

function heard(payload) {
  const bus = fakeBus();
  const lines = [];
  const announcer = createAnnouncer({ bus, config: {}, speak: (t) => { lines.push(t); } });
  announcer.start();
  bus.emit('health.healed', payload);
  announcer.stop();
  return lines;
}

describe('BUG-162: the heal announcement says what was healed', () => {
  it('THE RECORDED CASE: a recurring-failure heal names the lesson recording, its trigger, and its action', () => {
    const lines = heard({
      playbookId: 'recurring-failure-record',
      title: 'recording of a repeated failure as a lesson',
      kind: 'recurring-failure', target: 'spotify_play',
      outcome: 'applied', actions: ['record-lesson'],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /recording of a repeated failure as a lesson/);
    assert.match(lines[0], /recurring-failure on spotify_play/);
    assert.match(lines[0], /record-lesson/);
    assert.ok(!/^Self-healed: recurring-failure-record\.$/.test(lines[0]),
      'the bare-ID sentence is the defect and must be gone');
  });

  it('an event with only an ID admits details were not recorded rather than padding', () => {
    const lines = heard({ playbookId: 'mystery-playbook', outcome: 'applied' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /mystery-playbook/);
    assert.match(lines[0], /Details were not recorded/);
  });

  it('a restore event with kind/target but no actions states the trigger and does NOT claim missing details', () => {
    const lines = heard({
      playbookId: 'lane-restore', title: 'brain lane restored after quota recovery',
      kind: 'quota-recovered', target: 'voice', outcome: 'applied',
    });
    assert.match(lines[0], /brain lane restored/);
    assert.match(lines[0], /quota-recovered on voice/);
    assert.ok(!/Details were not recorded/.test(lines[0]));
  });

  it('non-applied outcomes stay silent (cooldown/no-match/error are not heals)', () => {
    for (const outcome of ['cooldown', 'no-match', 'error']) {
      assert.equal(heard({ playbookId: 'x', outcome }).length, 0, outcome + ' must not be announced');
    }
  });

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

  it('no brain call anywhere in the announcer path (AD-5 source assertion, BUG-123 style)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/immune/announcer.js'), 'utf8');
    assert.ok(!/brain\.(think|generate)/.test(src), 'the announcer must never ask a model to explain a heal');
  });
});
