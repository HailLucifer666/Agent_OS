'use strict';

// test/package-policy.test.js — credential and scratch files must never reach
// the installer (2026-09-29 whole-repo audit, remediation step B1).
//
// THE BUG THIS PINS. package.json's build.files excluded exactly one secret
// file, the literal "!mythos/.env". electron-builder packages the WORKING
// DIRECTORY, not the git tree (see electron-builder-files-allowlist.test.js),
// and an ordinary "back it up before editing" leaves siblings the literal
// cannot see. The local build of 2026-09-23 carried, in
// dist/win-unpacked/resources/app.asar.unpacked/mythos/:
//
//     .env.bak-2026-08-15                  .env.bak-voicenodes
//     .env.bak-2026-08-20T20-09-04-803Z    .env.pre-attended-2026-09-21.bak
//     .browser-agent.pid  .tmp-test/  vault_test_audit_<four timestamps>/
//
// (names only — measured by listing the directory; no file was opened). Four
// of those hold provider keys. The CI route builds from a fresh clone and was
// never exposed; scripts/release.js builds from the operator's working tree
// and was.
//
// WHY THE REAL MATCHER. Every assertion that decides "does this ship" runs
// app-builder-lib's own getMainFileMatchers() — the function a real build calls,
// default exclusions included — over a mirrored tree in a temp directory, and
// walks it the way the packager does (a directory the filter refuses is never
// descended into). A hand-rolled glob here would pass whether or not the config
// works. The mirror means no real secret, vault or model is created, moved or
// faked in the checkout.
//
// PROVEN ABLE TO FAIL, 2026-09-29. Before the fix, "no forbidden shape reaches
// the installer" failed listing 24 of its 26 shapes (only the literal .env and
// vault/ were caught). Eleven mutations, each applied, diffed, run and restored
// from a byte copy; every one turned at least one test here red:
//   code:    env-dot rule narrowed to ".env.bak*"; classifier case-sensitive;
//            app-root rules never match; ".." accepted by the normaliser;
//            generator emits case-sensitive globs; a non-empty waiver;
//            docker env rules root-only; directory rules without {,/**/*}
//   fixture: one generated line deleted from package.json; one deleted from
//            .dockerignore; a positive "mythos/**/*" appended after the tail
// Adjacent cases that must keep passing: nested config.json, "env.js",
// "src/core/vault/", node_modules/<pkg>/config.json, gesture_recognizer.task.
//
// WIDENED the same day after an independent review (Opus) probed the classifier
// and found ".env~", ".env-old", ".env (1)", ".env - Copy", "config.json.bak",
// "keys.json.bak" and "cert.pfx" still shipping. Four more mutations, each red
// here: the env glob narrowed back to "*.env"; the .pfx rule dropped; root
// config and mythos-settings narrowed back to their literals. Writing them
// exposed that a separate ".env*" rule beside "*.env*" could never be seen to
// fail ("*" may be empty), so the two became one rule. The derived probes now
// fill each "*" twice, empty and non-empty, which the literal globs never needed.
// New adjacent cases: environment.js, a nested config.json.bak, configure.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..', '..');

function loadBuildConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return pkg.build;
}

// Every shape here is one the working tree has actually held, or the same shape
// in a spelling the old literal could not see (case, depth, spaces, directory).
const FORBIDDEN = [
  // the four real backups, byte-for-byte names
  'mythos/.env.bak-2026-08-15',
  'mythos/.env.bak-2026-08-20T20-09-04-803Z',
  'mythos/.env.bak-voicenodes',
  'mythos/.env.pre-attended-2026-09-21.bak',
  // the literal the old config did catch — must stay caught
  'mythos/.env',
  // the same class in other spellings
  'mythos/.env.local',
  'mythos/.env.example',          // not secret by design, but one paste away from it; nothing at runtime reads it
  'mythos/Nvidia NIM.env',        // a real root-level name in this repo, moved under the packaged tree
  'mythos/bak-504b082.env.local', // likewise
  'mythos/.ENV.Bak',              // Windows is case-insensitive; minimatch is not
  'mythos/skills/web/.env',       // nested
  'mythos/skills/web/prod.env',
  'electron/.env',                // electron/** ships too
  'mythos/.env.d/provider.txt',   // an env-shaped DIRECTORY takes its children with it
  // Hand-copy shapes the first version still shipped (independent review,
  // 2026-09-29, probed against classifyPackagedPath): editor, Explorer, habit.
  'mythos/.env~',
  'mythos/.env-old',
  'mythos/.env_backup',
  'mythos/.env (1)',
  'mythos/.env - Copy',
  'mythos/.envrc',
  'mythos/Nvidia NIM.env - Copy',
  'mythos/config.json.bak',
  'mythos/config - Copy.json',
  'mythos/keys.json.bak',
  'mythos/mythos-settings.json.bak',
  'mythos/mythos-settings (1).json',
  'cert.pfx',                     // CSC_LINK's certificate, at any depth
  'mythos/build/signing.P12',
  // app-root-relative writers (settings-store, main.js, doctor, browser-agent)
  'mythos/config.json',
  'mythos/Config.JSON',
  'mythos/keys.json',
  'mythos/auth-sessions.json',
  'mythos/auth-sessions.json.tmp',
  'mythos/mythos-settings.json',
  'mythos/.browser-agent.pid',
  // app-root-relative directories (test vaults, scratch roots, the real vault)
  'mythos/vault/Audit/2026-01-01.jsonl',
  'mythos/vault_test_audit_1787691379257/Audit/2026-01-01.jsonl',
  'mythos/vault_test_audit_v8c_1788778709611/Semantic/x.md',
  'mythos/.tmp-test/scratch.txt',
  'mythos/.tmp-code-search-test/a.js',
];

// Positive controls. Without these every exclusion above could pass vacuously —
// a stray "!mythos/**/*" would satisfy all of them while the app shipped empty.
const ALLOWED = [
  'package.json',
  'electron/main.js',
  'mythos/package.json',
  'mythos/src/main.js',
  'mythos/ui/public/index.html',
  'mythos/server/auth-sessions.js',                 // source, not the sessions file
  'mythos/src/core/config/settings-store.js',
  'mythos/src/core/config/env.js',                  // "env" without the dot is code
  'mythos/skills/web/config.json',                  // nested config.json is deliberate
  'mythos/node_modules/some-pkg/config.json',
  'mythos/node_modules/dotenv/lib/main.js',
  'mythos/src/core/vault/fs-store.js',              // "vault" below the app root is code
  'mythos/ui/public/models/gesture_recognizer.task',
  // Adjacent cases for the 2026-09-29 widening: they must keep shipping.
  'mythos/src/core/environment.js',                 // "env" with no dot in front of it
  'mythos/skills/web/config.json.bak',              // the root globs stay root-only
  'mythos/configure.js',                            // "config*" but not a .json
];

function withMirroredTree(relPaths, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-pkg-policy-'));
  try {
    for (const rel of relPaths) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x'); // content is irrelevant: the matcher is path + stat based
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The REAL main-file matcher, built the way app-builder-lib's packager builds it
// (platformPackager -> getMainFileMatchers), default exclusions and all.
// Deliberately not wrapped in try/catch: if these internals move, this must fail
// loudly rather than skip and leave a guard guarding nothing.
function realPackagerFilter(root) {
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
  const build = JSON.parse(JSON.stringify(loadBuildConfig()));
  const packager = {
    info: {
      projectDir: root,
      buildResourcesDir: 'build',
      isPrepackedAppAsar: false,
      config: build,
      debugLogger: { isEnabled: false },
    },
  };
  const matchers = getMainFileMatchers(root, path.join(root, 'app-out'), (x) => x,
    build.win || {}, packager, path.join(root, 'dist'), false);
  assert.equal(matchers.length, 1, 'build.files is a single string list — one matcher expected');
  return matchers[0].createFilter();
}

// Ships = the packager would reach it: every ancestor directory passes the
// filter (a refused directory is never walked) AND the file itself passes.
function ships(filterFn, root, rel) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i += 1) {
    const abs = path.join(root, ...parts.slice(0, i));
    if (!filterFn(abs, fs.statSync(abs))) return false;
  }
  return true;
}

describe('build.files keeps credential and scratch files out (real electron-builder matcher)', () => {
  test('no forbidden shape reaches the installer', () => {
    withMirroredTree(FORBIDDEN.concat(ALLOWED), (root) => {
      const filterFn = realPackagerFilter(root);
      const leaked = FORBIDDEN.filter((rel) => ships(filterFn, root, rel));
      assert.deepEqual(leaked, [],
        'these would be packaged into the installer:\n  ' + leaked.join('\n  '));
    });
  });

  test('positive control: runtime files, nested config.json and code named *env* still ship', () => {
    withMirroredTree(FORBIDDEN.concat(ALLOWED), (root) => {
      const filterFn = realPackagerFilter(root);
      const dropped = ALLOWED.filter((rel) => !ships(filterFn, root, rel));
      assert.deepEqual(dropped, [],
        'these must still be packaged:\n  ' + dropped.join('\n  '));
    });
  });
});

// ---------------------------------------------------------------------------
// The classifier every other consumer shares (electron/package-policy.js).

const policy = require('../../electron/package-policy.js');

describe('the package policy classifier', () => {
  test('forbids every shape the working tree has held, naming the rule', () => {
    for (const rel of FORBIDDEN) {
      const verdict = policy.classifyPackagedPath(rel);
      assert.equal(verdict.forbidden, true, `${rel} must be forbidden`);
      assert.equal(typeof verdict.rule, 'string', `${rel} must name the rule that forbade it`);
    }
  });

  test('allows runtime files, nested config.json and code whose name merely contains "env" or "vault"', () => {
    for (const rel of ALLOWED) {
      assert.equal(policy.classifyPackagedPath(rel).forbidden, false, `${rel} must be allowed`);
    }
  });

  test('accepts every spelling a lister produces for the same path', () => {
    // asar headers list "/mythos/…", a Windows walk yields "mythos\\…", 7za
    // listings are relative. One file, one answer.
    for (const spelling of ['mythos/src/main.js', '/mythos/src/main.js', './mythos/src/main.js', 'mythos\\src\\main.js']) {
      assert.deepEqual(policy.classifyPackagedPath(spelling), { forbidden: false, path: 'mythos/src/main.js' }, spelling);
    }
    for (const spelling of ['mythos/.env.bak-x', '/mythos/.env.bak-x', 'mythos\\.env.bak-x', 'MYTHOS\\.ENV.BAK-X']) {
      assert.equal(policy.classifyPackagedPath(spelling).forbidden, true, spelling);
    }
  });

  test('refuses a path it cannot normalise instead of waving it through', () => {
    // A model that skips what it cannot parse fails open. An archive entry that
    // climbs out, names a drive or hides a NUL is not a package path at all.
    const bad = ['', '..', '../mythos/.env', 'mythos/../../etc/x', 'C:/.env', 'c:\\x',
      'mythos//x', 'mythos/./x', 'mythos/a\0b', null, undefined, 42];
    for (const value of bad) {
      const verdict = policy.classifyPackagedPath(value);
      assert.equal(verdict.forbidden, true, `${JSON.stringify(value)} must be refused`);
      assert.equal(verdict.rule, 'unnormalizable');
    }
  });

  test('ships an EMPTY waiver map', () => {
    // A deliberate exception must be visible. If this fails, the new entry must
    // say what it waives, why that is safe, and who decided.
    assert.deepEqual(Object.keys(policy.WAIVERS), []);
    assert.equal(Object.isFrozen(policy.WAIVERS), true);
  });

  test('rule lists are frozen, so one consumer cannot quietly edit the policy for all of them', () => {
    assert.equal(Object.isFrozen(policy.ENV_NAME_RULES), true);
    assert.equal(Object.isFrozen(policy.APP_ROOT_RULES), true);
    for (const r of policy.ENV_NAME_RULES.concat(policy.APP_ROOT_RULES)) assert.equal(Object.isFrozen(r), true);
  });
});

// Probes DERIVED from the rules rather than typed: every rule is instantiated at
// several depths, in upper case, and as a directory with a child. Adding a rule
// grows this matrix by itself; forgetting to update a fixture list cannot hide it.
// Files and directories come back separately because one mirrored tree cannot
// hold "mythos/.env" as both.
// Each "*" is filled twice: empty (the bare name — "config.json" from
// "config*.json*") and with a stand-in ("configbak-2026.jsonbak-2026"). Until the
// globs were widened on 2026-09-29 only the second fill existed, which was
// enough while most globs were literals and is not now.
function probesFromRules() {
  const fills = (glob) => [...new Set([glob.split('*').join(''), glob.split('*').join('bak-2026')])];
  const files = [];
  const dirs = [];
  const allowed = [];
  for (const r of policy.ENV_NAME_RULES) {
    for (const name of fills(r.glob)) {
      files.push(`mythos/${name}`, `mythos/a/b/${name}`, `electron/${name}`,
        `mythos/${name.toUpperCase()}`, `mythos/node_modules/pkg/${name}`);
      dirs.push(`mythos/${name}/child.txt`, `mythos/a/${name.toUpperCase()}/child.txt`);
    }
  }
  for (const r of policy.APP_ROOT_RULES) {
    for (const name of fills(r.glob)) {
      files.push(`mythos/${name}`, `mythos/${name.toUpperCase()}`);
      dirs.push(`mythos/${name}/child.txt`);
      // The same name below the app root is code or package data, never a writer's target.
      allowed.push(`mythos/skills/x/${name}`, `mythos/node_modules/pkg/${name}`);
    }
  }
  return { files, dirs, allowed, forbidden: files.concat(dirs) };
}

function disagreements(forbidden, allowed) {
  return withMirroredTree(forbidden.concat(allowed), (root) => {
    const filterFn = realPackagerFilter(root);
    return {
      leaked: forbidden.filter((rel) => ships(filterFn, root, rel)),
      dropped: allowed.filter((rel) => !ships(filterFn, root, rel)),
    };
  });
}

describe('two routes, one answer: the classifier and electron-builder agree', () => {
  test('every path the classifier forbids, the real matcher refuses — and every allowed probe ships', () => {
    const probes = probesFromRules();
    for (const rel of FORBIDDEN.concat(probes.forbidden)) assert.equal(policy.classifyPackagedPath(rel).forbidden, true, `classifier: ${rel}`);
    for (const rel of ALLOWED.concat(probes.allowed)) assert.equal(policy.classifyPackagedPath(rel).forbidden, false, `classifier: ${rel}`);
    // Three trees: the named fixtures, the file probes, the directory probes.
    const runs = [
      disagreements(FORBIDDEN, ALLOWED),
      disagreements(probes.files, probes.allowed),
      disagreements(probes.dirs, []),
    ];
    const merged = { leaked: runs.flatMap((r) => r.leaked), dropped: runs.flatMap((r) => r.dropped) };
    assert.deepEqual(merged, { leaked: [], dropped: [] },
      'the classifier and electron-builder disagree — the scanner would pass what the build ships, or the reverse');
  });

  test('build.files ENDS with the generated policy exclusions, in order', () => {
    // Last-match-wins: a positive pattern placed after these would re-include
    // what they exclude, so they must be the tail and nothing may follow them.
    const files = loadBuildConfig().files;
    const expected = policy.builderExclusionPatterns();
    assert.deepEqual(files.slice(-expected.length), expected,
      'package.json build.files must end with electron/package-policy.js builderExclusionPatterns() — regenerate it, do not hand-edit');
  });

  test('of every tracked file that ships, the policy removes only .env.example and the vault placeholders', () => {
    // A derived positive control over the REAL tree: if a rule were too broad
    // (say "*env*"), it would start eating source files, and this names them.
    const { execFileSync } = require('node:child_process');
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'package.json', 'electron', 'mythos'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    assert.ok(tracked.length > 500, `git ls-files returned ${tracked.length} paths — the control has nothing to control`);
    const removed = tracked.filter((rel) => policy.classifyPackagedPath(rel).forbidden);
    const unexpected = removed.filter((rel) => rel !== 'mythos/.env.example' && !/^mythos\/vault\/[^/]+\/\.gitkeep$/.test(rel));
    assert.deepEqual(unexpected, [], 'the policy would drop these tracked files from the installer');
    assert.ok(removed.includes('mythos/.env.example'), 'the adjacent case: .env.example is forbidden by the env rule');
  });
});

// ---------------------------------------------------------------------------
// mythos/.dockerignore — the local `docker build` context is the other place a
// working tree becomes an artefact.
//
// dockerExcludes() below is a MODEL of Docker, not Docker (a port of
// moby/patternmatcher's glob-to-regexp plus BuildKit's walk, where an excluded
// directory takes its children). Docker is not installed on the machine this
// was written on (2026-09-29), so no `docker build` confirmed it; the examples
// in the first test are Docker's own documented cases and pin the model to them.
// Anything the model does not understand throws rather than guessing.
function dockerPatternToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
        re += i + 1 >= pattern.length ? '.*' : '(.*/)?';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+()|{}$^'.includes(ch)) {
      re += '\\' + ch;
    } else if (ch === '\\') {
      throw new Error(`dockerignore model: escapes are not modelled (${pattern})`);
    } else {
      re += ch; // letters, digits, "-", "_", "/", and [...] classes pass through as regexp
    }
  }
  return new RegExp(re + '$');
}

function parseDockerignore(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const exclusion = line.startsWith('!');
    const raw = (exclusion ? line.slice(1) : line).trim();
    const body = path.posix.normalize(raw).replace(/^\/+/, '').replace(/\/+$/, '');
    return { exclusion, re: dockerPatternToRegExp(body) };
  });
}

function dockerExcludes(patterns, rel) {
  const parts = rel.split('/');
  let matched = false;
  for (const p of patterns) {
    if (p.exclusion !== matched) continue;
    let m = false;
    for (let i = 1; i <= parts.length && !m; i += 1) m = p.re.test(parts.slice(0, i).join('/'));
    if (m) matched = !p.exclusion;
  }
  return matched;
}

const DOCKERIGNORE_PATH = path.join(REPO_ROOT, 'mythos', '.dockerignore');

describe('.dockerignore carries the same policy', () => {
  test('the model reproduces Docker\'s documented examples', () => {
    const ex = (text, rel) => dockerExcludes(parseDockerignore(text), rel);
    assert.equal(ex('*/temp*', 'somedir/temporary.txt'), true);
    assert.equal(ex('*/temp*', 'somedir/temp'), true);
    assert.equal(ex('*/temp*', 'temporary.txt'), false);
    assert.equal(ex('*/*/temp*', 'somedir/subdir/temporary.txt'), true);
    assert.equal(ex('temp?', 'tempa'), true);
    assert.equal(ex('temp?', 'tempab'), false);
    assert.equal(ex('**/*.go', 'main.go'), true);
    assert.equal(ex('**/*.go', 'a/b/c.go'), true);
    assert.equal(ex('*.md\n!README.md', 'README.md'), false);
    assert.equal(ex('*.md\n!README.md', 'CHANGES.md'), true);
    assert.equal(ex('*.md\n!README*.md\nREADME-secret.md', 'README-secret.md'), true);
    assert.equal(ex('*.md\n!README*.md\nREADME-secret.md', 'README-public.md'), false);
    assert.equal(ex('*.md\nREADME-secret.md\n!README*.md', 'README-secret.md'), false);
    // The documented trap this block exists for: a bare name matches the ROOT only.
    assert.equal(ex('.env', '.env'), true);
    assert.equal(ex('.env', 'skills/web/.env'), false);
    assert.equal(ex('/foo/bar', 'foo/bar'), true);
  });

  test('.dockerignore ENDS with the generated policy block, in order', () => {
    const lines = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const expected = policy.dockerIgnorePatterns();
    assert.deepEqual(lines.slice(-expected.length), expected,
      'mythos/.dockerignore must end with electron/package-policy.js dockerIgnorePatterns()');
  });

  test('every forbidden shape inside the Docker context is excluded, and runtime files are not', () => {
    const patterns = parseDockerignore(fs.readFileSync(DOCKERIGNORE_PATH, 'utf8'));
    const probes = probesFromRules();
    const inContext = (rel) => rel.startsWith('mythos/');
    const strip = (rel) => rel.slice('mythos/'.length);
    const forbidden = FORBIDDEN.concat(probes.forbidden).filter(inContext).map(strip);
    // node_modules is excluded from the context for its own reason (npm ci runs
    // in the image), so it cannot serve as a positive control here.
    const allowed = ALLOWED.concat(probes.allowed).filter(inContext).map(strip)
      .filter((rel) => !rel.startsWith('node_modules/'));
    const leaked = forbidden.filter((rel) => !dockerExcludes(patterns, rel));
    const dropped = allowed.filter((rel) => dockerExcludes(patterns, rel));
    assert.deepEqual({ leaked, dropped }, { leaked: [], dropped: [] });
    assert.ok(allowed.includes('skills/x/config.json'), 'the adjacent case must be in the control set');
  });
});

