'use strict';

// test/bug-319-artifact-age-disclosed.test.js — BUG-319.
//
// THE DEFECT. On 2026-08-22 at 23:40:12 — in the SAME turn that started the web
// research, before any build existed — MYTHOS called
//   open_artifact({ path: '/vault/builds/pipeline/ai-news-digest-openai-ai-went-rogue-2.html',
//                   title: 'AI News Digest' })
// and it returned opened:true. That file was last written on 2026-08-11. The
// existence check passes on a real old file, so a ten-day-old artifact was
// presented as the thing just built. It is the page the operator called "totally
// failed" a minute later, before any build had even been enqueued.
//
// DISCLOSURE, NOT REFUSAL, and that is a deliberate choice. "Open the pawshop
// page from last week" is a legitimate request; refusing anything older than the
// current process would break it and would be the kind of over-firing guard this
// repo has been bitten by before. Age on the result — and therefore in the audit
// line — is what lets the model, and a reader days later, tell "the build I just
// made" from "a file that was already sitting there".

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nodeFs = require('fs');

const { vaultAgeHours } = require('../src/core/effectors/vault-url');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');

function storeWith(relPath, ageHours) {
  const dir = tempVaultDir();
  const full = path.join(dir, relPath.split('/').join(path.sep));
  nodeFs.mkdirSync(path.dirname(full), { recursive: true });
  nodeFs.writeFileSync(full, '<!DOCTYPE html><title>x</title>');
  if (typeof ageHours === 'number') {
    const when = new Date(Date.now() - ageHours * 3600000);
    nodeFs.utimesSync(full, when, when);
  }
  return { dir, store: createFsStore(() => dir, null) };
}

describe('BUG-319 — an artifact\'s age is knowable', () => {
  test('a freshly written artifact reads as 0 hours old', () => {
    const { dir, store } = storeWith('builds/pipeline/fresh.html');
    try {
      assert.strictEqual(vaultAgeHours('builds/pipeline/fresh.html', store), 0);
    } finally { cleanupVaultDir(dir); }
  });

  test('the shipped case: a ten-day-old file reports its real age', () => {
    // 2026-08-11 -> 2026-08-22 is eleven days; the assertion is about the shape,
    // not the exact figure, so it uses a round 240h.
    const { dir, store } = storeWith('builds/pipeline/old.html', 240);
    try {
      const age = vaultAgeHours('builds/pipeline/old.html', store);
      assert.ok(age >= 239 && age <= 241, 'expected ~240h, got ' + age);
    } finally { cleanupVaultDir(dir); }
  });

  test('a missing file is null, never 0 — unknown must not read as brand new', () => {
    const { dir, store } = storeWith('builds/pipeline/present.html');
    try {
      assert.strictEqual(vaultAgeHours('builds/pipeline/absent.html', store), null);
    } finally { cleanupVaultDir(dir); }
  });

  test('a store with no vaultPath is null rather than throwing', () => {
    assert.strictEqual(vaultAgeHours('builds/x.html', null), null);
    assert.strictEqual(vaultAgeHours('builds/x.html', {}), null);
  });

  test('open_artifact carries ageHours in its result', () => {
    // Source-level, because exercising the success path needs a live HTTP server
    // and the age plumbing is what is under test, not the opener.
    const src = nodeFs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');
    const ret = (src.match(/return ok\(\{ opened: true[^\n]*/) || [''])[0];
    assert.match(ret, /ageHours/,
      'open_artifact must disclose the artifact age: ' + ret);
  });
});
