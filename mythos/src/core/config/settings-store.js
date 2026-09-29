'use strict';

// settings-store.js — the config file a PACKAGED install can actually write to.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the installed MYTHOS.exe and
// the dev `Start Electron App.bat` run the SAME 409 bytes-identical files under
// mythos/**, and behaved nothing alike. Four incidents in under two minutes —
// volume oscillating, Tier-2 approval prompts, dead wake word, the wrong TTS
// voice — were all one root cause: package.json build.files excludes
// mythos/.env, and src/main.js loads configuration from exactly one place,
// mythos/.env. So ~140 schema keys silently fell back to their defaults in the
// install, and there was NO UI anywhere in the packaged build to set a
// non-secret key (the wizard's key store only ever exposed provider API keys).
// The operator's only remedy was to edit a file that does not ship.
//
// This module adds the missing layer: a flat {KEY: "value"} JSON under the
// OS-managed userData directory, which survives reinstalls and updates and needs
// no write access to the install tree (Program Files is read-only for a
// per-user NSIS install anyway). electron/main.js injects its path as
// MYTHOS_SETTINGS_PATH; a headless run falls back to a file beside the vault.
//
// PRECEDENCE (applied in config/index.js loadConfig, and asserted by
// test/packaged-config-parity.test.js):
//
//   process.env  >  userData/config.json  >  mythos/.env  >  schema default
//
// .env is loaded INTO process.env by src/main.js, so "process.env beats
// config.json beats .env" cannot be read off the object identities alone — see
// loadConfig for how the .env layer is separated back out.
//
// Two deliberate refusals:
//   - unknown keys are DROPPED, not passed through. validate() ignores anything
//     outside SCHEMA, so a typo'd key would otherwise sit in the file looking
//     applied forever. The drop is reported once on the bus (health.anomaly).
//   - secret-shaped keys are refused on WRITE. Values here are plain text on
//     disk; API keys belong in the safeStorage-encrypted store that
//     electron/main.js already owns. A hand-written secret IS honoured on read
//     (the headless/.env path has always allowed plain-text keys, and silently
//     ignoring a key the operator typed would be worse), but nothing in the
//     product will ever put one here.
//
// No coercion, no type-checking, no defaults in this file. validate() in
// config/index.js owns all of that and stays the single authority — a second
// coercion path is how the two layers start disagreeing.

const fsDefault = require('node:fs');
const path = require('node:path');
const { SCHEMA } = require('./schema');

// Values land verbatim in a child process env (electron/main.js startChild), so
// the shape rules match mythos:set-key's: identifier-ish name, single-line value.
const KEY_RE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_VALUE_LEN = 4096;

// Plain-text on disk means "not for secrets". Suffix-matched rather than
// enumerated so a provider key added to the schema tomorrow is covered without
// anyone remembering to update a list.
const SECRET_SUFFIX_RE = /(_API_KEY|_KEY|_SECRET|_TOKEN|_PASSWORD)$/;
function isSecretShaped(name) {
  return SECRET_SUFFIX_RE.test(String(name).toUpperCase());
}

// resolveSettingsPath({env, vaultRoot}) -> absolute path
//
// MYTHOS_SETTINGS_PATH is what Electron injects and always wins. The vault-root
// fallback exists for bare `node src/main.js` (Docker, Render, the test suite):
// the vault is the one directory a headless deployment is already guaranteed to
// have chosen deliberately, so its parent is where a settings file belongs.
function resolveSettingsPath(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (env.MYTHOS_SETTINGS_PATH) return path.resolve(env.MYTHOS_SETTINGS_PATH);
  const vaultRoot = o.vaultRoot || env.MYTHOS_VAULT_ROOT || SCHEMA.MYTHOS_VAULT_ROOT.default;
  return path.resolve(path.join(vaultRoot, '..', 'config.json'));
}

// readSettings({settingsPath, env, vaultRoot, fs}) ->
//   {file, values:{KEY:string}, unknown:[names], dropped:[{name,reason}], error?}
//
// NEVER throws and never blocks boot. A missing file is the normal case on a
// fresh install; a corrupt one is reported through `error` and treated as empty,
// because refusing to start over an optional overlay would strand the operator
// with no way to fix the very file that is blocking them.
function readSettings(opts) {
  const o = opts || {};
  const fs = o.fs || fsDefault;
  const file = o.settingsPath || resolveSettingsPath(o);
  const empty = { file, values: {}, unknown: [], dropped: [] };

  let raw;
  try {
    if (!fs.existsSync(file)) return empty;
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ...empty, error: `unreadable: ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...empty, error: `unparseable: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, error: 'wrong-shape: expected a flat JSON object of KEY -> "value"' };
  }

  const values = {};
  const unknown = [];
  const dropped = [];
  for (const name of Object.keys(parsed)) {
    if (!KEY_RE.test(name)) { dropped.push({ name: String(name).slice(0, 80), reason: 'invalid-name' }); continue; }
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, name)) { unknown.push(name); continue; }
    const value = parsed[name];
    // Numbers and booleans are accepted and stringified because validate()
    // coerces from strings anyway — refusing `{"MYTHOS_PORT": 4478}` would be
    // pedantry against a hand-edited file. Objects/arrays/null are not values.
    if (value === null || typeof value === 'object') { dropped.push({ name, reason: 'non-scalar-value' }); continue; }
    const str = String(value);
    if (str.length > MAX_VALUE_LEN) { dropped.push({ name, reason: 'value-too-long' }); continue; }
    if (/[\r\n]/.test(str)) { dropped.push({ name, reason: 'multi-line-value' }); continue; }
    values[name] = str;
  }

  return { file, values, unknown, dropped };
}

// writeSetting({name, value, settingsPath, env, vaultRoot, fs}) -> {ok} | {ok:false, error}
//
// Read-modify-write of the whole file. An empty-string value DELETES the key
// rather than storing '': the schema's own "unset" is the empty string, and a
// stored '' would pin the key at empty forever instead of letting the .env /
// derived / default layers underneath it speak again — which is exactly the
// difference between "I cleared this" and "I want this blank".
// Every rule a setting must pass, with no file touched — so a confirmation can
// be shown for exactly what WILL be written (B3b review, 2026-09-30: the batch
// dialog used to show entries that were only rejected after the click).
function validateSetting(name, value) {
  if (typeof name !== 'string' || !KEY_RE.test(name)) {
    return { ok: false, error: 'invalid setting name (letters, digits, underscore; max 64)' };
  }
  // Secret-shape is checked BEFORE schema membership on purpose. Not every secret
  // a provider needs is a schema key (GOOGLE_API_KEY is read straight from the
  // environment, for one), and answering "that is not a MYTHOS setting" for an API
  // key would send the operator looking for the wrong problem instead of telling
  // them where the key actually goes.
  if (isSecretShaped(name)) {
    return { ok: false, error: `${name} looks like a secret — store it in the key store, not in config.json` };
  }
  if (!Object.prototype.hasOwnProperty.call(SCHEMA, name)) {
    return { ok: false, error: `${name} is not a MYTHOS setting` };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'invalid setting value (expected a string)' };
  }
  if (value.length > MAX_VALUE_LEN) {
    return { ok: false, error: 'that value is too long for a setting' };
  }
  if (/[\r\n]/.test(value)) {
    return { ok: false, error: 'a setting value cannot span lines' };
  }
  return { ok: true };
}

// A batch, all or nothing: every entry is validated first, and the file is
// written ONCE with all of them, so a confirmed batch never lands half-written.
function writeSettings(opts) {
  const o = opts || {};
  const fs = o.fs || fsDefault;
  const file = o.settingsPath || resolveSettingsPath(o);
  const changes = Array.isArray(o.changes) ? o.changes : [];
  if (!changes.length) return { ok: false, error: 'no settings to write' };
  for (const c of changes) {
    const v = validateSetting(c && c.name, c && c.value);
    if (!v.ok) return { ok: false, error: String(c && c.name) + ': ' + v.error };
  }

  // Start from the file's RAW contents, not from readSettings' filtered view:
  // rewriting the file must not silently delete an unknown key the operator is
  // in the middle of debugging, or a secret they chose to hand-write.
  let current = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    }
  } catch (err) {
    // A corrupt file cannot be safely merged into. Refuse rather than clobber
    // whatever the operator was trying to write by hand.
    return { ok: false, error: `existing settings file is unreadable, refusing to overwrite it: ${err.message}` };
  }

  for (const c of changes) {
    if (c.value === '') delete current[c.name];
    else current[c.name] = c.value;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600 for the same reason keys.json uses it (electron/main.js saveStore):
    // a multi-user box should not be able to read one operator's configuration.
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `could not write ${file}: ${err.message}` };
  }
  return { ok: true, file, cleared: changes.filter((c) => c.value === '').map((c) => c.name) };
}

function writeSetting(opts) {
  const o = opts || {};
  const res = writeSettings({ fs: o.fs, settingsPath: o.settingsPath, vaultRoot: o.vaultRoot, env: o.env, changes: [{ name: o.name, value: o.value }] });
  if (!res.ok) return { ok: false, error: res.error.replace(String(o.name) + ': ', '') };
  return { ok: true, file: res.file, cleared: o.value === '' };
}

module.exports = {
  resolveSettingsPath,
  readSettings,
  writeSetting,
  writeSettings,
  validateSetting,
  isSecretShaped,
  SETTINGS_KEY_RE: KEY_RE,
};
