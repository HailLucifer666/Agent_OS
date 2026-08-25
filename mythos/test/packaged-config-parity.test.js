'use strict';

// test/packaged-config-parity.test.js — THE test that would have caught every
// item in the 2026-08-11 installer-parity incident.
//
// WHAT HAPPENED: a freshly installed MYTHOS.exe logged four incidents in under
// two minutes — system volume oscillating between 100% and 15%, Spotify playing a
// live cut, Tier-1/2 approval prompts with autonomy configured not to need them,
// and a dead wake word. All four had been fixed and verified across two months of
// the Electron dev run. A file-by-file hash comparison then showed all 409 files
// under mythos/** in the install were byte-identical to the working tree.
//
// The code was never the problem. mythos/.env is excluded from package.json
// build.files, and src/core/config/index.js loaded configuration from exactly one
// place: mythos/.env. So in the packaged build ~140 keys silently fell back to
// their schema defaults, and there was no UI anywhere to set a non-secret key.
//
// So this file simulates a PACKAGED environment — no .env at all, one
// representative config.json — and asserts the effective values equal what the
// dev run produces from its .env. Nothing here touches Electron, the network, or
// the real userData directory.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/core/config');
const { readSettings, writeSetting, isSecretShaped, resolveSettingsPath } = require('../src/core/config/settings-store');

// The keys dev's .env sets that a packaged install had no way to receive. Each one
// is traceable to an incident: S2S/TTS to the volume loop and the flat voice,
// WAKEWORD to the dead wake word, AUTONOMOUS_MAX_TIER to the approval prompts.
const DEV_ENV = {
  VOICE_S2S_ENABLED: 'true',
  VOICE_TTS_PROVIDER: 'gemini',
  WAKEWORD_ENABLED: 'true',
  AUTONOMOUS_MAX_TIER: '2',
  AETHER_ENABLED: 'true',
  MYTHOS_PORT: '4478',
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-parity-'));
}

// A clean process.env: no ambient MYTHOS_*/VOICE_*/GOOGLE_* from the machine
// running the suite, so the test describes an environment instead of inheriting
// one. envOverrides cannot do this alone — loadConfig spreads the REAL
// process.env underneath it.
function withCleanEnv(extra, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(MYTHOS_|VOICE_|WAKEWORD_|AETHER_|DSH_|GOOGLE_|GEMINI_|AUTONOMOUS_|DUCK_|PIPER_|LIVE_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, extra || {});
  try { return fn(); } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

describe('packaged-config parity: config.json must reproduce the dev run', () => {
  it('with NO .env and a representative config.json, effective values match dev', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify(DEV_ENV, null, 2), 'utf8');

    try {
      // THE PACKAGED RUN: nothing in the environment, everything in config.json.
      // envFileKeys is empty because there is no .env to have loaded.
      const packaged = withCleanEnv({ MYTHOS_SETTINGS_PATH: settingsPath }, () =>
        loadConfig({ envFileKeys: new Set() }));

      // THE DEV RUN: main.js loads mythos/.env INTO process.env, so every key
      // arrives as an environment variable AND is named in envFileKeys.
      const dev = withCleanEnv(DEV_ENV, () =>
        loadConfig({ envFileKeys: new Set(Object.keys(DEV_ENV)), settingsPath: path.join(dir, 'no-such-config.json') }));

      assert.equal(packaged.ok, true, packaged.errors.join(', '));
      assert.equal(dev.ok, true, dev.errors.join(', '));

      for (const key of Object.keys(DEV_ENV)) {
        assert.deepEqual(
          packaged.config[key], dev.config[key],
          `${key}: packaged=${packaged.config[key]} dev=${dev.config[key]} — a packaged install must reach the same value`,
        );
      }

      // And the ORIGIN must say so, because a value that is right by accident (the
      // schema default happening to match) is a different fact from a value the
      // operator set. This is what scripts/parity-check.js asserts on.
      assert.equal(packaged.origins.VOICE_S2S_ENABLED, 'config.json');
      assert.equal(dev.origins.VOICE_S2S_ENABLED, '.env');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('THE ORIGINAL BUG: no .env and no config.json leaves the incident keys at their defaults', () => {
    const dir = tmpDir();
    try {
      // wakewordModelsDir points at an EMPTY directory on purpose. Without it this
      // test would pass or fail depending on whether the machine running the suite
      // happens to have downloaded the wake-word weights — deriveWakewordDefaults
      // arms the flag from files on disk, which is the correct behaviour and the
      // wrong thing for a test that is describing a fresh install.
      const bare = withCleanEnv({ MYTHOS_SETTINGS_PATH: path.join(dir, 'absent.json') }, () =>
        loadConfig({ envFileKeys: new Set(), wakewordModelsDir: dir }));

      // This is exactly the install the operator ran. Asserted so the failure mode
      // stays legible rather than becoming folklore: with no config file, Live is
      // off (which puts the run on the ducking path — incident 1) and the wake word
      // is off (incident 4).
      assert.equal(bare.config.VOICE_S2S_ENABLED, false);
      assert.equal(bare.origins.VOICE_S2S_ENABLED, 'default');
      assert.equal(bare.config.WAKEWORD_ENABLED, false);
      assert.ok(['default', 'derived'].includes(bare.origins.WAKEWORD_ENABLED));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('precedence: real env > config.json > .env > default', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ MYTHOS_NAME: 'FROM_CONFIG_JSON', LOG_LEVEL: 'warn' }), 'utf8');

    try {
      // MYTHOS_NAME is present in the environment as a .env-sourced key, so
      // config.json outranks it. LOG_LEVEL is a REAL environment variable and
      // outranks config.json.
      const res = withCleanEnv({
        MYTHOS_SETTINGS_PATH: settingsPath,
        MYTHOS_NAME: 'FROM_DOT_ENV',
        LOG_LEVEL: 'debug',
      }, () => loadConfig({ envFileKeys: new Set(['MYTHOS_NAME']) }));

      assert.equal(res.config.MYTHOS_NAME, 'FROM_CONFIG_JSON', 'config.json must beat a .env value');
      assert.equal(res.origins.MYTHOS_NAME, 'config.json');
      assert.equal(res.config.LOG_LEVEL, 'debug', 'a real environment variable must beat config.json');
      assert.equal(res.origins.LOG_LEVEL, 'env');
      assert.equal(res.origins.MYTHOS_BIND, 'default', 'an untouched key still reports default');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omitting envFileKeys keeps the pre-existing behaviour (the whole environment is real)', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ MYTHOS_NAME: 'FROM_CONFIG_JSON' }), 'utf8');
    try {
      const res = withCleanEnv({ MYTHOS_SETTINGS_PATH: settingsPath, MYTHOS_NAME: 'FROM_ENV' }, () => loadConfig());
      assert.equal(res.config.MYTHOS_NAME, 'FROM_ENV',
        'with no envFileKeys every environment value is treated as real — headless and test callers are unaffected');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('settings-store: what it accepts, and what it refuses', () => {
  it('drops unknown keys and reports them instead of pretending they applied', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      MYTHOS_NAME: 'ok',
      VOICE_TTS_PROVDER: 'gemini',        // typo — the exact silent failure
      MYTHOS_PORT: { nested: true },      // a REAL schema key with a non-scalar value
      LOG_LEVEL: 'multi\nline',           // a real key whose value cannot be an env var
    }), 'utf8');
    try {
      const read = readSettings({ settingsPath });
      assert.deepEqual(Object.keys(read.values), ['MYTHOS_NAME']);
      assert.deepEqual(read.unknown, ['VOICE_TTS_PROVDER'],
        'a typo\'d key must be REPORTED, not silently ignored — that is the whole failure mode');
      assert.ok(read.dropped.some((d) => d.name === 'MYTHOS_PORT' && d.reason === 'non-scalar-value'));
      assert.ok(read.dropped.some((d) => d.name === 'LOG_LEVEL' && d.reason === 'multi-line-value'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a corrupt file is empty-plus-error, never a failed boot', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, '{ not json', 'utf8');
    try {
      const read = readSettings({ settingsPath });
      assert.deepEqual(read.values, {});
      assert.match(read.error, /unparseable/);
      // And loadConfig must still succeed, carrying the error up for main.js to
      // put on the bus.
      const res = withCleanEnv({ MYTHOS_SETTINGS_PATH: settingsPath }, () => loadConfig({ envFileKeys: new Set() }));
      assert.equal(res.ok, true);
      assert.match(res.settingsError, /unparseable/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses to write a secret-shaped key into plain-text config.json', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    try {
      for (const name of ['GOOGLE_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'MYTHOS_AUTH_TOKEN']) {
        assert.equal(isSecretShaped(name), true, `${name} must be recognised as a secret`);
        const res = writeSetting({ name, value: 'x', settingsPath });
        assert.equal(res.ok, false);
        assert.match(res.error, /key store/);
      }
      assert.equal(fs.existsSync(settingsPath), false, 'a refused write must not create the file');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a key that is not in the schema, and clears on an empty value', () => {
    const dir = tmpDir();
    const settingsPath = path.join(dir, 'config.json');
    try {
      assert.equal(writeSetting({ name: 'NOT_A_SETTING', value: '1', settingsPath }).ok, false);
      assert.equal(writeSetting({ name: 'MYTHOS_NAME', value: 'ZED', settingsPath }).ok, true);
      assert.equal(readSettings({ settingsPath }).values.MYTHOS_NAME, 'ZED');
      // '' CLEARS rather than storing an empty string: the schema's own "unset" is
      // the empty string, so storing it would pin the key at empty forever instead
      // of letting the layers underneath speak again.
      const cleared = writeSetting({ name: 'MYTHOS_NAME', value: '', settingsPath });
      assert.equal(cleared.ok, true);
      assert.equal(cleared.cleared, true);
      assert.equal(readSettings({ settingsPath }).values.MYTHOS_NAME, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolveSettingsPath prefers the injected path, then falls back beside the vault', () => {
    assert.equal(
      resolveSettingsPath({ env: { MYTHOS_SETTINGS_PATH: path.join('C:', 'x', 'config.json') } }),
      path.resolve(path.join('C:', 'x', 'config.json')),
    );
    const beside = resolveSettingsPath({ env: {}, vaultRoot: path.join('C:', 'data', 'vault') });
    assert.equal(beside, path.resolve(path.join('C:', 'data', 'config.json')));
  });
});
