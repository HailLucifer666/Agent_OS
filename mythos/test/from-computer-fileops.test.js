'use strict';

// Task 4 (file-management tools): move_file/copy_file/rename_file/search_files —
// the write/search side missing from from-computer.js (write_file/create_folder/
// delete_file already existed; list_folder/read_file are the T0 read side).
// Reuses the existing sandbox (resolveSandboxed/isInsideAllowedRoots/allowedRoots),
// same style as folder-write-tools.test.js's symlink-escape coverage.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { TOOLS } = require('../src/core/effectors/from-computer.js');

function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

// Scratch dir lives inside the project root, which allowedRoots() always
// includes — matches folder-write-tools.test.js's own convention.
//
// NOTE: os.tmpdir() is deliberately NOT used as a scratch location here.
// On machines where the real username contains a space, %TEMP%/%TMP%
// resolve to the Windows 8.3 short-name form of the user-profile path (an
// 8-char truncated+~1-suffixed segment), while %USERPROFILE% (the allowed
// root) is the long form. resolveSandboxed()'s check is a plain
// string-prefix compare after path.resolve() — it never resolves short
// names to long names — so an os.tmpdir() path can be (incorrectly) treated
// as outside every allowed root on such a machine even though it's the same
// real location on disk. This is a pre-existing property of
// resolveSandboxed()/allowedRoots(), not something introduced by the four
// tools this file tests — see the roadmap's Task 4 entry for the full note.
const SCRATCH_ROOT = path.resolve(__dirname, '..', '.tmp-fileops-test');
const OUTSIDE_PATH = 'C:\\Windows\\System32\\mythos-fileops-outside-test.txt';

before(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
});

after(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

test('move_file rejects a destination outside the sandbox', async () => {
  const tool = findTool('move_file');
  assert.ok(tool, 'move_file must be registered');
  const src = path.join(SCRATCH_ROOT, 'move-reject-src.txt');
  fs.writeFileSync(src, 'x');
  const res = await tool.fn({ from: src, to: OUTSIDE_PATH }, {});
  assert.equal(res.ok, false);
  assert.match(String(res.result), /outside|allowed|sandbox/i);
  fs.rmSync(src, { force: true });
});

test('search_files caps results and reports truncation', async () => {
  const tool = findTool('search_files');
  assert.ok(tool, 'search_files must be registered');
  const res = await tool.fn({ root: os.homedir(), pattern: '*' }, {});
  if (res.ok) {
    assert.ok(res.result.entries.length <= 50, 'must cap at 50 entries');
    assert.equal(typeof res.result.truncated, 'boolean');
  }
});

test('move_file moves a real file within the sandbox', async () => {
  const tool = findTool('move_file');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'move-'));
  const src = path.join(dir, 'a.txt');
  const dest = path.join(dir, 'sub', 'b.txt');
  fs.writeFileSync(src, 'payload');
  const res = await tool.fn({ from: src, to: dest }, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.existsSync(src), false, 'source must no longer exist after a move');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload');
});

test('move_file rejects when the source is outside the sandbox even if destination is inside', async () => {
  const tool = findTool('move_file');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'move-dest-'));
  const dest = path.join(dir, 'landed.txt');
  const res = await tool.fn({ from: OUTSIDE_PATH, to: dest }, {});
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(dest), false);
});

test('copy_file copies a real file and leaves the source intact', async () => {
  const tool = findTool('copy_file');
  assert.ok(tool, 'copy_file must be registered');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'copy-'));
  const src = path.join(dir, 'orig.txt');
  const dest = path.join(dir, 'copy.txt');
  fs.writeFileSync(src, 'copy-me');
  const res = await tool.fn({ from: src, to: dest }, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.existsSync(src), true, 'source must survive a copy');
  assert.equal(fs.readFileSync(src, 'utf8'), 'copy-me');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'copy-me');
});

test('copy_file rejects a destination outside the sandbox and leaves source intact', async () => {
  const tool = findTool('copy_file');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'copy-escape-'));
  const src = path.join(dir, 'orig.txt');
  fs.writeFileSync(src, 'keep-me');
  const res = await tool.fn({ from: src, to: OUTSIDE_PATH }, {});
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(src), true);
});

test('rename_file renames within the same parent directory', async () => {
  const tool = findTool('rename_file');
  assert.ok(tool, 'rename_file must be registered');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'rename-'));
  const src = path.join(dir, 'old.txt');
  const dest = path.join(dir, 'new.txt');
  fs.writeFileSync(src, 'rename-me');
  const res = await tool.fn({ from: src, to: dest }, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'rename-me');
});

test("rename_file fails across different parent directories (that is move_file's job)", async () => {
  const tool = findTool('rename_file');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'rename-cross-'));
  const src = path.join(dir, 'old.txt');
  const destDir = path.join(dir, 'sub');
  fs.mkdirSync(destDir);
  const dest = path.join(destDir, 'old.txt');
  fs.writeFileSync(src, 'stay-put');
  const res = await tool.fn({ from: src, to: dest }, {});
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(src), true, 'a rejected rename must not move the file');
});

test('search_files finds a file that exists under the sandboxed root', async () => {
  const tool = findTool('search_files');
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'search-'));
  fs.writeFileSync(path.join(dir, 'target-needle.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'unrelated.md'), 'x');
  const res = await tool.fn({ root: dir, pattern: '*needle*' }, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const names = res.result.entries.map((e) => e.name);
  assert.ok(names.includes('target-needle.txt'));
  assert.ok(!names.includes('unrelated.md'));
});

test('search_files rejects a root outside the sandbox', async () => {
  const tool = findTool('search_files');
  const res = await tool.fn({ root: 'C:\\Windows\\System32', pattern: '*' }, {});
  assert.equal(res.ok, false);
  assert.match(String(res.result), /outside|allowed|sandbox/i);
});

test('all four tools are registered with the correct danger flag', () => {
  const dangerTrue = ['move_file', 'copy_file', 'rename_file'];
  const dangerFalse = ['search_files'];
  dangerTrue.forEach((name) => {
    const tool = findTool(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.danger, true, `${name} must be danger:true`);
  });
  dangerFalse.forEach((name) => {
    const tool = findTool(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.danger, false, `${name} must be danger:false`);
  });
});
