'use strict';

// skills-allowlist.test.js — the allowlist must be honest about what a FRESH
// CLONE actually has.
//
// THE PROBLEM THIS FILE EXISTS FOR (2026-08-02).
// skills.allowlist named 16 skills. On the machine that wrote it, all but one
// resolved — because that machine's host CLI happened to have them installed.
// On a fresh clone only 5 did. loadCatalog() recorded the rest in lastMissing
// and moved on, so the operator's prompt silently lost two-thirds of its
// curated guidance with no visible difference in behaviour.
//
// The fix is a '?' prefix meaning "optional: host-installed only, absence is
// expected". That splits the allowlist into a contract and a nicety:
//   * plain entry  -> MUST be vendored in mythos/skills/. A miss is a bug and
//                     is reported through the logger.
//   * '?' entry    -> may be absent. Never reported.
// Without the split there are only two bad options: warn on every clean
// machine (so nobody reads the warning), or warn never (so a genuinely broken
// entry hides forever).
//
// These tests assert against the REAL mythos/skills.allowlist and the REAL
// mythos/skills/ directory, deliberately — the point is to catch someone
// adding an entry that a fresh clone cannot resolve.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER_PATH = require.resolve('../src/core/skills/loader.js');
const REPO_SKILLS_DIR = path.join(__dirname, '..', 'skills');

function freshLoader() {
  delete require.cache[LOADER_PATH];
  return require('../src/core/skills/loader.js');
}

describe('skills allowlist — fresh-clone contract', function() {

  it('parses a leading ? as an optional entry, and strips it from the name', function() {
    const entries = freshLoader()._readAllowlistEntries();
    assert.ok(entries.length > 0, 'the allowlist must not be empty');
    for (const e of entries) {
      assert.equal(typeof e.name, 'string');
      assert.equal(typeof e.optional, 'boolean');
      assert.ok(e.name.length > 0, 'an entry name must be non-empty');
      assert.ok(e.name.charAt(0) !== '?',
        'the ? marker must be stripped from the name, got: ' + e.name);
    }
    assert.ok(entries.some(e => e.optional),
      'at least one optional entry is expected (host-only skills like ui-ux-pro-max)');
  });

  it('reads a YAML block-scalar description instead of capturing the ">" indicator', function() {
    // Regression: caveman and ponytail both shipped `description: >` and the
    // parser captured the indicator character, so their entire catalog line —
    // the one thing the model is told about the skill — was the string ">".
    const loader = freshLoader();
    const folded = loader._parseFrontmatter([
      '---',
      'name: demo',
      'description: >',
      '  First line of the description.',
      '  Second line that should fold in.',
      '',
      '  A later paragraph too.',
      'metadata:',
      '  nested: ignored',
      '---',
      '',
      'body',
    ].join('\n'));
    assert.equal(folded.name, 'demo');
    assert.equal(folded.description,
      'First line of the description. Second line that should fold in. A later paragraph too.');

    const literal = loader._parseFrontmatter('---\nname: demo\ndescription: |-\n  Kept as one line.\n---\n');
    assert.equal(literal.description, 'Kept as one line.');

    // The single-line forms must not regress.
    assert.equal(loader._parseFrontmatter('---\nname: d\ndescription: "quoted value"\n---\n').description, 'quoted value');
    assert.equal(loader._parseFrontmatter('---\nname: d\ndescription: bare value\n---\n').description, 'bare value');
  });

  it('_readAllowlist() still returns bare names (callers depend on this shape)', function() {
    const loader = freshLoader();
    const names = loader._readAllowlist();
    const entries = loader._readAllowlistEntries();
    assert.deepEqual(names, entries.map(e => e.name));
  });

  it('every REQUIRED entry is vendored in mythos/skills/ — this is the fresh-clone contract', function() {
    const entries = freshLoader()._readAllowlistEntries();
    const notVendored = entries
      .filter(e => !e.optional)
      .filter(e => !fs.existsSync(path.join(REPO_SKILLS_DIR, e.name, 'SKILL.md')))
      .map(e => e.name);
    assert.deepEqual(notVendored, [],
      'these allowlist entries are not vendored, so a fresh clone silently loses them. '
      + 'Either vendor mythos/skills/<name>/SKILL.md, or mark the entry optional with a leading "?".');
  });

  it('every vendored skill declares a frontmatter name matching its directory', function() {
    const loader = freshLoader();
    const dirs = fs.readdirSync(REPO_SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    assert.ok(dirs.length > 0, 'mythos/skills/ must contain vendored skills');
    for (const dir of dirs) {
      const skillMd = path.join(REPO_SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;   // essence-only vendoring (ui-ux-pro-max)
      const fm = loader._parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
      assert.equal(fm.name, dir,
        'frontmatter name must match the directory name for ' + dir + ' (loader resolves by directory)');
      assert.ok(fm.description && fm.description.length > 20,
        'skill ' + dir + ' needs a real single-line description — it is the only thing the model sees in the catalog');
      assert.ok(fm.description.trim() !== '>',
        'skill ' + dir + ' has a folded (">") description; the frontmatter parser reads single-line values only');
    }
  });

  it('a fresh clone resolves every required skill and reports no required gaps', function() {
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, MYTHOS_SKILLS_DIR: process.env.MYTHOS_SKILLS_DIR };
    // A home directory that exists but holds no skills — the fresh-clone case.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-nohome-'));
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    delete process.env.MYTHOS_SKILLS_DIR;
    try {
      const loader = freshLoader();
      const warnings = [];
      const catalog = loader.loadCatalog({ logger: { warn: (m, d) => warnings.push({ m, d }) } });
      const missing = loader.lastMissing();
      assert.deepEqual(missing.required, [],
        'a fresh clone must resolve every required allowlist entry');
      assert.deepEqual(warnings, [],
        'no warning should fire on a clean machine — optional misses are expected, not gaps');
      assert.ok(catalog.length >= 10,
        'the vendored catalog should carry real content on a fresh clone, got ' + catalog.length);
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
      delete require.cache[LOADER_PATH];
    }
  });

  it('a missing REQUIRED entry is still reported through the logger', function() {
    // Guard against "fix the noise by never warning". Simulated with a
    // temporary allowlist, so the real file stays untouched.
    const loader = freshLoader();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-allow-'));
    const tmpAllow = path.join(tmpDir, 'skills.allowlist');
    fs.writeFileSync(tmpAllow, 'definitely-not-a-real-skill\n?also-not-real\n', 'utf8');
    const realRead = fs.readFileSync;
    fs.readFileSync = function(p, enc) {
      if (p === loader._ALLOWLIST_PATH) return realRead(tmpAllow, enc);
      return realRead.apply(fs, arguments);
    };
    try {
      const warnings = [];
      loader.refresh({ logger: { warn: (m, d) => warnings.push({ m, d }) } });
      const missing = loader.lastMissing();
      assert.deepEqual(missing.required, ['definitely-not-a-real-skill']);
      assert.deepEqual(missing.optional, ['also-not-real']);
      assert.equal(warnings.length, 1, 'a required miss must warn exactly once');
      assert.equal(warnings[0].m, 'skills.loader.missing-packs');
    } finally {
      fs.readFileSync = realRead;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      delete require.cache[LOADER_PATH];
    }
  });

  it('searches <home>/.claude/plugins/installed/<pack>/skills', function() {
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, MYTHOS_SKILLS_DIR: process.env.MYTHOS_SKILLS_DIR };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-home-'));
    const installed = path.join(home, '.claude', 'plugins', 'installed', 'some-pack', 'skills');
    fs.mkdirSync(path.join(installed, 'pack-only-skill'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'pack-only-skill', 'SKILL.md'),
      '---\nname: pack-only-skill\ndescription: only reachable via the installed-plugin layout\n---\n\nbody\n', 'utf8');
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;
    try {
      const loader = freshLoader();
      assert.ok(loader.externalSkillRoots().indexOf(installed) !== -1,
        'installed-plugin skills dir must be one of the searched roots');
      assert.equal(loader.loadContent('pack-only-skill'), 'body',
        'a skill in the installed-plugin layout must resolve');
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      delete require.cache[LOADER_PATH];
    }
  });
});
