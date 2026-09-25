'use strict';

// A4 — persona levels are readable.
//
// Live evidence, 2026-08-12 02:16:29: the operator asked what a persona trait
// was set to and MYTHOS said it had no tool to read current settings, even
// though set_persona_level (the WRITE tool, effectors/from-persona.js) exists
// and works. A write-only setting is a trap: the model cannot report state it
// cannot read, so it either refuses or invents a number.
//
// read_status (effectors/from-dashboard.js) is the tool MYTHOS already reaches
// for when asked "what's your status" — this covers folding the persona
// store's current trait levels into that output (identity.getPersonaLevels(),
// the same accessor persona_status already uses — see
// src/core/identity/index.js and effectors/from-persona.js). No new tool, no
// new persistence layer: read_status just also surfaces what already exists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

// The seven traits identity/index.js actually tracks (DEFAULT_LEVELS / TRAITS
// in src/core/identity/index.js) — verified against that file, not assumed.
const TRAITS = ['humor', 'warmth', 'formality', 'sass', 'proactivity', 'terseness', 'strictness'];

function minimalCtx(overrides) {
  return Object.assign({
    buildRunner: { listJobs: () => [] },
    probes: null,
    goals: null,
    config: {},
    fs: null
  }, overrides);
}

function findTool(ctx, name) {
  return buildTools(ctx).TOOLS.find((t) => t.name === name);
}

describe('A4: persona levels are readable via read_status', () => {
  it('read_status result includes a persona object with all seven traits and their current values', async () => {
    const levels = { humor: 8, warmth: 7, formality: 5, sass: 7, proactivity: 8, terseness: 5, strictness: 4 };
    const identity = { getPersonaLevels: () => Object.assign({}, levels) };
    const tool = findTool(minimalCtx({ identity }), 'read_status');
    assert.ok(tool, 'read_status tool must be registered');

    const res = await tool.fn();
    assert.equal(res.ok, true);
    assert.ok(res.result.persona, 'read_status result must include a persona object');
    assert.deepEqual(Object.keys(res.result.persona).sort(), TRAITS.slice().sort());
    for (const trait of TRAITS) {
      assert.equal(res.result.persona[trait], levels[trait], `persona.${trait} must report the store's current value`);
    }
  });

  it('reflects a live change made via set_persona_level (not a stale snapshot)', async () => {
    let levels = { humor: 8, warmth: 7, formality: 5, sass: 7, proactivity: 8, terseness: 5, strictness: 4 };
    const identity = {
      getPersonaLevels: () => Object.assign({}, levels),
      setPersonaLevel: (trait, value) => { levels = Object.assign({}, levels, { [trait]: value }); return { ok: true, trait, value, levels: Object.assign({}, levels) }; }
    };
    const ctx = minimalCtx({ identity });
    identity.setPersonaLevel('humor', 3);

    const tool = findTool(ctx, 'read_status');
    const res = await tool.fn();
    assert.equal(res.result.persona.humor, 3);
  });

  it('never fabricates persona levels when identity is unavailable (honest-inert, not invented defaults)', async () => {
    const tool = findTool(minimalCtx({ identity: null }), 'read_status');
    const res = await tool.fn();
    assert.equal(res.ok, true);
    assert.equal(res.result.persona, null, 'persona must be null, not a synthesized set of trait values, when identity is missing');
  });

  it('read_status keeps reporting status/recentJobs alongside persona (no regression to the existing shape)', async () => {
    const identity = { getPersonaLevels: () => ({ humor: 6, warmth: 6, formality: 5, sass: 5, proactivity: 6, terseness: 5, strictness: 4 }) };
    const ctx = minimalCtx({ identity, buildRunner: { listJobs: () => [{ id: 'job-1' }] } });
    const tool = findTool(ctx, 'read_status');
    const res = await tool.fn();
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.recentJobs, [{ id: 'job-1' }]);
    // BUG-446 / D10 (2026-09-23): commitments left read_status for commitment_list.
    assert.equal('openCommitments' in res.result, false);
    assert.ok('status' in res.result);
    assert.ok('persona' in res.result);
  });
});
