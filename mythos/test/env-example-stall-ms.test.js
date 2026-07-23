'use strict';

// REMEDIATION P2-9: .env.example pinned STALL_MS=5000 (the pre-fix value) as
// an ACTIVE, uncommented setting — copying .env.example to .env (the
// documented onboarding step) silently re-pinned the old value and defeated
// config/schema.js's STALL_MS default bump to 30000. This guards against that
// specific class of drift recurring: the example file's active STALL_MS value
// must always match the schema's real default.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function parseEnvExample(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

test('.env.example STALL_MS matches config/schema.js STALL_MS default (no stale re-pin)', () => {
  const { SCHEMA } = require('../src/core/config/schema');
  const envExamplePath = path.join(__dirname, '..', '.env.example');
  const values = parseEnvExample(fs.readFileSync(envExamplePath, 'utf8'));

  assert.ok('STALL_MS' in values, '.env.example must have an active STALL_MS line for this guard to mean anything');
  assert.equal(Number(values.STALL_MS), SCHEMA.STALL_MS.default,
    '.env.example\'s STALL_MS must match the schema default — a stale pinned value silently defeats any future schema default change');
});
