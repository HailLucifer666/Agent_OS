'use strict';

// test/keystore-recrypt.test.js — the second half of the "a fresh install asks
// for every API key again" bug (operator, 2026-08-13).
//
// The 2026-08-12 fix (adoptSiblingUserDataFiles, see reinstall-asks-again.test.js)
// copied %APPDATA%\agent-os\keys.json to %APPDATA%\MYTHOS\keys.json and the
// wizard STILL asked for everything. Measured on the operator's machine: the two
// files are byte-identical, and main.log logs `safeStorage: failed to decrypt
// "<name>"` for all 9 keys on every boot.
//
// WHY: the comment in vault-migration.js said DPAPI is scoped to the Windows
// USER, so a copied file still decrypts. That is true of raw DPAPI and false of
// what Electron actually does. Chromium's OSCrypt encrypts values with a
// per-PROFILE AES-256-GCM key that lives in that profile's `Local State`
// (os_crypt.encrypted_key, itself DPAPI-wrapped). Two userData directories have
// two different AES keys, so the ciphertext is not portable — copying it can
// only ever deliver blobs the destination profile cannot read.
//
// The keys are not lost: the source profile's Local State key still decrypts
// them. They need re-encrypting under the destination profile's key, which is
// what recryptForeignStore does — and what these tests pin, with injected fakes
// so nothing here touches real DPAPI, real Electron, or the operator's store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recryptForeignStore } = require('../../electron/keystore-recrypt');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-recrypt-')); }

// A REAL Chromium-shaped blob: "v10" + 12-byte nonce + ciphertext + 16-byte GCM
// tag, base64. Built with node:crypto so the module is decrypting genuine
// AES-256-GCM, not a stand-in the test also defines.
function makeV10Blob(plaintext, aesKey, nonce = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, body, cipher.getAuthTag()])
    .toString('base64');
}

// The destination profile's safeStorage: round-trips its OWN ciphertext and
// throws on anything else — exactly how the real one behaves against a blob
// encrypted under another profile's key.
function fakeSafeStorage(tag = 'dest') {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.concat([Buffer.from(`${tag}:`, 'utf8'), Buffer.from(s, 'utf8')]),
    decryptString: (buf) => {
      const prefix = `${tag}:`;
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('Error while decrypting the ciphertext provided to safeStorage');
      return text.slice(prefix.length);
    },
  };
}

// A sibling profile directory with a Local State whose os_crypt.encrypted_key
// is "DPAPI" + a wrapped blob. The fake unprotect below maps the wrapped bytes
// back to the AES key, so no real DPAPI call is ever made.
function writeLocalState(dir, wrapped) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI', 'latin1'), wrapped]).toString('base64') } }),
    'utf8',
  );
  return dir;
}

function writeStore(userDataDir, map) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'keys.json'), JSON.stringify(map, null, 2), 'utf8');
}

function readStore(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'keys.json'), 'utf8'));
}

// One fixture: a destination profile holding blobs encrypted under a FOREIGN
// profile key, plus that foreign profile's Local State.
function scenario({ keys, extraStore = {}, wrapForeign = true } = {}) {
  const parent = tmpDir();
  const userDataDir = path.join(parent, 'MYTHOS');
  const foreignDir = path.join(parent, 'agent-os');
  const foreignAesKey = crypto.randomBytes(32);
  const wrapped = crypto.randomBytes(24); // opaque DPAPI ciphertext, never unwrapped for real

  const store = { ...extraStore };
  for (const [name, value] of Object.entries(keys)) store[name] = makeV10Blob(value, foreignAesKey);
  writeStore(userDataDir, store);
  if (wrapForeign) writeLocalState(foreignDir, wrapped);

  const lines = [];
  return {
    userDataDir,
    foreignDir,
    foreignAesKey,
    lines,
    run: (overrides = {}) => recryptForeignStore({
      userDataDir,
      siblingProfileDirs: [foreignDir, path.join(parent, 'Electron')],
      safeStorage: fakeSafeStorage(),
      dpapiUnprotect: (buf) => (Buffer.compare(buf, wrapped) === 0 ? foreignAesKey : null),
      log: (...args) => lines.push(args.join(' ')),
      ...overrides,
    }),
  };
}

describe('keystore-recrypt: keys survive a profile adoption', () => {
  it('recovers foreign-profile blobs and re-encrypts them under this profile', () => {
    const s = scenario({ keys: { GOOGLE_API_KEY: 'goog-secret-1', GROQ_API_KEY: 'groq-secret-2' } });

    const result = s.run();

    assert.deepEqual(result.recovered.sort(), ['GOOGLE_API_KEY', 'GROQ_API_KEY']);
    assert.deepEqual(result.failed, []);
    // The whole point: the destination profile can now read its own store.
    const dest = fakeSafeStorage();
    const store = readStore(s.userDataDir);
    assert.equal(dest.decryptString(Buffer.from(store.GOOGLE_API_KEY, 'base64')), 'goog-secret-1');
    assert.equal(dest.decryptString(Buffer.from(store.GROQ_API_KEY, 'base64')), 'groq-secret-2');
  });

  it('is idempotent — a second pass finds nothing to recover', () => {
    const s = scenario({ keys: { GOOGLE_API_KEY: 'goog-secret-1' } });

    assert.equal(s.run().recovered.length, 1);
    const second = s.run();

    assert.deepEqual(second.recovered, []);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.skipped, ['GOOGLE_API_KEY'], 'an already-good key is skipped, not re-encrypted');
  });

  it('leaves already-decryptable keys byte-identical', () => {
    // No marker file guards this pass, so "skip what already works" is the only
    // thing standing between a boot-time recovery and a store rewritten on
    // every launch.
    const good = fakeSafeStorage().encryptString('already-fine').toString('base64');
    const s = scenario({ keys: { GROQ_API_KEY: 'needs-recovery' }, extraStore: { GOOGLE_API_KEY: good } });

    const result = s.run();

    assert.deepEqual(result.skipped, ['GOOGLE_API_KEY']);
    assert.deepEqual(result.recovered, ['GROQ_API_KEY']);
    assert.equal(readStore(s.userDataDir).GOOGLE_API_KEY, good);
  });

  it('reports a non-v10 blob as failed and never writes it back mangled', () => {
    const s = scenario({
      keys: { GROQ_API_KEY: 'needs-recovery' },
      extraStore: { WEIRD_KEY: Buffer.from('not-a-chromium-blob').toString('base64') },
    });

    const result = s.run();

    assert.deepEqual(result.failed, ['WEIRD_KEY'], 'no guessing at an unrecognised format');
    assert.equal(readStore(s.userDataDir).WEIRD_KEY, Buffer.from('not-a-chromium-blob').toString('base64'));
    assert.deepEqual(result.recovered, ['GROQ_API_KEY'], 'one bad entry does not abort the pass');
  });

  it('a blob no sibling key can decrypt stays untouched and is reported failed', () => {
    const orphanKey = crypto.randomBytes(32);
    const s = scenario({ keys: { GOOGLE_API_KEY: 'recoverable' } });
    const store = readStore(s.userDataDir);
    store.LOST_KEY = makeV10Blob('encrypted-under-a-third-profile', orphanKey);
    writeStore(s.userDataDir, store);

    const result = s.run();

    assert.deepEqual(result.failed, ['LOST_KEY']);
    assert.equal(readStore(s.userDataDir).LOST_KEY, store.LOST_KEY);
  });

  it('tolerates a missing or corrupt sibling Local State', () => {
    const missing = scenario({ keys: { GOOGLE_API_KEY: 'x' }, wrapForeign: false });
    const result = missing.run();
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.failed, ['GOOGLE_API_KEY'], 'unrecoverable is reported, not thrown');

    const corrupt = scenario({ keys: { GOOGLE_API_KEY: 'x' } });
    fs.writeFileSync(path.join(corrupt.foreignDir, 'Local State'), '{not json', 'utf8');
    assert.deepEqual(corrupt.run().failed, ['GOOGLE_API_KEY']);
  });

  it('tolerates a missing key store entirely', () => {
    const parent = tmpDir();
    const result = recryptForeignStore({
      userDataDir: path.join(parent, 'MYTHOS'),
      siblingProfileDirs: [path.join(parent, 'agent-os')],
      safeStorage: fakeSafeStorage(),
      dpapiUnprotect: () => null,
    });
    assert.deepEqual(result, { recovered: [], failed: [], skipped: [] });
  });

  it('does nothing when encryption is unavailable — those values are plain text', () => {
    const s = scenario({ keys: { GOOGLE_API_KEY: 'x' } });
    const plain = { ...fakeSafeStorage(), isEncryptionAvailable: () => false };
    const before = readStore(s.userDataDir);

    const result = s.run({ safeStorage: plain });

    assert.deepEqual(result, { recovered: [], failed: [], skipped: [] });
    assert.deepEqual(readStore(s.userDataDir), before);
  });

  it('never logs a key value — names and counts only', () => {
    const s = scenario({ keys: { GOOGLE_API_KEY: 'goog-secret-1', GROQ_API_KEY: 'groq-secret-2' } });

    s.run();

    const all = s.lines.join('\n');
    assert.ok(all.length > 0, 'the pass must be diagnosable from the log');
    for (const secret of ['goog-secret-1', 'groq-secret-2']) {
      assert.ok(!all.includes(secret), `the log leaked a key value: ${secret}`);
    }
    assert.match(all, /GOOGLE_API_KEY/, 'names are fine and are what makes it diagnosable');
  });
});

describe('keystore-recrypt: wiring in electron/main.js', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');

  it('recovery runs after adoption and before the fork reads the keys', () => {
    // Source-shape, same style as reinstall-asks-again.test.js: adoption puts a
    // foreign store in place, recovery makes it readable, and the fork's
    // decryptedKeysForChild() must see the result on the SAME boot — otherwise
    // the wizard still asks once more.
    const adopt = main.indexOf('adoptSiblingUserDataFiles({');
    const recrypt = main.indexOf('recryptForeignStore({');
    const keyRead = main.indexOf('...decryptedKeysForChild(),');
    assert.ok(recrypt > 0, 'main.js must call recryptForeignStore');
    assert.ok(adopt > 0 && adopt < recrypt, 'recovery must follow adoption — it has nothing to recover before it');
    assert.ok(recrypt < keyRead, 'recovery must precede the key read at fork');
  });

  it('a recovery failure cannot stop the app booting', () => {
    // The nearest `try {` above the call must be closer than the nearest
    // `catch` above it — i.e. the call is inside an open try block.
    const call = main.indexOf('recryptForeignStore({');
    const before = main.slice(0, call);
    assert.ok(before.lastIndexOf('try {') > before.lastIndexOf('catch'),
      'the call must sit inside a try/catch — the app already boots fine with zero keys');
    assert.match(main.slice(call), /catch \(err\)[\s\S]{0,200}keystore-recrypt/,
      'the catch must log rather than swallow');
  });
});
