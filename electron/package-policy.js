'use strict';

// electron/package-policy.js — the one declared list of files that must never
// be packaged, and the classifier every packaging consumer shares.
//
// Pure on purpose: no electron, no fs, no child_process. That is what lets the
// same rules be asserted three ways — against electron-builder's real matcher
// (package.json build.files), against Docker's ignore semantics
// (mythos/.dockerignore), and against a finished installer by
// mythos/scripts/verify-package-contents.js — without any of them booting
// anything. Tests: test/package-policy.test.js.
//
// WHY THIS EXISTS (2026-09-29 audit, B1). build.files excluded one secret file,
// the literal "!mythos/.env". The 2026-09-23 local build shipped four siblings
// of it — .env.bak-2026-08-15, .env.bak-2026-08-20T20-09-04-803Z,
// .env.bak-voicenodes, .env.pre-attended-2026-09-21.bak — plus test vaults,
// a pidfile and a scratch root, because electron-builder packages the working
// directory and a backup is not named ".env". A literal names history; these
// rules name the class.
//
// WHERE THE MEMBERS COME FROM. Each rule traces to something that writes that
// shape into the tree (the writer is named beside it). .gitignore was used only
// as a cross-check, never as the source: it is a list for a different tool with
// different semantics, and copying it would import its gaps.
//
// SCOPE, stated so nobody mistakes it for more:
//   - Names only. A secret pasted into an ordinary file (notes.txt) is not
//     detected here; nothing in this module reads content.
//   - Known-blind shapes, left out deliberately because nothing in this repo
//     writes them: "secrets.yaml", "*.pem", "*.key", ssh "id_*" keys (measured
//     2026-09-29: none in either node_modules tree or the tracked tree, so adding
//     them would also cost nothing). Add a rule when a writer appears.
//   - A backup that drops the name entirely ("env.txt", "keys-old.txt") is not
//     caught: the rules below match the NAME a copy keeps, not its content.
//   - Unknown scratch directories are not detected. A test that invents a new
//     "mythos/<something>/" temp root ships until a rule names it.

// Rules that apply to EVERY path segment at any depth — so an env-shaped
// directory takes its whole subtree with it. Applied everywhere, including
// electron/ and node_modules: measured 2026-09-29, no shipped dependency
// contains an env-shaped name (0 of 10,648 entries under mythos/node_modules and
// the root runtime deps), so the wider scope costs nothing and fails closed.
// Written as basename globs where "*" is the only wildcard.
//
// WIDENED 2026-09-29 after independent review. The first version named
// ".env", ".env.*", "*.env" and "*.env.*" — and so still shipped ".env~",
// ".env-old", ".env_backup", ".env (1)" and ".env - Copy", the shapes an editor
// or Windows Explorer makes when someone copies the file by hand, which is how
// all four real backups were made. Backups follow no fixed pattern; the one thing
// they keep is ".env" somewhere in the name. Measured the same day: across both
// node_modules trees no name contains ".env" at all, and in the tracked tree only
// mythos/.env.example does (forbidden on purpose; see the test's tracked-tree
// control). One glob, because "*" may be empty: "*.env*" is ".env" itself, every
// ".env<anything>" copy and every "<name>.env<anything>" export. A separate
// ".env*" rule would be a subset of it — a defence no test could ever see fail.
const ENV_NAME_RULES = Object.freeze([
  Object.freeze({ id: 'env', glob: '*.env*', writer: 'the operator (mythos/.env), every hand copy (.env.bak-*, .env~, ".env - Copy"), provider exports ("Nvidia NIM.env")' }),
  // CONTRIBUTING.md's signing gate points CSC_LINK at a .pfx/.p12 file, and the
  // natural place to drop one is the repo. 0 of either in node_modules or git.
  Object.freeze({ id: 'signing-cert-pfx', glob: '*.pfx', writer: 'a CSC_LINK code-signing certificate (CONTRIBUTING.md)' }),
  Object.freeze({ id: 'signing-cert-p12', glob: '*.p12', writer: 'a CSC_LINK code-signing certificate (CONTRIBUTING.md)' }),
]);

// The directory every app-root rule is relative to. Nested copies of these
// names (skills/<x>/config.json, node_modules/<pkg>/config.json) are allowed:
// they are code or package data, and the writers below only ever target the
// app root.
const APP_ROOT = 'mythos';

// The secret-bearing files here are globbed the same way, and for the same
// reason, as the env rules (widened 2026-09-29): "config.json.bak",
// "keys - Copy.json" and "mythos-settings (1).json" are copies of a file that
// settings-store.js says can hold hand-written secrets. None of the tracked
// files at the app root match these globs.
const APP_ROOT_RULES = Object.freeze([
  // settings-store.js: headless settings file is <vault>/../config.json
  Object.freeze({ id: 'root-config', glob: 'config*.json*', writer: 'src/core/config/settings-store.js (headless settings), and copies of it' }),
  // electron keystore; never written here today, listed because doctor.js looks for it
  Object.freeze({ id: 'root-keys', glob: 'keys*.json*', writer: 'electron keystore (userData); doctor.js candidate path' }),
  // src/main.js: auth-sessions.json beside the settings file (plus atomic-write temps)
  Object.freeze({ id: 'root-auth-sessions', glob: 'auth-sessions*.json*', writer: 'src/main.js authSessionsFile' }),
  // doctor.js --export default target
  Object.freeze({ id: 'root-settings-export', glob: 'mythos-settings*.json*', writer: 'scripts/doctor.js --export' }),
  // adapters/browser-agent: launched browser pid
  Object.freeze({ id: 'root-browser-pid', glob: '.browser-agent.pid', writer: 'adapters/browser-agent/index.js' }),
  // the operator's real vault
  Object.freeze({ id: 'root-vault', glob: 'vault', writer: 'the running app (real operator data)' }),
  // test/bug-019-audit-history.test.js, scripts/verify-*propose-goal.js
  Object.freeze({ id: 'root-test-vault', glob: 'vault_test_audit_*', writer: 'tests and verify scripts (fs-backed temp vaults)' }),
  // code-search.test.js, document-rag.test.js, ad-hoc .tmp-test
  Object.freeze({ id: 'root-scratch', glob: '.tmp-*', writer: 'tests that die mid-run leave scratch roots' }),
]);

// Deliberate exceptions. Ships EMPTY. An entry here must name the path, the
// reason it is safe, and who decided — a waiver nobody can see is a leak nobody
// can see.
const WAIVERS = Object.freeze({});

function globToRegExp(glob) {
  const body = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

const COMPILED_ENV = ENV_NAME_RULES.map((r) => ({ rule: r, re: globToRegExp(r.glob) }));
const COMPILED_ROOT = APP_ROOT_RULES.map((r) => ({ rule: r, re: globToRegExp(r.glob) }));

// Normalises to forward slashes and strips "./" and a leading "/". Returns null
// for anything that cannot be a path inside a package: empty, "..", a drive
// letter, a NUL. The caller treats null as forbidden — a path this module cannot
// read is refused, never waved through (a model that skips what it cannot parse
// fails open).
function normalizePackagedPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let p = rawPath.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '' || p.includes('\0') || /^[a-zA-Z]:/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments.join('/');
}

// classifyPackagedPath('mythos/.env.bak-x') ->
//   { forbidden: true, rule: 'env-dot', segment: '.env.bak-x', path: 'mythos/.env.bak-x' }
// classifyPackagedPath('mythos/src/main.js') -> { forbidden: false, path: 'mythos/src/main.js' }
// Case-folded: Windows file names are case-insensitive, so ".ENV.Bak" is the same
// file to the operator and must be the same answer here.
function classifyPackagedPath(rawPath) {
  const normalized = normalizePackagedPath(rawPath);
  if (normalized === null) {
    return { forbidden: true, rule: 'unnormalizable', segment: String(rawPath), path: String(rawPath) };
  }
  if (Object.prototype.hasOwnProperty.call(WAIVERS, normalized)) {
    return { forbidden: false, path: normalized, waived: true };
  }
  const segments = normalized.toLowerCase().split('/');
  for (const segment of segments) {
    for (const { rule, re } of COMPILED_ENV) {
      if (re.test(segment)) return { forbidden: true, rule: rule.id, segment, path: normalized };
    }
  }
  if (segments.length >= 2 && segments[0] === APP_ROOT) {
    for (const { rule, re } of COMPILED_ROOT) {
      if (re.test(segments[1])) return { forbidden: true, rule: rule.id, segment: segments[1], path: normalized };
    }
  }
  return { forbidden: false, path: normalized };
}

// minimatch and Go's filepath.Match are case-sensitive, and neither config
// format has a case-insensitive flag that electron-builder or Docker exposes. A
// character class per letter is the portable way to spell "any case".
function caseInsensitiveGlob(glob) {
  return glob.replace(/[a-zA-Z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

// The exact negations package.json build.files must END with. They go last
// because electron-builder's matcher is last-match-wins: a later positive
// pattern would re-include what these exclude. test/package-policy.test.js
// asserts the tail of build.files equals this list, in order.
function builderExclusionPatterns() {
  const out = [];
  for (const r of ENV_NAME_RULES) out.push(`!**/${caseInsensitiveGlob(r.glob)}{,/**/*}`);
  for (const r of APP_ROOT_RULES) out.push(`!${APP_ROOT}/${caseInsensitiveGlob(r.glob)}{,/**/*}`);
  return out;
}

// The block mythos/.dockerignore must carry. The Docker build context IS the
// app root (mythos/), so app-root rules lose their prefix and must NOT gain a
// "**/" — nested config.json is allowed there as it is in the installer. Env
// rules need "**/" explicitly: in .dockerignore ".env" matches only the context
// root, which is how a nested one would slip through.
function dockerIgnorePatterns() {
  const out = [];
  for (const r of ENV_NAME_RULES) out.push(`**/${caseInsensitiveGlob(r.glob)}`);
  for (const r of APP_ROOT_RULES) out.push(caseInsensitiveGlob(r.glob));
  return out;
}

module.exports = {
  APP_ROOT,
  ENV_NAME_RULES,
  APP_ROOT_RULES,
  WAIVERS,
  normalizePackagedPath,
  classifyPackagedPath,
  builderExclusionPatterns,
  dockerIgnorePatterns,
};
