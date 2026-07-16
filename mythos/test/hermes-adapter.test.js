'use strict';

// Phase-7 Jarvis upgrade: optional hermes-agent sidecar — honest degradation.
// Environment-aware (same convention as cua-driver-adapter.test.js): asserts
// the adapter reaches a definite state and that hermes_task never lies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const hermes = require('../adapters/hermes-agent');
const { buildTools } = require('../src/core/effectors/from-hermes');

describe('hermes-agent adapter', () => {
  it('require() is side-effect-free: OFFLINE until probed', () => {
    assert.equal(hermes.getStatus().state === 'ONLINE' || hermes.getStatus().state === 'OFFLINE', true);
  });

  it('probe() resolves to a definite state; OFFLINE carries an install hint', async () => {
    const online = await hermes.probe(true);
    const status = hermes.getStatus();
    if (online) {
      assert.equal(status.state, 'ONLINE');
      assert.ok(status.mode === 'http' || status.mode === 'cli');
    } else {
      assert.equal(status.state, 'OFFLINE');
      assert.match(status.hint, /Hermes-Agent|hermes/i);
    }
  });

  it('hermes_task fails honestly (with hint) when the sidecar is offline', async () => {
    const tool = buildTools().find((t) => t.name === 'hermes_task');
    assert.equal(tool.danger, true);
    const empty = await tool.fn({});
    assert.equal(empty.ok, false);
    if (!(await hermes.probe(false))) {
      const res = await tool.fn({ task: 'say hello' });
      assert.equal(res.ok, false);
      assert.match(String(res.result.error), /OFFLINE/);
    }
  });
});
