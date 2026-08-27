'use strict';

// source-has-no-nul-byte.test.js -- no tracked text source may contain a raw
// 0x00 byte.
//
// THE DEFECT THIS FILE EXISTS FOR (found 2026-08-27):
//   mythos/src/core/memory/habit-promoter.js and
//   mythos/ui/public/js/views/transcript-model.js each carried one literal NUL,
//   in a composite map key of the shape  left + <NUL> + right.  The NUL itself
//   is deliberate and correct -- it is a separator that occurs in neither half,
//   so no two pairs can collide on one key.  Writing it as a RAW BYTE instead of
//   a JavaScript escape was not.
//
//   git classifies an entire file as binary the moment it contains a 0x00 byte.
//   Both files therefore diffed as "Binary files differ": no line-level diff at
//   all, nothing a human can review in a pull request, and grep answering
//   "Binary file ... matches" instead of the matching line.  Every line-based
//   tool over those files was silently blind, and nothing reported it -- the
//   files still parsed, still ran, and still passed their own tests.
//
//   Both fixes were a one-character change of REPRESENTATION: the runtime string
//   is byte-identical, only the source stopped containing the byte.
//
// Same shape as ps-source-is-ascii.test.js beside it -- an invisible byte that
// changes how tooling reads a file, caught by asserting on the bytes rather than
// by hoping the next person to open the file notices something is wrong.
//
// A known way to reintroduce this: some editors and code-generation paths
// INTERPRET the six characters backslash-u-0-0-0-0 in the text they are handed
// and write the resulting NUL byte to disk instead of the escape. That is why
// this test asserts on bytes on disk, not on what a diff appears to show.
//
// What this test deliberately does NOT check: that the separator is still a NUL
// at runtime. This file would pass just as happily if someone "fixed" a NUL
// separator into a visible character, which would be a behaviour change, not a
// representation change. That half is pinned by habit-promotion.test.js and
// chat-panel-transcript.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Extensions whose files are text by definition, so a 0x00 byte in one is always
// a defect. Deliberately excludes images, models, archives and fonts, which are
// legitimately binary.
const TEXT_EXTENSIONS = /\.(js|cjs|mjs|jsx|ts|tsx|json|md|ps1|psm1|py|bat|cmd|sh|css|html|htm|svg|xml|yml|yaml|kt|kts|java|gradle|txt|toml|ini|cfg)$/i;

// git ls-files -z separates paths with a NUL, which is exactly why -z is used
// here: it is the one separator that cannot occur inside a path.
const PATH_SEPARATOR = String.fromCharCode(0);

// Memoized: the list cannot change mid-run, and this file already reads every
// entry once. Spawning git per test would add load to a suite that runs its
// files in parallel and contains timing-sensitive tests with 50ms budgets.
let cachedFiles = null;

function trackedTextFiles() {
  if (cachedFiles) return cachedFiles;
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  cachedFiles = out.split(PATH_SEPARATOR).filter(Boolean).filter((f) => TEXT_EXTENSIONS.test(f));
  return cachedFiles;
}

describe('tracked text sources contain no raw NUL byte', () => {
  it('finds text files to check (an empty list would make this gate vacuous)', () => {
    const files = trackedTextFiles();
    assert.ok(files.length > 100, 'expected the tracked text corpus, got ' + files.length + ' files');
    for (const known of [
      'mythos/src/core/memory/habit-promoter.js',
      'mythos/ui/public/js/views/transcript-model.js',
    ]) {
      assert.ok(
        files.includes(known),
        known + ' is one of the two files this gate was written for and must be covered',
      );
    }
  });

  it('no tracked text file contains a 0x00 byte', () => {
    const offenders = [];
    for (const rel of trackedTextFiles()) {
      let bytes;
      try {
        bytes = fs.readFileSync(path.join(REPO_ROOT, rel));
      } catch (_err) {
        // A tracked path that is not readable here (a symlink into an absent
        // fixture, say) is not this gate's business.
        continue;
      }
      const at = bytes.indexOf(0);
      if (at === -1) continue;
      const from = Math.max(0, at - 50);
      const context = bytes
        .slice(from, at + 30)
        .toString('latin1')
        .replace(/[^\x20-\x7e]/g, '.');
      offenders.push(rel + ' at byte offset ' + at + ': ...' + context + '...');
    }
    assert.deepEqual(
      offenders,
      [],
      'these tracked text files contain a raw NUL byte, so git treats each of them as '
        + 'BINARY: they get no line-level diff, cannot be reviewed in a pull request, and '
        + 'grep reports "Binary file ... matches" instead of the matching line. If the NUL '
        + 'is a deliberate separator, keep it in the VALUE but write it in the SOURCE as a '
        + 'JavaScript escape (backslash-u-0-0-0-0), which is byte-identical at runtime. '
        + 'Beware: some editors turn that escape text back into a real NUL on save -- '
        + 'check the bytes, not the diff.\n'
        + offenders.join('\n'),
    );
  });
});
