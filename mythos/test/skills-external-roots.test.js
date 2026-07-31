'use strict';

// skills-external-roots.test.js — the external skill resolver must find skills
// where they ACTUALLY live, and must be configurable rather than hardcoded to
// one runtime's layout.
//
// THE BUG THIS FILE EXISTS FOR (found 2026-07-31).
// skills/loader.js resolved exactly one external root: `~/.zcode/skills`, the
// ZCode CLI's layout. On a machine that drives MYTHOS from Claude Code — which
// is the documented, supported setup — that directory does not exist at all, so
// every skill not vendored into the repo silently failed to resolve:
//   * loadCatalog() dropped ~11 of 16 allowlisted skills (recorded in
//     lastMissing, so at least reported — but still absent from every prompt).
//   * resolveSkillTool() in skills/build-pack.js probes for
//     '<skill>/scripts/search.py' to run a REAL design-system lookup. It always
//     missed, so every UI build fell through to design/system.js's bundled-CSV
//     substitute while the operator believed their installed ui-ux-pro-max
//     (161 palettes, 57 font pairings, a real search tool) was driving output.
// Verified on this machine: ui-ux-pro-max's real scripts/search.py lives under
// ~/.claude/plugins/marketplaces/<pack>/src/, and five allowlisted skills
// (caveman, deep-research, tdd-workflow, frontend-patterns, coding-standards)
// live at ~/.claude/skills/<name>/SKILL.md. The loader saw neither location.
//
// The fix: an ORDERED LIST of candidate roots — an explicit MYTHOS_SKILLS_DIR
// override first (portability rule: never hardcode a user-specific path, always
// allow an env override), then the repo-vendored copies, then Claude Code's real
// personal- and plugin-skill layouts, then ~/.zcode for back-compat.
//
// These tests use a synthetic root injected via MYTHOS_SKILLS_DIR and a fake
// home directory, so they assert real resolution behaviour without depending on
// what happens to be installed on the machine running them.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOADER_PATH = require.resolve('../src/core/skills/loader.js');

function freshLoader() {
  // The loader caches its catalog in module scope, and these tests deliberately
  // change the environment between cases.
  delete require.cache[LOADER_PATH];
  return require('../src/core/skills/loader.js');
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(root, name, files) {
  const dir = path.join(root, name);
  for (const rel of Object.keys(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return dir;
}

describe('skills loader — external root resolution', function() {
  let tmp;
  const savedEnv = {};
  const ENV_KEYS = ['MYTHOS_SKILLS_DIR', 'USERPROFILE', 'HOME'];

  beforeEach(function() {
    tmp = mkdtemp('mythos-skills-');
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(function() {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    delete require.cache[LOADER_PATH];
  });

  it('exposes its candidate roots so a deployment can be diagnosed', function() {
    const loader = freshLoader();
    assert.equal(typeof loader.externalSkillRoots, 'function',
      'externalSkillRoots() must be exported — an operator whose skills silently do not resolve needs to see where MYTHOS actually looked');
    const roots = loader.externalSkillRoots();
    assert.ok(Array.isArray(roots), 'externalSkillRoots() must return an array');
  });

  it('MYTHOS_SKILLS_DIR is honoured, and takes precedence over the built-in roots', function() {
    const custom = path.join(tmp, 'custom-skills');
    fs.mkdirSync(custom, { recursive: true });
    process.env.MYTHOS_SKILLS_DIR = custom;

    const loader = freshLoader();
    const roots = loader.externalSkillRoots();
    assert.ok(roots.length > 0, 'at least the override must be present');
    assert.equal(roots[0], custom, 'an explicit override must be searched first');
  });

  it('MYTHOS_SKILLS_DIR accepts several roots separated by the platform delimiter', function() {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    process.env.MYTHOS_SKILLS_DIR = a + path.delimiter + b;

    const roots = freshLoader().externalSkillRoots();
    assert.ok(roots.indexOf(a) !== -1, 'first override root must be present');
    assert.ok(roots.indexOf(b) !== -1, 'second override root must be present');
    assert.ok(roots.indexOf(a) < roots.indexOf(b), 'override order must be preserved');
  });

  it('resolves a runnable asset out of an override root (the build-pack search.py case)', function() {
    const custom = path.join(tmp, 'custom-skills');
    writeSkill(custom, 'ui-ux-pro-max', {
      'SKILL.md': '---\nname: ui-ux-pro-max\ndescription: real installed skill\n---\nbody',
      'scripts/search.py': 'print("hi")',
      'data/palettes.csv': 'name,hex\n'
    });
    process.env.MYTHOS_SKILLS_DIR = custom;

    const loader = freshLoader();
    const rootForAsset = loader.resolveSkillFile('ui-ux-pro-max', 'scripts/search.py');
    assert.equal(rootForAsset, path.join(custom, 'ui-ux-pro-max'),
      'resolveSkillFile must return the skill root that actually contains the asset, so the script can reach its sibling data/ files');
    assert.equal(loader.skillFileExists('ui-ux-pro-max', 'scripts/search.py'), true);
    assert.equal(loader.skillFileExists('ui-ux-pro-max', 'scripts/nope.py'), false,
      'a missing asset must still resolve to false, not to a truthy root');
  });

  it('finds a personal Claude Code skill at <home>/.claude/skills/<name>/SKILL.md', function() {
    const home = path.join(tmp, 'home');
    const personal = path.join(home, '.claude', 'skills');
    // Deliberately a name that is NOT vendored under mythos/skills/ — the
    // vendored copy legitimately wins (see the precedence test below), so using
    // e.g. 'caveman' here would test precedence, not external resolution.
    writeSkill(personal, 'deep-research', {
      'SKILL.md': '---\nname: deep-research\ndescription: multi-source research\n---\nbody'
    });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    assert.equal(fs.existsSync(path.join(__dirname, '..', 'skills', 'deep-research')), false,
      'fixture guard: deep-research must not be repo-vendored, or this test stops proving external resolution');

    const loader = freshLoader();
    const roots = loader.externalSkillRoots();
    assert.ok(roots.indexOf(personal) !== -1,
      "Claude Code's personal skills directory must be one of the searched roots; got: " + JSON.stringify(roots));
    assert.equal(loader.loadContent('deep-research'), 'body',
      'a personal Claude Code skill must be loadable by name');
  });

  it('finds a plugin skill under <home>/.claude/plugins/marketplaces/<pack>/src/<name>', function() {
    const home = path.join(tmp, 'home');
    const packSrc = path.join(home, '.claude', 'plugins', 'marketplaces', 'ui-ux-pro-max-skill', 'src');
    writeSkill(packSrc, 'ui-ux-pro-max', {
      'SKILL.md': '---\nname: ui-ux-pro-max\ndescription: plugin skill\n---\nplugin body',
      'scripts/search.py': 'print("real")'
    });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    const loader = freshLoader();
    assert.equal(
      loader.resolveSkillFile('ui-ux-pro-max', 'scripts/search.py'),
      path.join(packSrc, 'ui-ux-pro-max'),
      'a plugin-marketplace skill with real tooling must resolve — this is the exact path the operator\'s ui-ux-pro-max install uses'
    );
  });

  it('also finds a plugin skill under the pack\'s .claude/skills/ layout', function() {
    const home = path.join(tmp, 'home');
    const packSkills = path.join(home, '.claude', 'plugins', 'marketplaces', 'somepack', '.claude', 'skills');
    writeSkill(packSkills, 'frontend-design', {
      'SKILL.md': '---\nname: frontend-design\ndescription: nested layout\n---\nnested body'
    });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    const loader = freshLoader();
    assert.equal(loader.loadContent('frontend-design'), 'nested body',
      'both plugin layouts observed in the wild must resolve');
  });

  it('keeps ~/.zcode/skills working (back-compat, must not regress)', function() {
    const home = path.join(tmp, 'home');
    const zcode = path.join(home, '.zcode', 'skills');
    writeSkill(zcode, 'legacy-skill', {
      'SKILL.md': '---\nname: legacy-skill\ndescription: zcode layout\n---\nzcode body'
    });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    const loader = freshLoader();
    assert.ok(loader.externalSkillRoots().indexOf(zcode) !== -1,
      'the original ~/.zcode/skills root must remain searched');
    assert.equal(loader.loadContent('legacy-skill'), 'zcode body');
  });

  it('a repo-vendored skill still wins over an external one (fresh-clone portability)', function() {
    // mythos/skills/<name>/ is checked before any external root so a clone with
    // no installs behaves identically everywhere. ponytail is vendored in-repo.
    const custom = path.join(tmp, 'custom-skills');
    writeSkill(custom, 'ponytail', {
      'SKILL.md': '---\nname: ponytail\ndescription: EXTERNAL COPY\n---\nexternal body'
    });
    process.env.MYTHOS_SKILLS_DIR = custom;

    const loader = freshLoader();
    const vendored = path.join(__dirname, '..', 'skills', 'ponytail');
    if (!fs.existsSync(vendored)) return; // fixture guard: nothing to compare against

    const content = loader.loadContent('ponytail');
    assert.notEqual(content, 'external body',
      'the repo-vendored skill must take precedence, so a fresh clone is deterministic');
  });

  it('resolves nothing and throws nothing when no root exists at all', function() {
    const home = path.join(tmp, 'empty-home');
    fs.mkdirSync(home, { recursive: true });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    const loader = freshLoader();
    assert.equal(loader.resolveSkillFile('nope', 'scripts/search.py'), '');
    assert.equal(loader.skillFileExists('nope', 'scripts/search.py'), false);
    assert.equal(loader.loadContent('nope'), null);
    assert.ok(Array.isArray(loader.loadCatalog()), 'an empty environment must still produce a catalog array');
  });

  it('never emits a hardcoded user-specific path (portability rule)', function() {
    const src = fs.readFileSync(LOADER_PATH, 'utf8');
    assert.equal(/[A-Za-z]:\\Users\\/.test(src), false, 'no Windows user path literal');
    assert.equal(/\/home\/[a-z]/.test(src), false, 'no Unix home path literal');
    assert.ok(/USERPROFILE|homedir/.test(src), 'home must be derived from the environment');
  });

  // Packs in the wild use three different layouts. A skill sitting in an
  // unsearched one fails exactly like an uninstalled skill: silently.
  it('searches all three plugin-pack layouts (src, .claude/skills, skills)', function() {
    const home = path.join(tmp, 'home3');
    const pack = path.join(home, '.claude', 'plugins', 'marketplaces', 'somepack');
    fs.mkdirSync(path.join(pack, 'skills'), { recursive: true });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;

    writeSkill(path.join(pack, 'skills'), 'layout-three', {
      'SKILL.md': '---\nname: layout-three\ndescription: third layout\n---\nGuidance body here.',
      'scripts/search.py': 'print("hi")',
    });

    const loader = freshLoader();
    assert.notEqual(loader.resolveSkillFile('layout-three', 'scripts/search.py'), '',
      '<pack>/skills/<name> must be a searched root');
    assert.match(loader.loadContent('layout-three'), /Guidance body here/);
  });

  // A skill cloned from GitHub has no hand-written SKILL-CORE.md in this repo.
  // Before the fallback it was visible to use_skill but silently absent from the
  // automatic essence injection that every UI build relies on.
  it('loadEssence falls back to the head of an installed SKILL.md when no essence is vendored', function() {
    const custom = path.join(tmp, 'cloned');
    fs.mkdirSync(custom, { recursive: true });
    process.env.MYTHOS_SKILLS_DIR = custom;

    const body = Array.from({ length: 80 }, (_, i) => 'guidance line ' + (i + 1)).join('\n');
    writeSkill(custom, 'from-github', {
      'SKILL.md': '---\nname: from-github\ndescription: cloned skill\n---\n' + body,
    });

    const loader = freshLoader();
    const essence = loader.loadEssence('from-github');
    assert.ok(essence, 'a cloned skill must still contribute an essence');
    assert.match(essence, /guidance line 1/);
    assert.doesNotMatch(essence, /^---$/m, 'frontmatter is metadata, not guidance');
    assert.doesNotMatch(essence, /guidance line 80/, 'only the head is injected, to bound prompt cost');
  });

  it('loadEssence prefers the vendored essence over an installed SKILL.md', function() {
    const custom = path.join(tmp, 'shadow');
    fs.mkdirSync(custom, { recursive: true });
    process.env.MYTHOS_SKILLS_DIR = custom;
    writeSkill(custom, 'ponytail', { 'SKILL.md': '---\nname: ponytail\n---\nEXTERNAL BODY' });

    const loader = freshLoader();
    const vendored = path.join(__dirname, '..', 'skills', 'ponytail', 'SKILL-CORE.md');
    if (!fs.existsSync(vendored)) return; // fixture guard
    assert.doesNotMatch(loader.loadEssence('ponytail'), /EXTERNAL BODY/,
      'the hand-condensed vendored essence wins, so a fresh clone is deterministic');
  });

  it('loadEssence returns null for a skill that exists nowhere', function() {
    const home = path.join(tmp, 'bare');
    fs.mkdirSync(home, { recursive: true });
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    delete process.env.MYTHOS_SKILLS_DIR;
    assert.equal(freshLoader().loadEssence('does-not-exist'), null);
  });
});
