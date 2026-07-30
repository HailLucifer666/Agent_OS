'use strict';

// test/anti-drift-no-absolute-paths.test.js — AD-7 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "Portability. No
// user-specific or machine-specific absolute path in any tracked file. Everything
// from os.homedir()/process.env/%~dp0." (Same rule as CLAUDE.md's "Open-source
// portability" section: anyone supplying their own keys must be able to run this
// on their machine — a hardcoded personal path breaks that on day one.)
//
// Executable check, per the spine's own table: fail on a Windows user-profile path
// (a drive letter + `\Users\<name>\...`) or a Unix home path (`/home/<name>/...`)
// in any git-tracked file.
//
// Deliberately requires a real path SEGMENT after the username, not just the bare
// root (`C:\Users\bob` / `/home/bob` alone) — a fixture like `HOME: '/home/op'` in
// a unit test is a synthetic placeholder asserting env-var passthrough, not a
// reference to any real machine, and flagging it would be exactly the kind of
// blunt-regex false positive that makes an anti-drift test get muted rather than
// trusted (see test/phase3-run-command.test.js:59,73 for the fixture this excludes).
//
// 2026-07-30: found and fixed two real hits before this test was added — the V2
// spine plan doc quoted a real Windows user-profile path (drive letter, "Users",
// a real name, a subpath) in its recovery narrative, and a verify script's
// comment embedded a real 8.3 short-name derived from the same name. Both
// rewritten to drop the literal path shape entirely (an env-var-style
// placeholder for the first, a prose description of the short-name shape for
// the second — deliberately not shown *here* either, or this comment would trip
// its own check). This test now passes; it exists so a future hardcoded path
// gets caught before it merges, not found by accident during an unrelated audit
// like this one was.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
// Windows: <drive>:\Users\<name>\<at least one more segment>
const WINDOWS_RE = /[A-Za-z]:\\Users\\[^\\\s'"]+\\[^\s'"]+/;
// Unix: /home/<name>/<at least one more segment>
const UNIX_RE = /\/home\/[a-z][a-z0-9_-]*\/[^\s'")]+/;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.wasm', '.woff', '.woff2', '.ttf', '.eot', '.zip']);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('AD-7: no user-specific or machine-specific absolute path in tracked source', () => {
  const violations = [];
  for (const rel of trackedFiles()) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const full = path.join(REPO_ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // deleted-but-still-staged, submodule entry, etc. — not this test's concern
    }
    content.split('\n').forEach((line, i) => {
      if (WINDOWS_RE.test(line) || UNIX_RE.test(line)) {
        violations.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `hardcoded user/machine-specific absolute path found in: ${violations.join(', ')}`);
});
