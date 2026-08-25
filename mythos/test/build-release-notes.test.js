'use strict';

// scripts/build-release-notes.js — release notes from the commit log, so the
// built latest.yml's releaseNotes field is never structurally empty again
// (electron-publish's createRelease() has never sent a `body`, so nothing
// upstream of this script ever produced one).
//
// Run: cd mythos && node --test test/build-release-notes.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const notes = require(path.join(__dirname, '..', '..', 'scripts', 'build-release-notes.js'));

describe('parseVersion', () => {
  it('parses x.y.z and vx.y.z alike', () => {
    assert.deepEqual(notes.parseVersion('1.2.3'), [1, 2, 3]);
    assert.deepEqual(notes.parseVersion('v1.2.3'), [1, 2, 3]);
  });

  it('rejects nonsense', () => {
    assert.equal(notes.parseVersion('not-a-version'), null);
    assert.equal(notes.parseVersion('wip-local-widgets-2026-08-03'), null);
    assert.equal(notes.parseVersion(''), null);
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok(notes.compareVersions([1, 0, 0], [0, 9, 9]) > 0);
    assert.ok(notes.compareVersions([0, 1, 0], [0, 2, 0]) < 0);
    assert.ok(notes.compareVersions([0, 1, 5], [0, 1, 4]) > 0);
    assert.equal(notes.compareVersions([0, 1, 4], [0, 1, 4]), 0);
  });
});

describe('pickPreviousTag', () => {
  it('picks the highest tag strictly below the current version', () => {
    const tags = ['v0.1.6', 'v0.1.7', 'v0.1.8', 'v0.1.9'];
    assert.equal(notes.pickPreviousTag(tags, '0.1.10'), 'v0.1.9');
  });

  it('ignores tags that are not x.y.z, like a stray branch-name tag', () => {
    const tags = ['wip-local-widgets-2026-08-03', 'v0.1.8', 'v0.1.9'];
    assert.equal(notes.pickPreviousTag(tags, '0.1.10'), 'v0.1.9');
  });

  it('never picks a tag at or above the current version', () => {
    const tags = ['v0.1.9', 'v0.2.0'];
    assert.equal(notes.pickPreviousTag(tags, '0.1.9'), null);
  });

  it('returns null when there is nothing below the current version', () => {
    assert.equal(notes.pickPreviousTag(['v0.1.0'], '0.1.0'), null);
    assert.equal(notes.pickPreviousTag([], '0.1.0'), null);
  });
});

describe('buildReleaseNotesBody', () => {
  it('headers with the version and lists the commits', () => {
    const body = notes.buildReleaseNotesBody('0.1.10', ['- feat: x', '- fix: y']);
    assert.match(body, /^## MYTHOS 0\.1\.10\n\n/);
    assert.match(body, /- feat: x/);
    assert.match(body, /- fix: y/);
  });

  it('falls back to an honest line instead of an empty body when there are no commits', () => {
    const body = notes.buildReleaseNotesBody('0.1.10', []);
    assert.match(body, /no commit-log entries found/);
  });

  it('drops blank lines rather than emitting empty bullets', () => {
    const body = notes.buildReleaseNotesBody('0.1.10', ['- a', '', '- b']);
    assert.equal(body, '## MYTHOS 0.1.10\n\n- a\n- b');
  });
});

describe('capLength', () => {
  it('leaves short text untouched', () => {
    assert.equal(notes.capLength('short', 4000), 'short');
  });

  it('caps long text at the limit and cuts on a line boundary', () => {
    const lines = [];
    for (let i = 0; i < 500; i += 1) lines.push(`- commit number ${i} with some padding text`);
    const long = lines.join('\n');
    assert.ok(long.length > 4000, 'fixture must actually exceed the cap to test it');
    const capped = notes.capLength(long, 4000);
    assert.ok(capped.length <= 4000, `capped output must not exceed the limit (got ${capped.length})`);
    assert.match(capped, /…\(truncated\)$/);
    // No half-written commit line: everything before the truncation note must
    // be intact lines that existed in the original text.
    const withoutSuffix = capped.replace(/\n\n…\(truncated\)$/, '');
    for (const line of withoutSuffix.split('\n')) {
      assert.ok(long.includes(line), `truncated output introduced a line not in the source: ${line}`);
    }
  });

  it('never leaves a lone UTF-16 surrogate at the cut point', () => {
    // A codepoint outside the BMP (e.g. an emoji) is two UTF-16 code units.
    // .slice() cuts by code unit, so a budget landing exactly between them
    // must not leave a lone high surrogate — encodeURIComponent throws on
    // exactly that (a malformed URI), which is a direct proof of validity.
    const suffixLength = '\n\n…(truncated)'.length;
    const pair = '😀'; // U+1F600 GRINNING FACE, as a surrogate pair
    const text = `${'a'.repeat(20)}${pair}${'b'.repeat(20)}`;
    // Budget of 21 code units lands the cut one past the 20 a's, i.e. exactly
    // on the high surrogate alone, with no newline anywhere to trim to first.
    const capped = notes.capLength(text, 21 + suffixLength);
    assert.doesNotThrow(() => encodeURIComponent(capped), /malformed/);
  });
});

describe('collectCommitLog against this repo\'s real history', () => {
  it('returns commit subjects between two real tags', () => {
    // v0.1.8..v0.1.9 is real, already-tagged history in this repo — using it
    // (rather than a synthetic fixture) is the same idiom release-script.test.js
    // uses for evaluatePreflight's git-dependent siblings.
    const lines = notes.collectCommitLog('v0.1.8');
    assert.ok(Array.isArray(lines));
    // Whatever is between v0.1.8 and the current HEAD, every line must be a
    // real "- subject" bullet, never a blank or malformed entry.
    for (const line of lines) {
      assert.match(line, /^- /);
    }
  });

  it('falls back to full history from HEAD when there is no previous tag', () => {
    const lines = notes.collectCommitLog(null);
    assert.ok(lines.length > 0, 'this repo has commit history reachable from HEAD');
    assert.match(lines[0], /^- /);
  });
});

describe('readVersion', () => {
  it('reads the real package.json version as x.y.z', () => {
    const version = notes.readVersion();
    assert.match(version, /^\d+\.\d+\.\d+$/);
  });
});

describe('main() end to end against real history', () => {
  it('writes a sensible body to an INJECTED path, never touching the real repo', () => {
    // This exercises the same path `node scripts/build-release-notes.js v0.1.9`
    // does by hand, but at a temp path — the standing lesson in this repo (see
    // the wakeword-test EPERM scar) is that a test mutating a real, gitignored
    // production path can destroy it if a restore-in-finally loses a race.
    // Injecting the destination instead of touching OUT_PATH removes that risk
    // entirely rather than mitigating it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-release-notes-'));
    const tmpPath = path.join(tmpDir, 'release-notes.md');
    const code = notes.main(['v0.1.8'], tmpPath);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(tmpPath), true);
    const written = fs.readFileSync(tmpPath, 'utf8');
    assert.match(written, /^## MYTHOS \d+\.\d+\.\d+/);
    assert.ok(written.length <= notes.MAX_LENGTH);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to the real build/release-notes.md when no path is injected', () => {
    // Pins the seam this fix was added to protect: scripts/release.js and the
    // CI workflow step both call main() with no output-path argument, so the
    // default must keep resolving to the exact file app-builder-lib reads.
    assert.equal(notes.OUT_PATH, path.join(path.resolve(__dirname, '..', '..'), 'build', 'release-notes.md'));
  });
});

describe('a failed git command is not silently mistaken for an empty result', () => {
  it('collectCommitLog throws, rather than degrading to an empty log, when the range is invalid', () => {
    // A range naming a ref that does not exist makes git exit non-zero — this
    // must surface as a loud failure, not the same [] a genuinely empty range
    // between two adjacent real commits would produce.
    assert.throws(() => notes.collectCommitLog('this-tag-does-not-exist-anywhere'), /git log/);
  });
});
