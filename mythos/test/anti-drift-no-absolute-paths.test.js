'use strict';

// test/anti-drift-no-absolute-paths.test.js — AD-7 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "Portability. No
// user-specific or machine-specific absolute path in any tracked file. Everything
// from os.homedir()/process.env/%~dp0." (Same rule as CLAUDE.md's "Open-source
// portability" section: anyone supplying their own keys must be able to run this
// on their machine — a hardcoded personal path breaks that on day one.)
//
// Executable check, per the spine's own table: fail on a Windows drive-rooted
// absolute path with two or more path segments (`<drive>:\<seg>\<seg>...`) or a
// Unix home path (`/home/<name>/...`) in any git-tracked file.
//
// Deliberately requires a real path SEGMENT after the drive (not the bare root
// alone) — a fixture like `HOME: '/home/op'` in a unit test is a synthetic
// placeholder asserting env-var passthrough, not a reference to any real
// machine, and flagging it would be exactly the kind of blunt-regex false
// positive that makes an anti-drift test get muted rather than trusted (see
// test/phase3-run-command.test.js:59,73 for the fixture this excludes). The
// same reasoning is why the Windows example illustrating this rule is deliberately
// written below without a literal two-segment path shape — showing one would trip
// this very check.
//
// 2026-08-04: widened from "drive + literal `\Users\<name>\...`" (which only
// caught the personal-profile shape) to any drive-rooted two-segment path, so a
// hardcoded personal path OUTSIDE `\Users\` (a custom install dir, a sibling
// repo clone, a `\vault\` location, etc.) gets caught too — the earlier version
// would have missed all of those by construction. Widening a drive-letter regex
// this far pulls in two classes of non-violation that must be excluded, not
// papered over by muting the test:
//   1. Windows registry PSDrive paths (`HKCU:\...`, `HKLM:\...`) syntactically
//      match `[A-Za-z]:[\\/]` at the LAST letter of the hive name (`U:\` inside
//      `HKCU:\`) — a false match on drive-letter syntax, not a real drive path.
//      Fixed structurally with a negative lookbehind requiring the character
//      before the "drive letter" not be itself a letter/digit/underscore, so a
//      single, standalone letter is required immediately before the colon.
//   2. The same lookbehind also kills the dominant false-positive source in this
//      repo: regex literals and JS string escapes containing `<word>:\<char>`,
//      e.g. `/^\s*base_url:\s*(\S+)/m` matches `l:\s` at the "l" in "url" without
//      the lookbehind. None of this repo's source files had a real drive path in
//      a regex; every one of those hits (setup-hermes.js, web-search.js,
//      identity/index.js, cortex/index.js, design/verify.js, memory/skills.js,
//      ps-automation.ps1's registry keys, several test files) was this shape.
// What the lookbehind does NOT remove — genuine bucket-(b)/(c) matches — is
// handled by GENERIC_PATH_ALLOWLIST below, each entry with its own rationale.
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
// Windows: <drive>:\<segment>\<segment> — any drive-rooted path with two or more
// segments. The lookbehind requires the drive letter to be a standalone token
// (not preceded by another letter/digit/underscore), which is what rules out
// `HKCU:\...`/`HKLM:\...` (matches on the "U"/"M" inside the hive name) and
// `identifier:\escape` regex-literal false positives (matches on the last letter
// of the identifier) without needing to allowlist either class file-by-file.
const WINDOWS_RE = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\\/\s'"]+[\\/][^\s'"]+/;
// Unix: /home/<name>/<at least one more segment>
const UNIX_RE = /\/home\/[a-z][a-z0-9_-]*\/[^\s'")]+/;
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.wasm', '.woff', '.woff2', '.ttf', '.eot', '.zip']);

// Files this test does not scan at all, with a reason each — never a blanket
// "trust everything in this directory" exemption.
const FILE_ALLOWLIST = new Set([
  // This file's own header comment above explains and reasons about the exact
  // path shapes this test matches — genuinely no way to write that explanation
  // without ever showing a matching shape, short of vague prose (already tried,
  // see the 2026-07-30 note above for why that's the fallback of last resort,
  // not the first choice). Self-referential; not a real machine path.
  'mythos/test/anti-drift-no-absolute-paths.test.js',
]);

// Generic, machine-INDEPENDENT Windows paths: fixed by OS convention on every
// Windows install (drive letter aside — Windows can be installed on any drive,
// but the directory name under it is not this operator's personal choice the
// way `\Users\<name>\...` or a custom install dir is). Bucket (b) from the audit
// that produced this list — legitimate, allowlisted by directory name so the
// drive letter itself doesn't matter.
const GENERIC_WINDOWS_DIRS = /^[A-Za-z]:[\\/](Windows|Program Files( \(x86\))?|ProgramData)[\\/]/i;

function isAllowedMatch(matchedText) {
  return GENERIC_WINDOWS_DIRS.test(matchedText);
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('AD-7: no user-specific or machine-specific absolute path in tracked source', () => {
  const violations = [];
  for (const rel of trackedFiles()) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    if (FILE_ALLOWLIST.has(rel.replace(/\\/g, '/'))) continue;
    const full = path.join(REPO_ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue; // deleted-but-still-staged, submodule entry, etc. — not this test's concern
    }
    content.split('\n').forEach((line, i) => {
      const winMatch = WINDOWS_RE.exec(line);
      if (winMatch && !isAllowedMatch(winMatch[0])) {
        violations.push(`${rel}:${i + 1}`);
        return;
      }
      if (UNIX_RE.test(line)) {
        violations.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `hardcoded user/machine-specific absolute path found in: ${violations.join(', ')}`);
});
