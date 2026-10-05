'use strict';

// test/security-bundle-integration.test.js — the 2026-10-05 security bundle
// merged ten audit fixes that were each proven alone. These tests pin what only
// exists once two of them are in the same tree, and test each guard ALONE:
// a case where both guards refuse cannot notice one of them being deleted.
//
// (1) open_file (#138, B2c) x read access (#137, B2d). B2c decides what kind of
//     file may open; B2d decides which paths a file tool may touch at all. In the
//     merged tree open_file is built on from-computer's resolveSandboxed, which
//     B2d made refuse protected paths.
//       - A .txt inside .ssh/ is a document B2c would open with no prompt, so
//         only B2d can be what refuses it.
//       - A .exe in an ordinary folder is a path B2d allows, so only B2c can be
//         what refuses it.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/core/effectors/open-file-policy');
const readAccess = require('../src/core/effectors/read-access-policy');
const computer = require('../src/core/effectors/from-computer');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { createLeash } = require('../src/core/leash');
const { approvalConsentFor } = require('../src/core/voice/authority-gate');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

let root;
let savedDirs;
const opened = [];
before(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-bundle-')));
  savedDirs = process.env.VOICE_ALLOWED_DIRS;
  process.env.VOICE_ALLOWED_DIRS = root;
  fs.mkdirSync(path.join(root, '.ssh'));
  for (const rel of ['.ssh/notes.txt', '.ssh/page.html', 'notes.txt', 'page.html', 'run.exe']) {
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  computer.setOpenPathProvider(async (p) => { opened.push(p); return { opened: true }; });
});
after(() => {
  computer.setOpenPathProvider(null);
  if (savedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS; else process.env.VOICE_ALLOWED_DIRS = savedDirs;
  fs.rmSync(root, { recursive: true, force: true });
});

function world() {
  const effector = effectorFromTool(computer.TOOLS.find((t) => t.name === 'open_file'));
  const leash = createLeash({
    bus: { emit() {}, subscribe() { return () => {}; } },
    config: { AUTONOMOUS_MAX_TIER: 4, MYTHOS_DRY_RUN: false, LEASH_CONFIRM_TTL_MS: 30000, CHECKPOINT_TTL_MS: 1800000, TRUSTED_TOOLS: 'open_file', TRUSTED_TOOLS_DISABLED: false },
    identity: { checkBoundary: () => null, getMaxAutonomousTier: () => 4 },
    auditWriter: { write: () => ({ ok: true }) },
    goals: { get: () => null },
    effectors: { get: (name) => (name === 'open_file' ? effector : undefined) },
  });
  const hub = { invoke: (tool, args, ctx) => effector.invoke(args, ctx) };
  const dispatch = (decision, extra) => dispatchAction(decision, Object.assign({ effectors: hub, bus: { emit() {} }, channel: 'test' }, extra));
  return { leash, dispatch };
}
async function held(rel) {
  const w = world();
  const d = { tool: 'open_file', args: { path: path.join(root, rel) } };
  await w.leash.prepare(d);
  return { w, d, v: w.leash.check(d, { connectionId: 'c1' }) };
}

describe('(1) open_file x read access, each guard alone', () => {
  test('(1a) a document inside .ssh/ is refused by READ ACCESS alone — the open policy would show it with no prompt', async () => {
    const file = path.join(root, '.ssh', 'notes.txt');
    // The other guard permits it: this is what makes the test able to see B2d go missing.
    assert.equal(policy.classifyOpenTarget(file).kind, 'display', 'the open policy alone would open this');
    assert.ok(readAccess.protectedReason(file, {}), 'the read policy refuses it');
    const { w, d, v } = await held('.ssh/notes.txt');
    assert.equal(v.allow, false, JSON.stringify(v));
    assert.equal(approvalConsentFor(d), null, 'nothing about a protected path is approvable');
    opened.length = 0;
    assert.equal((await w.dispatch(d, {})).ok, false);
    assert.deepEqual(opened, [], 'nothing reached the shell');
  });

  // (1b) The approval is asked for the protected file ITSELF. A first version used
  // a token minted for a different file and stayed green with B2d deleted, because
  // token binding refused it instead (probe A, 2026-10-05) — it tested binding,
  // not read access.
  test('(1b) a non-document inside .ssh/ cannot be approved at all — the click path has nothing to mint', async () => {
    const file = path.join(root, '.ssh', 'page.html');
    assert.equal(policy.classifyOpenTarget(file).kind, 'approval', 'the open policy alone would open this after one click');
    const bad = await held('.ssh/page.html');
    assert.equal(bad.v.allow, false);
    assert.equal(bad.v.requireConfirm, false, 'refused, not held for a click');
    const token = approvalConsentFor(bad.d);
    assert.equal(token, null);
    opened.length = 0;
    assert.equal((await bad.w.dispatch(bad.d, { consent: token })).ok, false);
    assert.deepEqual(opened, []);
  });

  test('(1c) an executable in an ordinary folder is refused by the OPEN policy alone — read access allows the path', async () => {
    const file = path.join(root, 'run.exe');
    assert.equal(readAccess.protectedReason(file, {}), null, 'the read policy alone would allow this path');
    assert.equal(policy.classifyOpenTarget(file).kind, 'refuse');
    const { w, d, v } = await held('run.exe');
    assert.equal(v.allow, false);
    opened.length = 0;
    assert.equal((await w.dispatch(d, {})).ok, false);
    assert.deepEqual(opened, []);
  });

  test('ADJACENT: an ordinary document opens with no prompt, and an approved non-document opens exactly once', async () => {
    const doc = await held('notes.txt');
    assert.equal(doc.v.allow, true, JSON.stringify(doc.v));
    opened.length = 0;
    assert.equal((await doc.w.dispatch(doc.d, { tier: doc.v.tier })).ok, true);
    assert.deepEqual(opened, [path.join(root, 'notes.txt')]);

    const page = await held('page.html');
    assert.equal(page.v.allow, false);
    assert.equal(page.v.requireConfirm, true, 'held for the click, not refused');
    const token = approvalConsentFor(page.d);
    opened.length = 0;
    assert.equal((await page.w.dispatch(page.d, { consent: token })).ok, true);
    assert.deepEqual(opened, [path.join(root, 'page.html')]);
  });
});

// PROBE RECORD (1), 2026-10-05, each applied with .cache/bundle-2026-10-05/mutate.sh
// (byte snapshot, one replaced site, run, byte-identical restore, git diff re-checked):
//   A. computer-path-guard.js guarded(): the protectedReason lookup replaced by
//      `const hit = null` -> (1a) and (1b) red; (1c) and ADJACENT green.
//      The first (1b) stayed green under A, because it used a token for another
//      file and binding refused it; rewritten to ask for the protected file itself.
//   B. open-file-policy.js: EXECUTE_EXT returns kind 'display' instead of 'refuse'
//      -> (1c) red; (1a), (1b) and ADJACENT green.
