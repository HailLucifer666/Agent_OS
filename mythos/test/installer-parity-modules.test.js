'use strict';

// test/installer-parity-modules.test.js — the other modules written for the
// 2026-08-11 installer-parity incident, each pinned to the specific failure it
// exists for.
//
//   electron/vault-migration.js  adoptSiblingVault  — the install's empty second brain
//   src/core/voice/tool-capability.js               — boot-time tool calls against nothing
//   src/core/setup/model-paths.js                   — models delivered to a directory updates erase
//   src/core/setup/import-existing.js               — no way to carry dev's setup across
//   src/core/identity/boundaries-seed.js            — a fresh vault clamped to Tier 1
//   ui/public/js/setup/component-health-model.js    — recorded intent that never happened
//
// The packaged-config half lives in test/packaged-config-parity.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { adoptSiblingVault, rankVaultCandidates, resolveVaultRoot } = require('../../electron/vault-migration');
const { buildCapabilitySnapshot, checkToolCapability } = require('../src/core/voice/tool-capability');
const modelPaths = require('../src/core/setup/model-paths');
const importer = require('../src/core/setup/import-existing');
const { seedBoundaries, renderBoundaries } = require('../src/core/identity/boundaries-seed');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-parity-mod-')); }
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

describe('adoptSiblingVault — one app identity, one vault', () => {
  it('adopts the RICHEST sibling vault and logs every candidate it considered', () => {
    const root = tmpDir();
    try {
      // The operator's actual machine: a months-old dev vault under Electron, a
      // near-empty one under agent-os, and a brand-new MYTHOS with nothing.
      write(path.join(root, 'Electron', 'vault', 'Identity', 'boundaries.md'), 'max_autonomous_tier: 2\n');
      write(path.join(root, 'Electron', 'vault', 'Skills', 'a.md'), 'x'.repeat(500));
      write(path.join(root, 'Electron', 'vault', 'Skills', 'b.md'), 'y'.repeat(500));
      write(path.join(root, 'agent-os', 'vault', 'Episodic', 'one.jsonl'), '{}');

      const lines = [];
      const dest = path.join(root, 'MYTHOS', 'vault');
      const res = adoptSiblingVault({
        dest,
        siblingDirs: [path.join(root, 'agent-os', 'vault'), path.join(root, 'Electron', 'vault')],
        markerPath: path.join(root, 'MYTHOS', 'vault-adopt.json'),
        log: (m) => lines.push(m),
      });

      assert.equal(res.status, 'adopted');
      assert.equal(path.resolve(res.from), path.resolve(path.join(root, 'Electron', 'vault')),
        'three files beats one — the dev vault must win');
      assert.equal(fs.readFileSync(path.join(dest, 'Identity', 'boundaries.md'), 'utf8').trim(), 'max_autonomous_tier: 2');
      // Every decision logged, including the loser: the operator must be able to
      // see WHICH vault won and why.
      assert.ok(lines.some((l) => l.includes('agent-os') && l.includes('1 files')));
      assert.ok(lines.some((l) => l.includes('richest, adopting')));
      // COPY, never move.
      assert.equal(fs.existsSync(path.join(root, 'Electron', 'vault', 'Skills', 'a.md')), true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('never runs twice, and never overwrites a vault this install already has', () => {
    const root = tmpDir();
    try {
      write(path.join(root, 'agent-os', 'vault', 'Episodic', 'one.jsonl'), '{}');
      write(path.join(root, 'MYTHOS', 'vault', 'Episodic', 'mine.jsonl'), '{"mine":true}');
      const markerPath = path.join(root, 'MYTHOS', 'vault-adopt.json');

      const first = adoptSiblingVault({
        dest: path.join(root, 'MYTHOS', 'vault'),
        siblingDirs: [path.join(root, 'agent-os', 'vault')],
        markerPath,
      });
      assert.equal(first.status, 'dest-non-empty');
      assert.equal(fs.readFileSync(path.join(root, 'MYTHOS', 'vault', 'Episodic', 'mine.jsonl'), 'utf8'), '{"mine":true}');

      const second = adoptSiblingVault({
        dest: path.join(root, 'MYTHOS', 'vault'),
        siblingDirs: [path.join(root, 'agent-os', 'vault')],
        markerPath,
      });
      assert.equal(second.status, 'already-done');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a fresh machine with no sibling is "no-candidate", not a failure', () => {
    const root = tmpDir();
    try {
      const res = adoptSiblingVault({
        dest: path.join(root, 'MYTHOS', 'vault'),
        siblingDirs: [path.join(root, 'agent-os', 'vault')],
        markerPath: path.join(root, 'MYTHOS', 'vault-adopt.json'),
      });
      assert.equal(res.status, 'no-candidate');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rankVaultCandidates breaks a file-count tie on bytes', () => {
    const root = tmpDir();
    try {
      write(path.join(root, 'a', 'x.md'), 'short');
      write(path.join(root, 'b', 'x.md'), 'x'.repeat(9999));
      const { winner } = rankVaultCandidates([path.join(root, 'a'), path.join(root, 'b')]);
      assert.equal(path.basename(winner.dir), 'b');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('resolveVaultRoot uses its OWN marker, so the install-tree migration cannot suppress adoption', () => {
    const root = tmpDir();
    try {
      const userData = path.join(root, 'MYTHOS');
      write(path.join(root, 'Electron', 'vault', 'Identity', 'boundaries.md'), 'max_autonomous_tier: 3\n');
      // The install-tree migration runs first and marks itself done ('no-source'),
      // which is what happens on EVERY fresh install. Sibling adoption must still
      // happen — sharing one marker file is what would break it.
      const vaultRoot = resolveVaultRoot({
        explicitEnv: null,
        oldVaultDir: path.join(root, 'nonexistent-install-tree', 'vault'),
        userDataDir: userData,
        siblingUserDataNames: ['agent-os', 'Electron'],
      });
      assert.equal(path.resolve(vaultRoot), path.resolve(path.join(userData, 'vault')));
      assert.equal(fs.existsSync(path.join(userData, 'vault-migration.json')), true);
      assert.equal(fs.existsSync(path.join(userData, 'vault-adopt.json')), true);
      assert.match(fs.readFileSync(path.join(userData, 'vault', 'Identity', 'boundaries.md'), 'utf8'), /tier: 3/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('tool-capability — do not declare what this machine cannot do', () => {
  const noAdapters = { getStatus: () => ({ state: 'OFFLINE' }) };

  it('withholds gmail without the full OAuth triple, and allows it with one', () => {
    const without = buildCapabilitySnapshot({ config: { GOOGLE_CLIENT_ID: 'id' } });
    const res = checkToolCapability('gmail_unread', without);
    assert.equal(res.ok, false, 'a client id alone authenticates nothing');
    assert.match(res.reason, /GOOGLE_REFRESH_TOKEN/);

    const with3 = buildCapabilitySnapshot({
      config: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' },
    });
    assert.equal(checkToolCapability('gmail_unread', with3).ok, true);
  });

  it('withholds phone_* with adb running but NO device attached', () => {
    const snap = buildCapabilitySnapshot({
      config: {},
      adapters: { android: { getStatus: () => ({ state: 'ONLINE', devices: [] }) } },
    });
    assert.equal(checkToolCapability('phone_screenshot', snap).ok, false);

    const withDevice = buildCapabilitySnapshot({
      config: {},
      adapters: { android: { getStatus: () => ({ state: 'ONLINE', devices: [{ id: 'x' }] }) } },
    });
    assert.equal(checkToolCapability('phone_screenshot', withDevice).ok, true);
  });

  it('withholds browser_* with no CDP, but NEVER the launcher that would fix it', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: { browser: noAdapters } });
    assert.equal(checkToolCapability('browser_click', snap).ok, false);
    assert.equal(checkToolCapability('browser_launch_debug', snap).ok, true,
      'gating the launcher on a browser being available is a deadlock, and BUG-099 is on record about remedies that cannot be reached');
    assert.equal(checkToolCapability('browser_switch', snap).ok, true);
  });

  it('an adapter it cannot ask is AVAILABLE, not withheld', () => {
    // Over-withholding is the more damaging error: the model then improvises with
    // the nearest reachable tool and narrates the result.
    const snap = buildCapabilitySnapshot({ config: {}, adapters: { browser: {} } });
    assert.equal(snap.browserOnline, true);
    assert.equal(checkToolCapability('browser_click', snap).ok, true);
  });

  it('a tool no rule names is always available', () => {
    const snap = buildCapabilitySnapshot({ config: {} });
    assert.equal(checkToolCapability('get_time', snap).ok, true);
    assert.equal(checkToolCapability('remember', snap).ok, true);
  });
});

describe('model-paths — weights that survive an update', () => {
  it('writes to userData when one is known, and to the install tree otherwise', () => {
    const root = tmpDir();
    try {
      assert.equal(
        path.resolve(modelPaths.modelWriteDir('wakeword', { MYTHOS_MODELS_DIR: path.join(root, 'models') })),
        path.resolve(path.join(root, 'models', 'wakeword')),
      );
      // Derives userData from MYTHOS_SETTINGS_PATH when MYTHOS_MODELS_DIR is
      // absent, so an older electron/main.js still puts models in the right place
      // rather than silently reverting to the install tree.
      assert.equal(
        path.resolve(modelPaths.modelWriteDir('silero', { MYTHOS_SETTINGS_PATH: path.join(root, 'config.json') })),
        path.resolve(path.join(root, 'models', 'silero')),
      );
      assert.equal(
        path.resolve(modelPaths.modelWriteDir('wakeword', {})),
        path.resolve(path.join(modelPaths.INSTALL_TREE_MODELS_DIR, 'wakeword')),
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('searches userData FIRST but still finds a model left in the install tree', () => {
    const root = tmpDir();
    try {
      const env = { MYTHOS_MODELS_DIR: path.join(root, 'models') };
      const dirs = modelPaths.modelSearchDirs(env);
      assert.equal(path.resolve(dirs[0]), path.resolve(path.join(root, 'models')));
      assert.equal(path.resolve(dirs[dirs.length - 1]), path.resolve(modelPaths.INSTALL_TREE_MODELS_DIR));

      write(path.join(root, 'models', 'wakeword', 'melspectrogram.onnx'), 'weights');
      const found = modelPaths.findModelFile('wakeword', 'melspectrogram.onnx', env);
      assert.ok(found);
      assert.equal(found.size, 'weights'.length);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a ZERO-BYTE file is not present — that is what a failed download leaves behind', () => {
    const root = tmpDir();
    try {
      const env = { MYTHOS_MODELS_DIR: path.join(root, 'models') };
      // A name that cannot also exist in the install tree. Using the real
      // silero_vad.onnx here made the test pass or fail depending on whether the
      // machine running the suite had that model downloaded — the search
      // legitimately falls through to the install tree and would find the real one.
      write(path.join(root, 'models', 'silero', 'zero-byte-probe.onnx'), '');
      assert.equal(modelPaths.findModelFile('silero', 'zero-byte-probe.onnx', env), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('import-existing — carrying dev\'s setup across', () => {
  it('parses a .env, keeps schema keys, and reports secret NAMES without their values', () => {
    const root = tmpDir();
    try {
      const source = path.join(root, 'repo-mythos');
      write(path.join(source, '.env'), [
        '# a comment',
        'export VOICE_S2S_ENABLED=true',
        'VOICE_TTS_PROVIDER="gemini"',
        'GOOGLE_API_KEY=sk-super-secret-value',
        'GOOGLE_REFRESH_TOKEN=1//refresh-secret',
        'NOT_A_MYTHOS_SETTING=whatever',
        'WAKEWORD_ENABLED=true',
        'EMPTY_ONE=',
      ].join('\n'));

      const scan = importer.scanForExisting({
        env: {}, homedir: path.join(root, 'home'), repoMythosDir: source, excludeDir: path.join(root, 'own'),
      });
      const found = scan.sources.find((s) => path.resolve(s.dir) === path.resolve(source));
      assert.ok(found, 'the repo checkout must be offered as a source');
      assert.equal(found.settings.VOICE_S2S_ENABLED, 'true');
      assert.equal(found.settings.VOICE_TTS_PROVIDER, 'gemini', 'surrounding quotes are stripped');
      assert.equal(found.settings.WAKEWORD_ENABLED, 'true');
      assert.equal(found.settings.NOT_A_MYTHOS_SETTING, undefined);
      assert.ok(found.unknown.includes('NOT_A_MYTHOS_SETTING'),
        'an unrecognised key is REPORTED as dropped, never carried across looking applied');

      // AD-8: names, never values. Asserted against the whole serialised source.
      // GOOGLE_API_KEY is deliberately in this list even though it is NOT a schema
      // key — it is read straight from the environment. A schema-first filter filed
      // it under "unknown" and told the operator nothing about the one credential
      // they most needed to re-enter, which is why isSecretShaped is checked first.
      assert.deepEqual(found.secrets, ['GOOGLE_API_KEY', 'GOOGLE_REFRESH_TOKEN']);
      const serialised = JSON.stringify(found);
      assert.equal(serialised.includes('sk-super-secret-value'), false, 'a secret VALUE must never appear in a scan result');
      assert.equal(serialised.includes('1//refresh-secret'), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('importSettings never overwrites a value this install already has, unless told to', () => {
    const root = tmpDir();
    const settingsPath = path.join(root, 'config.json');
    try {
      const res = importer.importSettings({
        settings: { MYTHOS_NAME: 'FROM_DEV', LOG_LEVEL: 'debug', GOOGLE_API_KEY: 'nope', NOT_A_SETTING: 'x' },
        settingsPath,
        existing: { MYTHOS_NAME: 'MINE' },
      });
      assert.deepEqual(res.imported, ['LOG_LEVEL']);
      const reasons = Object.fromEntries(res.skipped.map((s) => [s.name, s.reason]));
      assert.match(reasons.MYTHOS_NAME, /already set/);
      assert.match(reasons.GOOGLE_API_KEY, /key store/);
      assert.match(reasons.NOT_A_SETTING, /not a MYTHOS setting/);

      const forced = importer.importSettings({
        settings: { MYTHOS_NAME: 'FROM_DEV' }, settingsPath, existing: { MYTHOS_NAME: 'MINE' }, overwrite: true,
      });
      assert.deepEqual(forced.imported, ['MYTHOS_NAME']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('importVaultFiles copies the identity files and skips ones already present', () => {
    const root = tmpDir();
    try {
      const from = path.join(root, 'from', 'vault');
      const to = path.join(root, 'to', 'vault');
      write(path.join(from, 'Identity', 'boundaries.md'), 'max_autonomous_tier: 2\n');
      write(path.join(from, 'Identity', 'operator-profile.txt'), 'the operator');
      write(path.join(from, 'Contacts', 'contacts.json'), '[]');
      write(path.join(from, 'Skills', 'learned-one.md'), '# skill');
      write(path.join(from, 'Episodic', '2026-08-01.jsonl'), '{}'); // NOT an identity file
      write(path.join(to, 'Identity', 'operator-profile.txt'), 'mine already');

      const res = importer.importVaultFiles({ fromVault: from, toVault: to });
      assert.deepEqual(res.copied.sort(), ['Contacts/contacts.json', 'Identity/boundaries.md', 'Skills/learned-one.md']);
      assert.deepEqual(res.skipped.map((s) => s.rel), ['Identity/operator-profile.txt']);
      assert.equal(fs.readFileSync(path.join(to, 'Identity', 'operator-profile.txt'), 'utf8'), 'mine already');
      assert.equal(fs.existsSync(path.join(to, 'Episodic', '2026-08-01.jsonl')), false,
        'this imports IDENTITY, not episodic history — that is vault-migration.js\'s job');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('boundaries-seed — a fresh vault is not a corrupt one', () => {
  // A minimal fs-store shim: the real one is memory/fs-store.js, and this covers
  // the three methods seedBoundaries uses.
  function fsStore(root) {
    return {
      exists: (rel) => fs.existsSync(path.join(root, rel)),
      vaultPath: (rel) => path.join(root, rel),
      ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
      writeText: (rel, text) => write(path.join(root, rel), text),
    };
  }

  it('seeds at the operator\'s configured ceiling, so the leash Math.min is a no-op', () => {
    const root = tmpDir();
    try {
      const res = seedBoundaries({ fs: fsStore(root), config: { AUTONOMOUS_MAX_TIER: 3 } });
      assert.equal(res.status, 'seeded');
      assert.equal(res.tier, 3);
      const text = fs.readFileSync(path.join(root, 'Identity', 'boundaries.md'), 'utf8');
      assert.match(text, /^max_autonomous_tier: 3$/m,
        'the seeded value must parse with identity/index.js loadBoundaries\' own regex');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('never touches a file the operator already has', () => {
    const root = tmpDir();
    try {
      write(path.join(root, 'Identity', 'boundaries.md'), 'mine\n');
      const res = seedBoundaries({ fs: fsStore(root), config: { AUTONOMOUS_MAX_TIER: 4 } });
      assert.equal(res.status, 'exists');
      assert.equal(fs.readFileSync(path.join(root, 'Identity', 'boundaries.md'), 'utf8'), 'mine\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('an unwritable vault is a degraded install, not a failed boot', () => {
    const res = seedBoundaries({
      fs: {
        exists: () => false,
        vaultPath: (r) => r,
        ensureDir: () => {},
        writeText: () => { throw new Error('EROFS: read-only file system'); },
      },
      config: { AUTONOMOUS_MAX_TIER: 2 },
    });
    assert.equal(res.status, 'failed');
    assert.match(res.error, /EROFS/);
  });

  it('renders a tier the leash can never widen past, even from a nonsense config', () => {
    assert.match(renderBoundaries(0), /^max_autonomous_tier: 0$/m);
    // A non-integer configured ceiling falls back to the canonical default rather
    // than writing something loadBoundaries would read as malformed.
    const res = seedBoundaries({
      fs: { exists: () => false, vaultPath: (r) => r, ensureDir: () => {}, writeText: () => {} },
      config: { AUTONOMOUS_MAX_TIER: 'wide open' },
    });
    assert.equal(res.tier, 2);
  });
});
