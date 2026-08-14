'use strict';

// installer-path-budget.test.js — BUG-227. Keep the packaged tree inside
// Windows' 260-character MAX_PATH, with room for the installer's temp directory.
//
// NUMBERING NOTE: the commit that introduced this file (18fff47) says "BUG-226".
// A concurrent session in the same worktree had already committed a different
// BUG-226 (mojibaked spoken failure text, ef7db13) minutes earlier, so this one
// was renumbered to 227 in the ledger. The commit message is left as-is rather
// than rewritten — history is not worth editing for a label, but a reader who
// greps "BUG-226" and lands here should know why the numbers disagree.
//
// THE BUG THIS FILE EXISTS FOR (operator, 2026-08-14): installing 0.1.9 on a NEW
// PC failed partway through with "…cannot be closed. Please close it manually and
// click Retry to continue" while MYTHOS was not running, and Retry looped forever.
//
// That message is a lie told by electron-builder's own template:
// app-builder-lib/templates/nsis/include/extractAppPackage.nsh raises it after
// CopyFiles sets an error 5 times, whatever the cause. There is no process check.
//
// The real cause was arithmetic. NSIS extracts the app to $PLUGINSDIR\7z-out
// BEFORE copying it to $INSTDIR, and that temp path is ~63 characters
// (%LOCALAPPDATA%\Temp\nsXXXXX.tmp\7z-out, expanded). The longest path in the
// app was 198:
//   \resources\app.asar.unpacked\mythos\node_modules\@huggingface\transformers
//     \node_modules\onnxruntime-web\lib\onnxjs\ort-schema\flatbuffers\onnxruntime
//     \fbs\deprecated-node-index-and-kernel-def-hash.js
// 63 + 198 = 261. MAX_PATH is 260. One character over, so the copy could never
// succeed and no number of retries would help. The install DRIVE is irrelevant —
// the failure happens in TEMP on C: before $INSTDIR is touched.
//
// WHY IT WAS NEVER SEEN: the development machine has
// HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1, which is
// NOT the Windows default. Every install ever tested happened on the one machine
// where this bug is invisible. That is the reusable lesson, and it is why this
// test exists rather than a note in a runbook: a dev box configured unlike a
// user's box hides a whole class of bug, so the budget has to be machine-checked.
//
// THE FIX: `build.asarUnpack` was "mythos/**/*", which unpacked 5,636 of 5,713
// files — including three vendored copies of onnxruntime-web's `lib/onnxjs/
// ort-schema` TypeScript sources. Those are pure JS/TS that only ever run inside
// the forked server child, which is Electron with ELECTRON_RUN_AS_NODE=1 and
// therefore CAN require from inside app.asar (verified against the real installed
// build before making the change). Keeping them archived removes their paths from
// the filesystem entirely: longest path 198 -> 145, files on disk 5,713 -> 3,878.
//
// Native modules are deliberately still unpacked — Windows cannot load a DLL or
// .node from inside an archive.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PKG = require(path.join(REPO_ROOT, 'package.json'));

// Where the installer puts unpacked files, relative to the install root. This is
// the prefix every unpacked path carries on disk, and it counts against MAX_PATH.
const UNPACK_PREFIX = '\\resources\\app.asar.unpacked\\';

// 260 (MAX_PATH) minus 80 for the worst-case NSIS temp directory. The measured
// temp path on the dev machine is 63; 80 leaves room for a longer Windows
// account name, which is exactly the variable that differs between the machine
// that builds and the machine that installs.
const MAX_PATH = 260;
const TEMP_BUDGET = 80;
const LIMIT = MAX_PATH - TEMP_BUDGET;   // 180

// Directories that never reach the installer (build.files excludes them) or that
// would only make this check pessimistic. Kept deliberately short: over-including
// makes the test STRICTER, which is the safe direction.
const SKIP_DIRS = new Set(['test', 'test-fixtures', 'Plans', 'vault', '.venv', 'models', '.cache', 'e2e']);

// F2c: nothing is archived any more — both trees unpack, because kokoro-tts
// cannot import them from inside the asar. What no longer reaches disk is the
// one directory that actually caused the overflow, excluded from build.files.
// It is skipped here for the same reason ARCHIVED used to be: its paths are not
// in the package, so they must not count against the budget. The config
// assertion above is what guarantees that stays true.
const ARCHIVED = [];
const EXCLUDED_SUBTREES = [path.join('onnxruntime-web', 'lib')];

function longestUnpackedPath(dir, relParts, worst) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return worst;   // unreadable directory is not this test's business
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (ARCHIVED.includes(name)) continue;
      if (EXCLUDED_SUBTREES.some((s) => path.join(dir, name).endsWith(path.sep + s))) continue;
      worst = longestUnpackedPath(path.join(dir, name), relParts.concat(name), worst);
    } else {
      const rel = relParts.concat(name).join('\\');
      const total = UNPACK_PREFIX.length + rel.length;
      if (total > worst.length) worst = { length: total, rel };
    }
  }
  return worst;
}

describe('BUG-227 installer path budget (Windows MAX_PATH)', () => {
  // F2c (2026-08-15) — REVISED, and the revision is the point.
  //
  // BUG-227's fix archived the two deep trees. That held MAX_PATH and BROKE the
  // local TTS provider: kokoro-tts.js reaches @huggingface/transformers through
  // `await import(...)`, and Node's ESM loader does NOT go through the patched
  // fs that gives CJS `require()` its asar support. The 18fff47 commit message
  // says dynamic import() was verified against the real build — it was, against
  // kokoro-js, which stayed unpacked; the archived dependency was never the one
  // exercised. Measured on 2026-08-14 at 21:45:59:
  //   tts.provider-failed kokoro-tts "Cannot find package '@huggingface/transformers'"
  // arriving 4ms after gemini-tts hit its quota and edge-tts was not running, so
  // speech fell through to window.speechSynthesis — the second voice.
  //
  // The MAX_PATH offender was never @huggingface itself. It was ONE directory:
  // onnxruntime-web's `lib/` (TypeScript sources and .map files for the ort-schema
  // flatbuffers). Every published entry point resolves into `dist/`, so `lib/` is
  // not loaded at runtime by anything. Dropping it from `files` — so it is not in
  // the package at all, archived or not — takes the deepest path under these trees
  // from 198 to well inside the budget while letting both unpack normally.
  //
  // Both halves are asserted here because either alone is a regression: unpacking
  // without the lib/ exclusion reintroduces the failed install, and excluding lib/
  // while still archiving the trees leaves kokoro-tts dead.
  it('unpacks the trees kokoro-tts imports, and drops the tree that overflowed MAX_PATH', () => {
    const unpack = (PKG.build && PKG.build.asarUnpack) || [];
    const files = (PKG.build && PKG.build.files) || [];

    for (const archived of ['!**/onnxruntime-web/**', '!**/@huggingface/**']) {
      assert.ok(!unpack.includes(archived),
        archived + ' must NOT be archived: kokoro-tts.js loads @huggingface/transformers via '
        + 'dynamic import(), which cannot read from inside app.asar, and transformers statically '
        + 'imports onnxruntime-web/webgpu (backends/onnx.js:24) whether or not it is used.');
    }

    assert.ok(files.includes('!**/onnxruntime-web/lib{,/**/*}'),
      'onnxruntime-web/lib is the ~198-char ort-schema TypeScript tree that overflowed MAX_PATH. '
      + 'Nothing loads it — every export in its package.json resolves into dist/ — so it is '
      + 'excluded from the package rather than archived.');
  });

  it('the excluded onnxruntime-web tree really is unreferenced by its entry points', () => {
    // Guard on the load-bearing claim above: if a future version starts routing an
    // export through lib/, excluding it becomes a silent runtime break instead of
    // a saved 60 characters.
    const ortPkgPath = path.join(REPO_ROOT, 'mythos', 'node_modules', '@huggingface',
      'transformers', 'node_modules', 'onnxruntime-web', 'package.json');
    if (!fs.existsSync(ortPkgPath)) return;   // deps not installed — nothing to check
    const ort = JSON.parse(fs.readFileSync(ortPkgPath, 'utf8'));
    const targets = JSON.stringify([ort.main, ort.module, ort.types, ort.exports]);
    assert.ok(!/["/]lib\//.test(targets),
      'an onnxruntime-web entry point now resolves into lib/, which the build excludes: '
      + targets);
  });

  it('still unpacks native modules, which cannot load from an archive', () => {
    const unpack = (PKG.build && PKG.build.asarUnpack) || [];
    assert.ok(unpack.some((p) => p === 'mythos/**/*'),
      'the broad unpack must remain: ps-automation.ps1 is read by powershell.exe, piper-server.py '
      + 'by python, vault-sync.js by a spawned process, and MYTHOS_DIR is used as a fork cwd — '
      + 'none of which can come from inside an archive. Only the two pure-JS trees are excluded.');

    const natives = ['onnxruntime-node', '@img'];
    for (const pkg of natives) {
      assert.ok(!unpack.includes(`!**/${pkg}/**`),
        `${pkg} ships .node/.dll binaries; Windows cannot load those from inside app.asar. `
        + 'It must stay unpacked.');
    }
  });

  it('the longest path that will land on disk stays inside the budget', () => {
    const mythosDir = path.join(REPO_ROOT, 'mythos');
    const worst = longestUnpackedPath(mythosDir, ['mythos'], { length: 0, rel: '(none)' });

    assert.ok(worst.length > 0, 'the walk found no files — the test is not measuring anything');
    assert.ok(worst.length <= LIMIT,
      `longest packaged path is ${worst.length} chars, over the ${LIMIT} budget `
      + `(${MAX_PATH} MAX_PATH minus ${TEMP_BUDGET} for the installer's temp dir).\n`
      + `  ${worst.rel}\n`
      + 'A fresh install on a machine WITHOUT LongPathsEnabled will fail partway through with '
      + '"cannot be closed" and retry forever. Either keep the offending tree inside the asar '
      + '(build.asarUnpack) or exclude it from the build (build.files).');

    // Stronger form of the SAME assertion when a real build is present — folded
    // into this test rather than given its own `it` with a t.skip().
    //
    // It had one, and that was a mistake worth recording: dist/ comes and goes,
    // so the suite's skip count flipped between 0 and 1 depending on whether a
    // build happened to exist. This repo gates commits on the test counts written
    // into README/ROADMAP (scripts/sync-test-count.js), so a build artifact could
    // silently make those numbers stale and block an unrelated commit — which is
    // exactly what it did. A test whose COUNT depends on untracked local state is
    // a broken test even when its assertion is right.
    const built = path.join(REPO_ROOT, 'dist', 'win-unpacked');
    const unpacked = path.join(built, 'resources', 'app.asar.unpacked');
    if (!fs.existsSync(unpacked)) return;
    // A build older than the packaging config says nothing about that config.
    if (fs.statSync(unpacked).mtimeMs < fs.statSync(path.join(REPO_ROOT, 'package.json')).mtimeMs) return;

    let worstLen = 0;
    let worstPath = '';
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const rel = full.slice(built.length);
        if (rel.length > worstLen) { worstLen = rel.length; worstPath = rel; }
      }
    };
    walk(built);
    assert.ok(worstLen <= LIMIT,
      `the BUILT tree's longest path is ${worstLen} chars, over the ${LIMIT} budget:\n  ${worstPath}`);
  });
});
