'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { effectorFromTool } = require('../src/core/effectors/adapter');
const { tierOf } = require('../src/core/leash/tiers');

// NOTE: adapter.js requires the real leash/tiers.js directly (not injected), so "a fake
// tierOf fixture" per the Test Plan is realized here as asserting against the real,
// data-driven TIER_TABLE for a mapped and an unmapped tool name — tierOf() IS the
// fixture, since it's pure data lookup with a documented T3 fallback (Ambiguity #2).

describe('effectors/adapter: effectorFromTool', () => {
  it('sets tier from tierOf() for a mapped tool name', () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: {}, danger: false, fn: async () => 'ok' });
    assert.equal(eff.tier, tierOf('read_file'));
    assert.equal(eff.tier, 0);
  });

  it('falls back to tier 3 for an unmapped tool name', () => {
    const eff = effectorFromTool({ name: 'totally_unknown_tool_xyz', description: 'x', params: {}, danger: false, fn: async () => 'ok' });
    assert.equal(eff.tier, 3);
  });

  it('normalizes a bare-value tool.fn return into {ok:true, result}', async () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: {}, fn: async () => 'bare-value' });
    const result = await eff.invoke({}, {});
    assert.deepEqual(result, { ok: true, result: 'bare-value' });
  });

  it('passes through a tool.fn that already returns {ok, result}', async () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: {}, fn: async () => ({ ok: false, result: 'nope' }) });
    const result = await eff.invoke({}, {});
    assert.deepEqual(result, { ok: false, result: 'nope' });
  });

  it('catches a throwing tool.fn into {ok:false, result: err.message}', async () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: {}, fn: async () => { throw new Error('boom'); } });
    const result = await eff.invoke({}, {});
    assert.deepEqual(result, { ok: false, result: 'boom' });
  });

  it('validate() fails when a required param is missing', () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: { path: 'string' }, fn: async () => 'ok' });
    const v = eff.validate({});
    assert.equal(v.ok, false);
    assert.match(v.reason, /path/);
  });

  it('validate() ignores params marked "(optional)"', () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: { path: 'string', title: 'string (optional)' }, fn: async () => 'ok' });
    const v = eff.validate({ path: '/x' });
    assert.equal(v.ok, true);
  });

  it('validate() passes when all required params are present', () => {
    const eff = effectorFromTool({ name: 'read_file', description: 'x', params: { path: 'string' }, fn: async () => 'ok' });
    const v = eff.validate({ path: '/x' });
    assert.equal(v.ok, true);
  });

  it('carries dangerWhen through unmodified for leash.check() to read at gate time', () => {
    const dw = (args) => args && args.action === 'reject';
    const eff = effectorFromTool({ name: 'pipeline_advance', description: 'x', params: {}, dangerWhen: dw, fn: async () => 'ok' });
    assert.equal(eff.dangerWhen, dw);
  });
});
