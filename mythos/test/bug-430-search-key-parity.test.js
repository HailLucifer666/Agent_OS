'use strict';
// BUG-430/302: Jina keyless is deliberate. Do not invent a missing-key gate.
// Mutation 2026-09-10: remove exa's key argument -> 1 failure.
// Restored by absolute-path byte copy with matching SHA256; production unchanged.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PROVIDERS_REQUIRING_KEY = { exa: 'EXA_API_KEY' };
it('every paid-key rung is gated, and Jina still permits its deliberate keyless attempt', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/core/effectors/web-search.js'), 'utf8');
  assert.match(source, /skipReason\('jina'\)/);
  for (const [provider, key] of Object.entries(PROVIDERS_REQUIRING_KEY)) assert.ok(source.includes(`skipReason('${provider}', '${key}')`), provider);
});
