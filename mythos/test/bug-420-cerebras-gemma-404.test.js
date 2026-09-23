'use strict';
// BUG-420: real completion 404 measured 2026-09-09; catalog listing is not proof.
// Mutation probe 2026-09-10: restore gemma to PREF_VOICE -> 1 failure.
// Restored by absolute-path byte copy with matching SHA256.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { BRAIN_TABLES, KNOWN_DEAD, UNBILLED_NOT_DEAD } = require('../src/core/brain/lanes.default');
const isGemma = row => row.provider === 'cerebras' && row.model === 'gemma-4-31b';
it('Cerebras gemma is retired from every default lane and no longer called merely unbilled', () => {
  assert.ok(KNOWN_DEAD.some(isGemma));
  assert.equal(UNBILLED_NOT_DEAD.some(isGemma), false);
  for (const [name, table] of Object.entries(BRAIN_TABLES)) assert.equal(table.prefs.some(isGemma), false, name);
});
