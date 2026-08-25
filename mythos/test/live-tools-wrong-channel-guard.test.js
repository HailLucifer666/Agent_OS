'use strict';

// test/live-tools-wrong-channel-guard.test.js — Wave 4 (2026-08-13).
//
// live-tools.js's own comments have described the same shape (BUG-171 class)
// five separate times before this test existed: an act-tool promoted to
// DEFAULT_ALLOWLIST without the read/list tool that lets the model verify or
// reference what it acted on (log_incident without list_incidents;
// ui_click without ui_elements; set_volume without get_volume; ...). Every
// one of those was found by an operator noticing the model improvise, not by
// anything automated. This pins the rule as code: (1) DEFAULT_ALLOWLIST
// itself must never regress into the gap, and (2) a hand-typed
// LIVE_TOOL_ALLOWLIST override — which bypasses this file's own review —
// gets a WARNING logged when it reintroduces one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFunctionDeclarations, DEFAULT_ALLOWLIST,
  ACT_TOOL_READ_COUNTERPARTS, findMissingReadCounterparts,
} = require('../src/core/voice/live-tools');

function hubOf(names) {
  const entries = names.map((n) => ({ name: n, description: n, params: {} }));
  return { catalog: () => entries };
}

describe('Wave 4: findMissingReadCounterparts — the rule itself', () => {
  it('flags an act-tool present with none of its read counterparts', () => {
    const gaps = findMissingReadCounterparts(new Set(['log_incident']));
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].tool, 'log_incident');
    assert.deepEqual(gaps[0].missing, ['list_incidents', 'incident_status']);
  });

  it('is satisfied by ANY ONE of the listed counterparts, not all of them', () => {
    assert.deepEqual(findMissingReadCounterparts(new Set(['log_incident', 'incident_status'])), []);
    assert.deepEqual(findMissingReadCounterparts(new Set(['log_incident', 'list_incidents'])), []);
  });

  it('an act-tool absent entirely is not a gap — this only judges tools actually allowlisted', () => {
    assert.deepEqual(findMissingReadCounterparts(new Set(['navigate', 'get_time'])), []);
  });

  it('reports every gap when several act-tools are missing their counterparts at once', () => {
    const gaps = findMissingReadCounterparts(new Set(['ui_click', 'set_volume']));
    assert.deepEqual(gaps.map((g) => g.tool).sort(), ['set_volume', 'ui_click']);
  });
});

describe('Wave 4: DEFAULT_ALLOWLIST itself must never carry this gap', () => {
  it('every act-tool this table knows about that IS allowlisted ships with a read counterpart', () => {
    const gaps = findMissingReadCounterparts(new Set(DEFAULT_ALLOWLIST));
    assert.deepEqual(gaps, [], 'DEFAULT_ALLOWLIST regressed into a BUG-171-class gap: ' + JSON.stringify(gaps));
  });

  it('the table itself is not empty — a rule with no entries would pass vacuously', () => {
    assert.ok(Object.keys(ACT_TOOL_READ_COUNTERPARTS).length >= 10);
  });
});

describe('Wave 4: buildFunctionDeclarations warns when a custom allowlist drops one side of a pair', () => {
  it('logs a WARNING mentioning BUG-171 when a custom allowlist has the act-tool but not its read pair', () => {
    const logs = [];
    const hub = hubOf(['log_incident', 'get_time']);
    buildFunctionDeclarations(hub, { allowlist: ['log_incident', 'get_time'], log: (m) => logs.push(m) });
    const warning = logs.find((m) => m.includes('WARNING'));
    assert.ok(warning, 'a custom allowlist missing incident_status/list_incidents must log a warning');
    assert.match(warning, /log_incident/);
    assert.match(warning, /list_incidents/);
  });

  it('does NOT warn when the custom allowlist keeps both halves of the pair', () => {
    const logs = [];
    const hub = hubOf(['log_incident', 'incident_status']);
    buildFunctionDeclarations(hub, { allowlist: ['log_incident', 'incident_status'], log: (m) => logs.push(m) });
    assert.equal(logs.some((m) => m.includes('WARNING')), false);
  });

  it('the default (no explicit allowlist) path never warns, since DEFAULT_ALLOWLIST is asserted clean above', () => {
    const logs = [];
    const hub = hubOf(DEFAULT_ALLOWLIST.slice());
    buildFunctionDeclarations(hub, { log: (m) => logs.push(m) });
    assert.equal(logs.some((m) => m.includes('WARNING')), false);
  });

  it('never throws when no log function is supplied', () => {
    const hub = hubOf(['log_incident']);
    assert.doesNotThrow(() => buildFunctionDeclarations(hub, { allowlist: ['log_incident'] }));
  });
});
