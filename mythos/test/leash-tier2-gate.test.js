'use strict';

// leash-tier2-gate.test.js — a Tier 2 tool above the autonomy ceiling must be
// refused with a Tier 2 reason, and must be reachable by the same
// operator-present / session-grant paths Tier 3 already has. Before this test,
// tier 2 matched no branch and fell into the "T4 -> always confirm" tail, so
// media_key and spotify_play were unreachable from the dashboard and confirmed
// on every voice turn. Live evidence: vault/Audit/2026-08-11.jsonl rows
// `tool=media_key tier=2 decision=confirm reason=tier-4-always-confirm`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLeash } = require('./helpers/leash-fixture');

test('tier 2 above the ceiling reports a tier-2 reason, not tier-4', function() {
  const leash = makeLeash({ AUTONOMOUS_MAX_TIER: 1 });
  const res = leash.check({ tool: 'media_key', args: { key: 'play_pause' } }, { goalId: null });
  assert.equal(res.allow, false);
  assert.equal(res.requireConfirm, true);
  assert.equal(res.tier, 2);
  assert.equal(res.reason, 'tier-2-requires-confirm');
});

test('tier 2 auto-allows for a present operator when the tool is trusted', function() {
  const leash = makeLeash({ AUTONOMOUS_MAX_TIER: 1, TRUSTED_TOOLS: 'media_key' });
  const res = leash.check(
    { tool: 'media_key', args: { key: 'play_pause' } },
    { goalId: null, connectionId: 'ws-1' },
  );
  assert.equal(res.allow, true);
  assert.equal(res.requireConfirm, false);
  assert.equal(res.tier, 2);
  assert.equal(res.reason, 'operator-present-trusted');
});

test('tier 3 behaviour is unchanged', function() {
  const leash = makeLeash({ AUTONOMOUS_MAX_TIER: 1 });
  const res = leash.check({ tool: 'run_command', args: { cmd: 'dir' } }, { goalId: null });
  assert.equal(res.tier, 3);
  assert.equal(res.reason, 'tier-3-requires-confirm');
});
