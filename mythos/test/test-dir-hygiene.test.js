'use strict';

// test-dir-hygiene.test.js — guard for BUG-134.
//
// node --test's default discovery is DIRECTORY-based: it collects every
// .js/.cjs/.mjs file under any directory named `test`, regardless of name or
// extension. "Name it something that isn't a test" (e.g. run-e2e.mjs, which
// used to live at mythos/test/e2e/run-e2e.mjs) does NOT keep a file out of
// the unit gate — only living outside a `test/` tree does. That harness now
// lives at mythos/scripts/e2e/run-e2e.mjs.
//
// This test walks mythos/test/ recursively and fails if any .js/.cjs/.mjs
// file that isn't `*.test.js` isn't on the explicit allowlist below, so the
// next non-test file dropped under test/ is caught here instead of silently
// joining the unit gate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = path.join(__dirname);

// Relative to mythos/test/, forward-slash. Each entry is collected by
// `node --test` today and is known-harmless — helpers/fixtures/eval scripts,
// not full harnesses that boot real processes.
const ALLOWLIST = new Set([
  'helpers.js',
  'pr3-wire-helpers.cjs', // Pure fake socket/dependency fixtures; import never starts a server.
  'helpers/mock-spawn-enoent.js',
  'helpers/leash-fixture.js',
  'fixtures/stub-mcp-server.js',
  'fixtures/browser-native-protocol.js', // Pure framing oracle; importing never opens pipes or processes.
  'eval/routing.eval.js',
  'eval/memory-impact.eval.js',
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('BUG-134: every non-*.test.js file under test/ is on the explicit allowlist', () => {
  const files = walk(TEST_DIR, []);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(TEST_DIR, file).split(path.sep).join('/');
    if (rel.endsWith('.test.js')) continue;
    if (!ALLOWLIST.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `non-test file(s) under test/ will be collected by node --test unless allowlisted or moved out of test/: ${offenders.join(', ')}`,
  );
});

test('BUG-134: every allowlisted file still exists (stale entries hide real gaps)', () => {
  for (const rel of ALLOWLIST) {
    const full = path.join(TEST_DIR, ...rel.split('/'));
    assert.ok(fs.existsSync(full), `allowlisted ${rel} no longer exists — remove it from ALLOWLIST`);
  }
});
