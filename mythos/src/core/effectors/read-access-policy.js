'use strict';

// effectors/read-access-policy.js — which paths may MYTHOS's file tools read,
// list, open, index or copy? (2026-09-29 audit, B2d.) Pure: no fs.
//
// THE DEFECT. The file tools confine a path to "allowed roots", and the roots
// were the whole user profile (VOICE_ALLOWED_DIRS defaulted to %USERPROFILE%)
// plus a "project root" the comment called mythos/ but that resolved four levels
// up — the repository root. Nothing inside a root was off limits, so read_file,
// search_files and index_project (all tier 0/1, no confirmation) could read
// mythos/.env, Electron's keys.json, auth-sessions.json, ~/.ssh and every
// browser profile — and web_fetch could then carry what they read off the
// machine.
//
// THE RULE. A path is PROTECTED when any segment, or the file itself, is one of
// the credential shapes below. Protected wins over every root. Listings and walks
// leave protected children out; naming one explicitly is refused with the reason.
// Callers check BOTH the lexical path and the canonical (symlink-resolved) path,
// so a link named notes.txt that points at .env is refused too.
//
// SCOPE, stated so nobody mistakes it for more: names and locations only. A key
// pasted into an ordinary file is not caught here — that is redactText()'s job
// (credential-scanner.js), and pattern matching cannot catch every secret either.

const path = require('path');

// Every name containing ".env" (".env", ".env.local", ".env.bak-x", "Nvidia NIM.env",
// "prod.env.bak") — the backup shapes 2026-09-29's audit found in this repo. Not
// "env" alone: env.js is source and a virtualenv folder is often named env.
const ENV_FILE = /\.env/i;
// Credential files by exact name, at any depth.
const CREDENTIAL_FILES = new Set([
  'keys.json',            // Electron key store (electron/main.js storePath)
  '.git-credentials', '.netrc', '_netrc',
  'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_ecdsa.pub', 'id_dsa', 'id_dsa.pub',
  // Package-registry and database tokens (review, 2026-09-29: .npmrc's _authToken passed).
  '.npmrc', '.pypirc', '.pgpass', '.yarnrc.yml',
  'application_default_credentials.json', 'credentials.db', 'access_tokens.db',
]);
// Chromium/Electron profile stores, wherever an app keeps them — matched on the
// FILE only (extension-less, exact), so a folder called "Cookies" full of
// recipes is not caught.
const BROWSER_STORE_FILES = new Set(['cookies', 'login data', 'web data', 'local state']);
// auth-sessions.json and its atomic-write temporaries (server/auth-sessions.js).
const AUTH_SESSIONS = /^auth-sessions\.json/i;
// Directories whose whole content is credentials: key folders, Docker's and the
// GitHub/Google CLIs' token folders, and Electron apps' web storage.
const KEY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'gcloud', 'github cli',
  'local storage', 'session storage', 'chrome-debug-profile']);
// ~/.config/gh keeps GitHub CLI tokens in hosts.yml.
const KEY_DIR_PAIRS = new Set(['.config/gh']);
// Private-key and certificate files, protected only UNDER a key directory, so an
// ordinary project's certs/server.pem or a test fixture stays readable.
const KEY_FILE_EXT = /\.(pem|key|p12|pfx|ppk)$/i;

// Browser profile directories: cookies, saved passwords, session tokens.
function isBrowserProfile(lowerSegments) {
  const s = lowerSegments;
  for (let i = 0; i < s.length - 1; i += 1) {
    const pair = s[i] + '/' + s[i + 1];
    // Chrome and its Beta/Dev/Canary(SxS) channels, Edge's channels, Brave, Chromium, Vivaldi.
    if ((/^google\/chrome( beta| dev| sxs)?$/.test(pair) || /^microsoft\/edge( beta| dev| sxs)?$/.test(pair)
      || s[i] === 'bravesoftware' || s[i] === 'chromium' || s[i] === 'vivaldi')
      && s.slice(i + 1).includes('user data')) return true;
    if (pair === 'mozilla/firefox' && s[i + 2] === 'profiles') return true;
    if (s[i] === 'opera software') return true;
  }
  return false;
}

// Each segment with any NTFS stream suffix removed: Windows accepts
// "keys.json::$DATA" as another name for keys.json and ".ssh::$INDEX_ALLOCATION"
// for the .ssh folder, and fs.realpathSync hands both back unchanged (review,
// measured 2026-09-29: read_file returned a file's content through ::$DATA).
// The drive letter's own colon is the first segment's only legitimate one.
function segmentsOf(absPath) {
  const segs = path.resolve(String(absPath)).replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : s.split(':')[0]));
}

// { rule, detail } when absPath is protected, else null. `settingsDir` is the
// folder that holds MYTHOS's own config.json and auth-sessions.json (the vault's
// parent): its config.json can carry hand-written secrets (settings-store.js).
function protectedReason(absPath, opts) {
  const o = opts || {};
  const segs = segmentsOf(absPath);
  const lower = segs.map((s) => s.toLowerCase());
  const base = lower[lower.length - 1] || '';
  for (let i = 0; i < lower.length; i += 1) {
    const seg = lower[i];
    if (ENV_FILE.test(seg)) return { rule: 'env-file', detail: segs[i] };
    if (KEY_DIRS.has(seg)) return { rule: 'key-directory', detail: segs[i] };
    if (CREDENTIAL_FILES.has(seg)) return { rule: 'credential-file', detail: segs[i] };
    if (AUTH_SESSIONS.test(seg)) return { rule: 'auth-sessions', detail: segs[i] };
    if (i > 0 && KEY_DIR_PAIRS.has(lower[i - 1] + '/' + seg)) return { rule: 'key-directory', detail: segs[i - 1] + '/' + segs[i] };
  }
  if (KEY_FILE_EXT.test(base) && lower.some((s) => KEY_DIRS.has(s))) return { rule: 'private-key', detail: segs[segs.length - 1] };
  if (BROWSER_STORE_FILES.has(base)) return { rule: 'browser-profile', detail: segs[segs.length - 1] };
  if (isBrowserProfile(lower)) return { rule: 'browser-profile', detail: 'a browser profile folder' };
  if (o.settingsDir && base === 'config.json') {
    const dir = path.resolve(o.settingsDir).toLowerCase();
    if (path.dirname(path.resolve(absPath)).toLowerCase() === dir) return { rule: 'settings-file', detail: 'MYTHOS config.json' };
  }
  return null;
}

// The refusal text for an explicit request; names what to do instead
// (src/core/CLAUDE.md, Refusals). Deliberately never echoes file content.
function refusalFor(rawPath, hit) {
  return `Refusing to read "${rawPath}": it is protected (${hit.rule}: ${hit.detail}). `
    + 'Credential files, key folders and browser profiles are never read, listed or indexed by MYTHOS tools. '
    + 'If the operator needs a value from one, they can open it themselves.';
}

// Validated extra roots from identity's allowed_dirs (boundaries.md) or
// VOICE_ALLOWED_DIRS: absolute, not UNC, not a filesystem root, and not itself
// protected. Invalid entries are returned separately so they can be reported,
// never silently dropped.
function validateExtraRoots(entries, opts) {
  const ok = [];
  const rejected = [];
  for (const raw of entries || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (/^\\\\|^\/\//.test(s)) { rejected.push({ entry: s, reason: 'network path' }); continue; }
    if (!path.isAbsolute(s)) { rejected.push({ entry: s, reason: 'not an absolute path' }); continue; }
    const abs = path.resolve(s);
    if (path.parse(abs).root === abs || path.parse(abs).root.replace(/[\\/]$/, '') === abs) { rejected.push({ entry: s, reason: 'a whole drive' }); continue; }
    const hit = protectedReason(abs, opts);
    if (hit) { rejected.push({ entry: s, reason: `protected (${hit.rule})` }); continue; }
    ok.push(abs);
  }
  return { ok, rejected };
}

// The file tools' roots (B2d, revised after its independent review, 2026-09-29):
//   - mythos/ and the vault — the packaged app keeps the vault outside mythos/
//     (under %APPDATA%), and read_file("vault/x.md") returned an absolute path
//     that could not then be read back;
//   - the operator's content folders — Desktop, Documents, Downloads, Pictures,
//     Music, Videos, and their OneDrive copies — when VOICE_ALLOWED_DIRS is unset.
//     Until B2d the default was the WHOLE profile, AppData and every dot-folder
//     included; the tool descriptions' own examples ("open my downloads folder")
//     need these. VOICE_ALLOWED_DIRS, when set, replaces them;
//   - boundaries.md's allowed_dirs, added to either.
// Every extra root is validated; the rejected ones are returned, never dropped.
const CONTENT_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'];
function computeRoots(o) {
  const expand = (v) => String(v || '').trim().replace(/%USERPROFILE%/gi, o.homedir);
  const fromEnv = String(o.envValue || '').split(';').map(expand).filter(Boolean);
  const content = [];
  for (const base of [o.homedir, o.oneDrive].filter(Boolean)) {
    for (const name of CONTENT_FOLDERS) { const p = path.join(base, name); if (o.exists(p)) content.push(p); }
  }
  const checked = validateExtraRoots((fromEnv.length ? fromEnv : content).concat((o.identityDirs || []).map(expand).filter(Boolean)),
    { settingsDir: o.settingsDir });
  const roots = [o.mythosRoot];
  for (const r of [o.vaultRoot].concat(checked.ok)) if (r && !roots.includes(r)) roots.push(r);
  return { roots, rejected: checked.rejected };
}

// Is absPath the vault's Identity/boundaries.md, or a folder that holds it?
function touchesBoundaries(absPath, vaultRoot) {
  if (!vaultRoot) return false;
  const file = path.resolve(vaultRoot, 'Identity', 'boundaries.md').toLowerCase();
  const p = path.resolve(String(absPath)).toLowerCase();
  return p === file || file.startsWith(p.replace(/[\\/]+$/, '') + path.sep);
}

module.exports = { protectedReason, refusalFor, validateExtraRoots, isBrowserProfile, computeRoots, touchesBoundaries, CONTENT_FOLDERS };
