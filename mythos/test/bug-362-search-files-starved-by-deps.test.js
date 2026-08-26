'use strict';

// BUG-362 (search_files) and BUG-368 (index_project) — one root cause, two tools.
//
// Both walked the tree depth-first from a project root where a dependency
// directory sorts early, and both charged that dependency tree against the
// budget meant for the whole search. Measured on the MAIN CHECKOUT, 2026-08-27:
//
//   search_files({root:'.', pattern:'package.json'})  -> entries: [], truncated: true, ok: TRUE
//   ...and the same zero for ROADMAP.md, from-pc.js, doctor.js, lanes.default.js.
//   index_project over mythos/  -> 2000 files, 1879 of them (94%) from .venv,
//                                  ZERO from src/, ZERO from test/,
//                                  and from-pc.js not indexed at all.
//
// THE REMEDY THE TICKET PROPOSED DOES NOT WORK. BUG-362 suggested skipping
// node_modules/.git "the way any file search is expected to". Measured, that
// changes nothing: `.venv` is 5,202 entries within depth 6 and exhausts a 5,000
// budget on its own, before node_modules is reached. Breadth-first is what
// actually fixes it, because every entry at the current depth is tested before
// any recursion — a property, not a list. See file-walk.js.
//
// WHY THESE TESTS BUILD THEIR OWN TREE INSTEAD OF SEARCHING THIS REPO.
// In a git worktree, setup-worktree.js links `.venv` as a junction, and a Dirent
// for a junction reports isDirectory() === false — so a worktree charges ONE
// entry for it and never recurses. Both bugs vanish there. A test that walked
// the repo would pass in a worktree for a reason unrelated to the fix, which is
// the definition of a false green.
//
// Scratch lives under the project root, NOT os.tmpdir(), following the reason
// documented at length in from-computer-fileops.test.js: on a machine whose
// username contains a space, %TEMP% is the 8.3 short form while the allowed root
// is the long form, and resolveSandboxed()'s prefix compare then treats a temp
// path as outside every allowed root. The path is still derived (__dirname), so
// the AD-7 no-hardcoded-paths gate is satisfied.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const { SKIP_DIRS, walkBreadthFirst } = require('../src/core/effectors/file-walk');
const { TOOLS, search_files } = require('../src/core/effectors/from-computer');
const { createCodeSearchEffector } = require('../src/core/effectors/from-code-search');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createVectorIndex } = require('../src/core/memory/vector-index');

const SCRATCH_ROOT = path.resolve(__dirname, '..', '.tmp-file-walk-test');
const BIG = 5100; // > MAX_SEARCH_SCAN (5000), so the sibling alone exhausts the budget

before(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
});
after(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function freshDir(name) {
  const d = path.join(SCRATCH_ROOT, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A project-shaped tree: a shallow target, and a dependency directory that
// sorts BEFORE it and is large enough to exhaust the scan budget on its own.
// 'deps' < 'target.txt' alphabetically, which is the ordering that bites.
function projectWithHugeDependency(name, depName) {
  const root = freshDir(name);
  const dep = path.join(root, depName || 'deps');
  fs.mkdirSync(dep, { recursive: true });
  for (let i = 0; i < BIG; i++) fs.writeFileSync(path.join(dep, 'f' + i + '.bin'), '');
  fs.writeFileSync(path.join(root, 'target.txt'), 'x');
  return root;
}

// ---------------------------------------------------------------- the traversal

test('a shallow match is not starved by a huge sibling walked before it', () => {
  const root = freshDir('bfs-basic');
  fs.mkdirSync(path.join(root, 'aaa-deep'), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'aaa-deep', 'x' + i + '.bin'), '');
  fs.writeFileSync(path.join(root, 'zzz-target.txt'), 'x');

  // Budget deliberately smaller than the sibling, so only ordering can save it.
  const r = walkBreadthFirst(root, {
    match: (n) => n === 'zzz-target.txt',
    maxScan: 20,
    skipDirs: new Set(),
  });
  assert.equal(r.entries.length, 1, 'the root-level target must be found');
  assert.equal(r.entries[0].name, 'zzz-target.txt');
});

test('NEGATIVE CONTROL: depth-first with the same budget finds nothing', () => {
  // The bug, reproduced, so the test above cannot pass for an unrelated reason.
  const root = freshDir('dfs-control');
  fs.mkdirSync(path.join(root, 'aaa-deep'), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'aaa-deep', 'x' + i + '.bin'), '');
  fs.writeFileSync(path.join(root, 'zzz-target.txt'), 'x');

  const found = [];
  let scanned = 0;
  let stopped = false;
  (function dfs(dir) {
    if (stopped) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (stopped) return;
      scanned++;
      if (scanned > 20) { stopped = true; return; }
      if (e.name === 'zzz-target.txt') found.push(e.name);
      if (e.isDirectory()) dfs(path.join(dir, e.name));
    }
  })(root);

  assert.equal(found.length, 0,
    'depth-first with a 20-entry budget must NOT reach the root target — this is the bug');
  assert.equal(stopped, true, 'and it must have stopped early rather than finished');
});

test('matches come back shallowest-first', () => {
  const root = freshDir('bfs-order');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hit.txt'), 'x');
  fs.writeFileSync(path.join(root, 'a', 'hit.txt'), 'x');
  fs.writeFileSync(path.join(root, 'a', 'b', 'hit.txt'), 'x');

  const r = walkBreadthFirst(root, { match: (n) => n === 'hit.txt', skipDirs: new Set() });
  const depths = r.entries.map((e) => e.full.slice(root.length).split(path.sep).filter(Boolean).length - 1);
  assert.deepEqual(depths, [0, 1, 2],
    'shallowest first — the ordering is what makes a truncated result still useful');
});

test('skip-listed directories are not descended into', () => {
  const root = freshDir('bfs-skip');
  fs.mkdirSync(path.join(root, '.venv'), { recursive: true });
  fs.writeFileSync(path.join(root, '.venv', 'hit.txt'), 'x');
  fs.writeFileSync(path.join(root, 'hit.txt'), 'x');

  const r = walkBreadthFirst(root, { match: (n) => n === 'hit.txt' });
  assert.equal(r.entries.length, 1, 'only the project copy, not the one inside .venv');
  assert.equal(path.dirname(r.entries[0].full), root);
});

test('maxDepth is respected', () => {
  const root = freshDir('bfs-depth');
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'hit.txt'), 'x');
  assert.equal(walkBreadthFirst(root, { match: (n) => n === 'hit.txt', maxDepth: 1 }).entries.length, 0);
  assert.equal(walkBreadthFirst(root, { match: (n) => n === 'hit.txt', maxDepth: 6 }).entries.length, 1);
});

test('a junction inside the tree is NOT descended into, so the walk cannot leave the sandbox', (t) => {
  // Containment today is a property of using entry.isDirectory() (a Dirent
  // reports false for a junction) rather than statSync(full).isDirectory().
  // Nothing else enforces it, and switching to statSync reads like a robustness
  // improvement — so this pins it. Measured before the fix too: search_files
  // was already contained, for exactly this reason.
  const root = freshDir('bfs-junction');
  const outside = freshDir('bfs-junction-outside');
  fs.writeFileSync(path.join(outside, 'ESCAPED.txt'), 'x');
  fs.writeFileSync(path.join(root, 'inside.txt'), 'x');

  const link = path.join(root, 'jump');
  cp.spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8' });
  if (!fs.existsSync(link)) return t.skip('could not create a junction on this machine');

  const r = walkBreadthFirst(root, { match: () => true, skipDirs: new Set() });
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes('inside.txt'), 'the real file inside the tree is still found');
  assert.ok(!names.includes('ESCAPED.txt'),
    'a junction planted inside the tree must not be followed out of it');
  cp.spawnSync('cmd', ['/c', 'rmdir', link]);
});

// ---------------------------------------------------------------- search_files

test('BUG-362: search_files finds a root-level file despite a budget-exhausting sibling', () => {
  const root = projectWithHugeDependency('sf-repro');
  const res = search_files({ root, pattern: 'target.txt' });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  assert.equal(res.result.entries.length, 1, 'the root-level file must be found');
  assert.equal(res.result.entries[0].name, 'target.txt');
});

test('BUG-362: a walk that gave up having found nothing FAILS instead of reporting an empty success', () => {
  const root = projectWithHugeDependency('sf-truncated');
  const res = search_files({ root, pattern: 'no-such-needle-*.qqq' });
  assert.equal(res.ok, false,
    'entries:[] with truncated:true was reported as ok:true, which is indistinguishable from an honest miss');
  assert.match(String(res.result), /NOT "no such file"/,
    'the reason must say plainly that this is not a not-found result');
  assert.match(String(res.result), /narrower root/,
    'and must name the recovery, because a caller cannot act on "it was truncated"');
});

test('BUG-362: an HONEST miss still succeeds, and stays distinguishable from giving up', () => {
  const root = freshDir('sf-honest-miss');
  fs.writeFileSync(path.join(root, 'something.txt'), 'x');
  const res = search_files({ root, pattern: 'absent-*.qqq' });
  assert.equal(res.ok, true, 'a small tree fully searched with no match is a real answer');
  assert.equal(res.result.entries.length, 0);
  assert.equal(res.result.truncated, false,
    'truncated:false is what separates "searched it all, not there" from "gave up"');
});

test("search_files' own description warns that dependency folders are excluded", () => {
  // The tool description IS the model's contract. A search that silently skips
  // node_modules while the description promises a plain search is a different
  // flavour of the same dishonesty this bug is about.
  const tool = TOOLS.find((t) => t.name === 'search_files');
  assert.ok(tool, 'search_files must be registered');
  assert.match(tool.description, /node_modules/, 'the exclusion must be stated to the model');
  assert.match(tool.description, /Shallowest matches are returned first/,
    'ordering is load-bearing when a result is truncated, so the model must know it');
});

// ---------------------------------------------------------------- index_project

test('BUG-368: index_project does not index a Python virtualenv', async () => {
  const dir = freshDir('idx-venv');
  fs.writeFileSync(path.join(dir, 'real-source.js'), 'function foo() { return 1; }\n');
  fs.mkdirSync(path.join(dir, '.venv', 'Lib', 'site-packages', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv', 'Lib', 'site-packages', 'dep', 'mod.py'), 'def x():\n    return 1\n');

  const files = new Map();
  const memfs = {
    readJSON: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    readJSONStrict: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJSON: (p, d) => { files.set(p, JSON.stringify(d)); },
    ensureDir: () => {},
    vaultPath: (...s) => s.join('/'),
  };
  const documents = createDocumentsStore({ fs: memfs });
  const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
  documentsIndex.init();
  const embed = () => Promise.resolve({ provider: 'fake', dim: 2, vec: Float32Array.from([1, 0]) });

  const res = await createCodeSearchEffector({ documents, documentsIndex, embed }).index_project({ dir });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
  assert.equal(res.result.filesIndexed, 1,
    'only real-source.js — a .venv full of .py files must not become the code index');
});

test('BUG-368: both file walkers share ONE skip-list, and it covers .venv', () => {
  // The bug was two sibling tools with two different sets of rules: search_files
  // had no list at all, and from-code-search had one without .venv. Sharing the
  // set is what stops a future addition fixing one tool and not the other.
  for (const d of ['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist']) {
    assert.ok(SKIP_DIRS.has(d), d + ' must be on the shared skip-list');
  }
  assert.ok(!SKIP_DIRS.has('src') && !SKIP_DIRS.has('test') && !SKIP_DIRS.has('env'),
    'project content must stay searchable — a skip-list that swallows source fails in the direction nobody checks');

  const codeSearchSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'core', 'effectors', 'from-code-search.js'), 'utf8');
  assert.match(codeSearchSrc, /require\('\.\/file-walk'\)/,
    'from-code-search must take the shared list rather than declare a second one');
});

test('the result cap trips and reports truncation', () => {
  // Survived a mutation on the first pass: deleting the maxEntries check broke
  // no test, so nothing pinned the cap the tool description promises.
  const root = freshDir('bfs-cap');
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(root, 'hit' + i + '.txt'), 'x');
  const r = walkBreadthFirst(root, { match: (n) => n.startsWith('hit'), maxEntries: 5 });
  assert.equal(r.entries.length, 5, 'must stop at maxEntries');
  assert.equal(r.truncated, true, 'and must say it stopped early');
});
