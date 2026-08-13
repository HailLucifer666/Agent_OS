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
  it('writes build/release-notes.md with a sensible body, then cleans up', () => {
    // This exercises the same path `node scripts/build-release-notes.js v0.1.9`
    // does by hand, but must leave no trace: build/release-notes.md is
    // gitignored precisely because release.js's preflight blocks on any
    // untracked file, so a test that left it behind would itself block the
    // next real release.
    const fs = require('fs');
    const existedBefore = fs.existsSync(notes.OUT_PATH);
    const before = existedBefore ? fs.readFileSync(notes.OUT_PATH, 'utf8') : null;
    try {
      const code = notes.main(['v0.1.8']);
      assert.equal(code, 0);
      assert.equal(fs.existsSync(notes.OUT_PATH), true);
      const written = fs.readFileSync(notes.OUT_PATH, 'utf8');
      assert.match(written, /^## MYTHOS \d+\.\d+\.\d+/);
      assert.ok(written.length <= notes.MAX_LENGTH);
    } finally {
      if (existedBefore) fs.writeFileSync(notes.OUT_PATH, before, 'utf8');
      else fs.rmSync(notes.OUT_PATH, { force: true });
    }
  });
});
