'use strict';

// import-existing.js — find an existing MYTHOS on this machine and bring its
// configuration and identity across.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): a fresh install of MYTHOS.exe
// booted with a second, empty brain and ~140 configuration keys at their schema
// defaults, and the operator's remedy was to re-derive two months of setup by
// hand. Two separate causes, both of which this addresses:
//
//   1. mythos/.env is excluded from package.json build.files, and it was the ONLY
//      place that ever set VOICE_S2S_ENABLED, VOICE_TTS_PROVIDER,
//      WAKEWORD_ENABLED, the AETHER_*/HERMES_* block and the local tool paths.
//   2. electron/main.js had no app.setName, so the dev run wrote
//      %APPDATA%\Electron, the installed .exe wrote %APPDATA%\agent-os, and the
//      NSIS installer wrote %APPDATA%\MYTHOS — three vaults, no migration. The
//      install had none of dev's Identity/boundaries.md, operator-profile.txt,
//      operator-style.txt, Contacts/contacts.json or 8 learned Skills/*.md.
//
// electron/vault-migration.js adopts a sibling vault automatically on first boot.
// This module is the EXPLICIT, operator-confirmed path: it says what it found,
// and copies only what was confirmed. The two are complementary — the automatic
// one handles the common case silently, this one handles "I have a dev checkout
// over there and I want its settings too", which nothing can infer.
//
// FOUR RULES, all of them the point:
//   - SCANNING NEVER WRITES. scanForExisting() is read-only, always.
//   - NEVER OVERWRITE without being told to. A file that already exists is
//     reported as a conflict and skipped unless overwrite:true.
//   - NEVER IMPORT A SECRET VALUE. .env files hold API keys; those belong in the
//     safeStorage-encrypted key store, and this module refuses to move them into
//     plain-text config.json. Their NAMES are reported so the operator knows what
//     they still have to re-enter, and nothing is silently carried across.
//   - UNKNOWN KEYS ARE DROPPED. Only names in SCHEMA are imported; anything else
//     would sit in config.json looking applied forever.
//
// The copy/verify primitives are electron/vault-migration.js's, reused rather
// than rewritten — that file already learned to verify a copy by file count and
// byte total, and to leave the source untouched.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SCHEMA } = require('../config/schema');
const { isSecretShaped, writeSetting } = require('../config/settings-store');

// The files that shape WHO MYTHOS IS, as opposed to what it remembers. Copying
// the whole vault is electron/vault-migration.js's job; this list is the subset
// worth importing into an install that already has episodic history of its own.
//
// Skills/*.md is a directory glob rather than a fixed name because the count is
// whatever the entity has actually learned — 8 on the operator's dev run.
const IDENTITY_FILES = [
  'Identity/boundaries.md',
  'Identity/operator-profile.txt',
  'Identity/operator-style.txt',
  'Contacts/contacts.json',
];
const IDENTITY_DIRS = ['Skills'];

// Every userData directory MYTHOS has ever used on this machine. See
// electron/main.js's app.setName comment for how there came to be three.
const USER_DATA_NAMES = ['MYTHOS', 'agent-os', 'Electron'];

// ---- reading -------------------------------------------------------------------

// Parse a .env into {KEY: value}. Deliberately minimal and NOT a dotenv clone:
// KEY=value, `export ` tolerated, # comments and blank lines skipped, one pair of
// matching surrounding quotes stripped. Anything more elaborate (multi-line
// values, ${VAR} expansion) is not something this importer should be guessing at
// — an unparsed line is reported, never approximated.
function parseEnvFile(text) {
  const values = {};
  const unparsed = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) { unparsed.push(line.slice(0, 120)); continue; }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return { values, unparsed };
}

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}

function countVaultFiles(dir) {
  let files = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.isFile()) files += 1;
    }
  };
  try { walk(dir); } catch { /* unreadable → 0 */ }
  return files;
}

// Which identity-shaping files a candidate vault actually holds. This is what
// makes the confirm screen honest: it lists the real files, not the ones this
// module hopes are there.
function inspectVault(vaultRoot) {
  const found = [];
  for (const rel of IDENTITY_FILES) {
    const file = path.join(vaultRoot, rel);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) found.push({ rel, bytes: st.size });
    } catch { /* absent */ }
  }
  for (const dir of IDENTITY_DIRS) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(vaultRoot, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'));
    } catch { /* absent */ }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      let bytes = 0;
      try { bytes = fs.statSync(path.join(vaultRoot, rel)).size; } catch { /* ignore */ }
      if (bytes > 0) found.push({ rel, bytes });
    }
  }
  return found;
}

// The directories worth looking in, derived from the environment — never a
// hardcoded user path (AD-7). `repoRoot` is the mythos/ directory of a source
// checkout, when the caller knows of one.
function candidateRoots({ env, homedir, repoMythosDir } = {}) {
  const e = env || process.env;
  const home = homedir || os.homedir();
  const bases = [];
  if (e.APPDATA) bases.push(e.APPDATA);
  if (e.XDG_CONFIG_HOME) bases.push(e.XDG_CONFIG_HOME);
  bases.push(path.join(home, '.config'));
  bases.push(path.join(home, 'Library', 'Application Support'));

  const out = [];
  for (const base of bases) {
    for (const name of USER_DATA_NAMES) {
      out.push({ kind: 'userData', label: `${name} (application data)`, dir: path.join(base, name) });
    }
  }
  if (repoMythosDir) {
    out.push({ kind: 'repo', label: 'source checkout', dir: path.resolve(repoMythosDir) });
  }
  return out;
}

// scanForExisting({env, homedir, repoMythosDir, excludeDir}) -> {sources:[...]}
//
// READ-ONLY. `excludeDir` is this install's own userData, so it never offers to
// import from itself.
//
// Each source reports:
//   settings  — non-secret schema keys available to import, with values
//   secrets   — NAMES ONLY of secret-shaped keys found (never values)
//   unknown   — keys that are not in SCHEMA and will be dropped
//   vault     — {root, files, identity:[{rel,bytes}]} when a vault is present
function scanForExisting(opts) {
  const o = opts || {};
  const exclude = o.excludeDir ? path.resolve(o.excludeDir) : null;
  const sources = [];

  for (const candidate of candidateRoots(o)) {
    if (exclude && path.resolve(candidate.dir) === exclude) continue;

    // A userData root holds config.json; a repo checkout holds .env. Both are
    // read for both shapes, because a repo checkout of an older build may well
    // have neither and there is no cost to looking.
    const configFile = path.join(candidate.dir, 'config.json');
    const envFile = path.join(candidate.dir, '.env');
    const rawPairs = {};
    const filesRead = [];
    const unparsedLines = [];

    const fromConfig = readJsonSafe(configFile);
    if (fromConfig) {
      filesRead.push(configFile);
      for (const [k, v] of Object.entries(fromConfig)) {
        if (v === null || typeof v === 'object') continue;
        rawPairs[k] = String(v);
      }
    }
    try {
      if (fs.statSync(envFile).isFile()) {
        const parsed = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
        filesRead.push(envFile);
        unparsedLines.push(...parsed.unparsed);
        // config.json wins over .env inside a single source, mirroring the
        // runtime precedence in core/config/index.js. Same rule everywhere.
        for (const [k, v] of Object.entries(parsed.values)) {
          if (!Object.prototype.hasOwnProperty.call(rawPairs, k)) rawPairs[k] = v;
        }
      }
    } catch { /* absent or unreadable */ }

    const settings = {};
    const secrets = [];
    const unknown = [];
    for (const [name, value] of Object.entries(rawPairs)) {
      // Secret-shape FIRST, schema membership second — for the same reason
      // settings-store.js's writeSetting orders them that way. Not every secret is
      // a schema key: GOOGLE_API_KEY is read straight from the environment and is
      // not in SCHEMA at all, so a schema-first check filed the operator's Gemini
      // key under "unknown" and told them nothing about the one credential they
      // most needed to re-enter.
      if (isSecretShaped(name)) { secrets.push(name); continue; } // NAME only, never the value
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, name)) { unknown.push(name); continue; }
      if (String(value) === '') continue; // an unset key is not a setting to carry over
      settings[name] = String(value);
    }

    const vaultRoot = path.join(candidate.dir, 'vault');
    let vault = null;
    try {
      if (fs.statSync(vaultRoot).isDirectory()) {
        vault = { root: vaultRoot, files: countVaultFiles(vaultRoot), identity: inspectVault(vaultRoot) };
      }
    } catch { /* no vault here */ }

    if (!filesRead.length && !vault) continue; // nothing here at all

    sources.push({
      kind: candidate.kind,
      label: candidate.label,
      dir: candidate.dir,
      filesRead,
      settings,
      settingsCount: Object.keys(settings).length,
      secrets: secrets.sort(),
      unknown: unknown.sort(),
      unparsedLines,
      vault,
    });
  }

  // Richest first, so the confirm screen's default is the one most likely to be
  // the operator's real install. Settings count then vault size — the same
  // "most data wins" heuristic vault-migration.js uses, and just as readable.
  sources.sort((a, b) => (b.settingsCount - a.settingsCount)
    || ((b.vault ? b.vault.files : 0) - (a.vault ? a.vault.files : 0)));
  return { sources };
}

// ---- writing -------------------------------------------------------------------

// importSettings({settings, settingsPath, overwrite, existing}) ->
//   {imported:[names], skipped:[{name,reason}]}
//
// Goes through settings-store.js's writeSetting so the schema check, the
// secret-shape refusal and the 0600 file mode all apply exactly once, in one
// place. A key this install has already set is a CONFLICT and is skipped unless
// overwrite is true — importing over a value the operator typed here would be
// the worst possible surprise from a button labelled "import".
function importSettings(opts) {
  const o = opts || {};
  const settings = o.settings || {};
  const existing = o.existing || {};
  const imported = [];
  const skipped = [];

  for (const [name, value] of Object.entries(settings)) {
    if (isSecretShaped(name)) { skipped.push({ name, reason: 'secret — enter it in the key store instead' }); continue; }
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, name)) { skipped.push({ name, reason: 'not a MYTHOS setting' }); continue; }
    if (!o.overwrite && Object.prototype.hasOwnProperty.call(existing, name)) {
      skipped.push({ name, reason: 'already set on this install' });
      continue;
    }
    const res = writeSetting({ name, value: String(value), settingsPath: o.settingsPath });
    if (res.ok) imported.push(name);
    else skipped.push({ name, reason: res.error });
  }

  return { imported, skipped };
}

// importVaultFiles({fromVault, toVault, overwrite, copyFile}) ->
//   {copied:[rel], skipped:[{rel,reason}]}
//
// One file at a time, verified by size after each copy. `copyFile` is an
// injectable seam for tests; production uses fs.copyFileSync.
function importVaultFiles(opts) {
  const o = opts || {};
  const from = o.fromVault;
  const to = o.toVault;
  const copyFile = o.copyFile || ((src, dest) => fs.copyFileSync(src, dest));
  const copied = [];
  const skipped = [];
  if (!from || !to) return { copied, skipped: [{ rel: '*', reason: 'missing source or destination vault' }] };

  for (const entry of inspectVault(from)) {
    const rel = entry.rel;
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    let destExists = false;
    try { destExists = fs.statSync(dest).size > 0; } catch { destExists = false; }
    if (destExists && !o.overwrite) {
      skipped.push({ rel, reason: 'already present on this install' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      copyFile(src, dest);
      // Verify by size, the same cheap check vault-migration.js's copyAndVerify
      // applies to a whole tree. A truncated copy of boundaries.md would clamp
      // the autonomy ceiling to 1 — precisely the incident this all comes from.
      const after = fs.statSync(dest).size;
      if (after !== entry.bytes) {
        skipped.push({ rel, reason: `copy verify failed: ${after}B on disk, expected ${entry.bytes}B` });
        continue;
      }
      copied.push(rel);
    } catch (err) {
      skipped.push({ rel, reason: err.message });
    }
  }
  return { copied, skipped };
}

module.exports = {
  scanForExisting,
  importSettings,
  importVaultFiles,
  parseEnvFile,
  inspectVault,
  candidateRoots,
  IDENTITY_FILES,
  IDENTITY_DIRS,
  USER_DATA_NAMES,
};
