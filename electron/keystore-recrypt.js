'use strict';

// electron/keystore-recrypt.js — recover a key store copied from another
// Electron profile (operator, 2026-08-13).
//
// THE BUG THIS EXISTS FOR. adoptSiblingUserDataFiles (./vault-migration.js)
// copies keys.json across the userData directories that app.setName('MYTHOS')
// orphaned, and the comment there justified it with "DPAPI is scoped to the
// WINDOWS USER, not to a directory, so a copied file still decrypts". That is
// true of raw DPAPI and false of what Electron actually does. Chromium's OSCrypt
// encrypts each value with a per-PROFILE AES-256-GCM key stored in that
// profile's `Local State` (os_crypt.encrypted_key, itself DPAPI-wrapped). Two
// userData directories therefore hold two different AES keys, and ciphertext is
// not portable between them.
//
// Measured on the operator's machine: %APPDATA%\MYTHOS\keys.json is a
// byte-identical copy of %APPDATA%\agent-os\keys.json (same SHA256), and
// main.log logs `safeStorage: failed to decrypt "<name>"` for all 9 keys on
// every boot. The child gets zero keys, /api/setup/status reports needsSetup,
// the wizard covers the HUD, and Groq STT has no key so every transcribe fails
// (health.anomaly stt-failed).
//
// The keys are NOT lost. The source profile's Local State key still decrypts
// them; they only need re-encrypting under THIS profile's key. That is all this
// module does, and it is deliberately idempotent — a blob that already decrypts
// is skipped, so the pass can run on every boot with no marker file to go stale.
//
// No `require('electron')` anywhere: safeStorage and the DPAPI unwrap are both
// injected, so this file is require()-able and unit-testable under a bare
// `node --test`, like ./vault-migration.js and ./child-exit.js.
//
// Nothing here ever logs, returns, or writes a decrypted value. Names and counts
// only — the same discipline as main.js's key-store IPC channels.

const crypto = require('node:crypto');
const child_process = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Chromium's OSCrypt wire format, Windows: "v10" + 12-byte nonce + ciphertext +
// 16-byte GCM tag, the whole thing base64 in keys.json.
const VERSION_PREFIX = 'v10';
const NONCE_LEN = 12;
const TAG_LEN = 16;
// Local State's os_crypt.encrypted_key is base64 of "DPAPI" + the DPAPI blob.
const DPAPI_PREFIX = 'DPAPI';

function readStore(file) {
  // Same tolerant shape as loadStore() in electron/main.js: a missing or corrupt
  // store is an empty one, never a crash.
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

// Windows DPAPI unwrap, out-of-process because Node has no binding for it. The
// blob goes in on stdin and comes back on stdout, both base64 — never on argv
// (visible in the process list) and never logged.
//
// PowerShell 5.1 has no AesGcm class, which is why only this one step runs
// there and the actual AES-GCM decrypt below uses node:crypto.
function defaultDpapiUnprotect(blob) {
  if (process.platform !== 'win32') return null;
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$b = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())',
    "$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
    '[Console]::Out.Write([Convert]::ToBase64String($p))',
  ].join('; ');
  const res = child_process.spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: blob.toString('base64'), encoding: 'utf8', windowsHide: true },
  );
  if (res.status !== 0 || !res.stdout) return null;
  const out = Buffer.from(res.stdout.trim(), 'base64');
  return out.length ? out : null;
}

// One profile's AES key, or null. Every failure here is expected on a normal
// machine (the sibling profile may simply not exist), so none of them throw.
function profileKey(profileDir, dpapiUnprotect, log) {
  const file = path.join(profileDir, 'Local State');
  let encoded;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    encoded = parsed && parsed.os_crypt && parsed.os_crypt.encrypted_key;
  } catch {
    return null; // absent or unparseable — not an error worth a line
  }
  if (typeof encoded !== 'string' || !encoded) return null;

  const wrapped = Buffer.from(encoded, 'base64');
  if (wrapped.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    log(`keystore-recrypt: ${profileDir} — Local State key has no DPAPI prefix, skipping`);
    return null;
  }
  let key;
  try {
    key = dpapiUnprotect(wrapped.subarray(DPAPI_PREFIX.length));
  } catch (err) {
    log(`keystore-recrypt: ${profileDir} — DPAPI unwrap failed: ${err.message}`);
    return null;
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    if (key) log(`keystore-recrypt: ${profileDir} — unwrapped key is ${key.length} bytes, expected 32`);
    return null;
  }
  return key;
}

// AES-256-GCM over a v10 blob. Returns null for anything that is not a v10 blob
// or does not authenticate under this key — never a guess at another format.
function decryptV10(blob, aesKey) {
  if (blob.length < VERSION_PREFIX.length + NONCE_LEN + TAG_LEN) return null;
  if (blob.subarray(0, VERSION_PREFIX.length).toString('latin1') !== VERSION_PREFIX) return null;
  const nonce = blob.subarray(VERSION_PREFIX.length, VERSION_PREFIX.length + NONCE_LEN);
  const body = blob.subarray(VERSION_PREFIX.length + NONCE_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key, or a tampered blob — the GCM tag is the oracle
  }
}

// recryptForeignStore({userDataDir, siblingProfileDirs, safeStorage, dpapiUnprotect, log})
//   -> { recovered: [names], failed: [names], skipped: [names] }
//
//   skipped    already decrypts under THIS profile — untouched, which is what
//              makes the whole pass idempotent and marker-free.
//   recovered  decrypted with a sibling profile's key and re-encrypted here.
//   failed     not a v10 blob, or no sibling key decrypts it. Left exactly as
//              found: a store this cannot read is still the operator's data.
//
// The store is written once, at the end, and only when something was recovered.
function recryptForeignStore({
  userDataDir,
  siblingProfileDirs = [],
  safeStorage,
  dpapiUnprotect = defaultDpapiUnprotect,
  log = () => {},
} = {}) {
  const empty = { recovered: [], failed: [], skipped: [] };
  if (!userDataDir || !safeStorage) return empty;
  // Plain-text fallback (main.js logs it loudly on its own): those values are
  // not ciphertext at all, so there is nothing to re-encrypt and rewriting them
  // would be the only way to lose them.
  try { if (!safeStorage.isEncryptionAvailable()) return empty; }
  catch { return empty; }

  const storeFile = path.join(userDataDir, 'keys.json');
  const store = readStore(storeFile);
  if (!store) return empty;

  const recovered = [];
  const failed = [];
  const skipped = [];
  const stale = [];

  for (const [name, blob] of Object.entries(store)) {
    if (typeof blob !== 'string' || !blob) { failed.push(name); continue; }
    try {
      safeStorage.decryptString(Buffer.from(blob, 'base64'));
      skipped.push(name);
    } catch {
      stale.push(name);
    }
  }

  if (!stale.length) {
    if (skipped.length) log(`keystore-recrypt: all ${skipped.length} stored key(s) already decrypt under this profile.`);
    return { recovered, failed, skipped };
  }

  log(`keystore-recrypt: ${stale.length} stored key(s) do not decrypt under this profile — `
    + `attempting recovery from ${siblingProfileDirs.length} sibling profile(s): ${stale.join(', ')}`);

  // Unwrap each sibling profile key once, not once per blob — the default
  // unprotect spawns a PowerShell process.
  const foreignKeys = [];
  for (const dir of siblingProfileDirs) {
    const key = profileKey(dir, dpapiUnprotect, log);
    if (key) { foreignKeys.push(key); log(`keystore-recrypt: usable profile key found in ${dir}`); }
  }

  if (!foreignKeys.length) {
    log('keystore-recrypt: no sibling profile key available — nothing can be recovered this boot.');
    return { recovered, failed: failed.concat(stale), skipped };
  }

  for (const name of stale) {
    const blob = Buffer.from(store[name], 'base64');
    let plaintext = null;
    for (const key of foreignKeys) {
      plaintext = decryptV10(blob, key);
      if (plaintext !== null) break;
    }
    if (plaintext === null) { failed.push(name); continue; }
    try {
      store[name] = safeStorage.encryptString(plaintext).toString('base64');
      recovered.push(name);
    } catch (err) {
      log(`keystore-recrypt: re-encrypt failed for "${name}": ${err.message}`);
      failed.push(name);
    } finally {
      plaintext = null;
    }
  }

  if (recovered.length) {
    try {
      // 0600 like saveStore() in electron/main.js — no-op on Windows ACLs, but
      // this file is the same secret on every platform.
      fs.writeFileSync(storeFile, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      log(`keystore-recrypt: FAILED to persist the recovered store: ${err.message}`);
      return { recovered: [], failed: failed.concat(recovered), skipped };
    }
  }

  log(`keystore-recrypt: recovered ${recovered.length}, failed ${failed.length}, already-good ${skipped.length}`
    + `${failed.length ? ` — unrecoverable: ${failed.join(', ')}` : ''}`);
  return { recovered, failed, skipped };
}

module.exports = {
  recryptForeignStore,
  decryptV10,
  profileKey,
  defaultDpapiUnprotect,
};
