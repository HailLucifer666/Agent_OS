'use strict';
// Mutations 2026-09-10: restore playbook 30s (1 fail), restore direct 30s (1).
// Both restored by absolute-path byte copy with matching SHA256.
const { it, mock } = require('node:test');
const assert = require('node:assert/strict');
const healer = require('../src/core/immune/healer');
const { DEFAULT_LADDER_MS } = require('../src/core/effectors/provider-cooldown');
it('healer playbook and direct suppression last as long as the first search ladder step', () => {
  assert.equal(healer.SEED_PLAYBOOKS.find(p => p.id === 'search-provider-degrade').cooldownMs, DEFAULT_LADDER_MS[0]);
  let now = 1000; mock.method(Date, 'now', () => now);
  try {
    healer.suppressSearchProvider('alignment-test');
    now += DEFAULT_LADDER_MS[0] - 1;
    assert.equal(healer.isSearchProviderSuppressed('alignment-test'), true);
    now++;
    assert.equal(healer.isSearchProviderSuppressed('alignment-test'), false);
  } finally { mock.restoreAll(); }
});
