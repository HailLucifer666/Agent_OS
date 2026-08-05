'use strict';

// test/bug-125-healer-audit-tool-field.test.js — BUG-125.
//
// The operator found audit rows reading `tool: undefined, outcome: no-match`
// and reasonably read them as dispatches that had lost their tool name. They
// are not: healer.js writes its playbook decisions into the same Audit/*.jsonl
// stream the leash writes tool rows into, and a healer row has no tool by
// nature. 'no-match' is the healer honestly recording that no playbook covered
// a diagnosis — the immune system working, not failing.
//
// The row was still wrong to omit the field, because an absent key and a lost
// value look identical to every reader. An explicit null says the absence is
// deliberate. Readers are untouched; this is the writer telling the truth.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createHealer } = require('../src/core/immune/healer');

function harness() {
  const rows = [];
  const bus = createBus({ historySize: 50 });
  const healer = createHealer({
    bus,
    config: {},
    memory: { audit: { write: (r) => rows.push(r) } },
    getCortex: () => null,
    getGoals: () => null,
    getEffectors: () => null,
  });
  healer.start();
  return { bus, rows, healer };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('BUG-125 — a healer audit row states that it has no tool, rather than omitting the field', () => {
  test('a diagnosis no playbook covers writes tool:null, outcome:no-match', async () => {
    const { bus, rows, healer } = harness();

    bus.emit('health.diagnosed', { kind: 'something-nobody-has-a-playbook-for', target: 'x' });
    await settle();

    const row = rows.find((r) => r.actor === 'healer');
    assert.ok(row, 'the healer must audit its decision even when it does nothing');
    assert.equal(row.outcome, 'no-match');
    assert.ok('tool' in row, 'the field must be present, not merely absent');
    assert.equal(row.tool, null,
      'null is "deliberately no tool"; undefined is indistinguishable from a lost tool name');

    healer.stop();
  });

  test('a matched playbook audits the same way — the field is unconditional', async () => {
    const { bus, rows, healer } = harness();

    bus.emit('health.diagnosed', { kind: 'budget-exhausted', target: 'goal-1' });
    await settle();

    const row = rows.find((r) => r.actor === 'healer');
    assert.equal(row.playbookId, 'budget-pause', 'this diagnosis does have a playbook');
    assert.equal(row.tool, null, 'a healer row never carries a tool, matched or not');

    healer.stop();
  });
});
