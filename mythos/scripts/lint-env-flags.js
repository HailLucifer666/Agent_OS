#!/usr/bin/env node
'use strict';
/**
 * lint-env-flags.js — keep `.env.example` and the code's environment reads honest
 * in BOTH directions.
 *
 * WHY THIS EXISTS (Track E9 of the 2026-09-16 plan). Measured that day: names the
 * product reads had no line in `.env.example` (twelve of them config/schema.js
 * keys — DUCK_*, VISION_*_TIMEOUT_MS, DEEP_THINK_*_TIMEOUT_MS, TICK_WEDGED_MS,
 * LIVE_MEMORY_INJECT — plus the Electron shell's MYTHOS_AUTO_UPDATE and
 * friends), and AGENT_REACH_BIN had a documented line that nothing in any file
 * type read. A documented flag nobody reads is copied and trusted; an
 * undocumented one that is read is a feature nobody can find. Neither had a gate.
 *
 * WHAT COUNTS AS A READ — every form this repo actually uses, not only
 * `process.env.X`. The 2026-09-16 review caught a Node-only scan calling
 * EDGE_TTS_DEFAULT_VOICE dead while `services/edge-tts-server.py` read it, and
 * this script's own first draft skipped `mythos/providers/` and called 28
 * documented names dead that the providers read:
 *   - JS/Node:      process.env.X, process.env['X'], process.env["X"]
 *   - config:       every key of src/core/config/schema.js's SCHEMA (loadConfig
 *                   reads them by name), and env:/apiKeyEnv:/keyEnv: 'X' fields
 *                   in the lane, route and provider tables
 *   - Python:       os.environ['X'], os.environ.get('X'), os.getenv('X')
 *                   (services/*.py only — .venv is a dependency tree, not ours)
 *   - PowerShell:   $env:X in adapters and scripts
 *   - batch/cmd:    %X% at the repo root and under mythos/
 *   - shell:        $X / ${X} in .githooks and scripts/*.sh
 *
 * TWO POPULATIONS OF READER. Product code (src, server, adapters, providers,
 * services, electron) and harnesses (scripts/, the .bat launchers, .githooks).
 * A harness read COUNTS as a reader — a documented flag read only by
 * verify-*.js is alive — but a harness-only knob (VERIFY_DEBUG, AGG_DIR,
 * SYNC_TEST_COUNT_NO_STDIN) is not operator configuration and is never
 * "undocumented". Only a PRODUCT read with no `.env.example` line fails.
 *
 * TWO DIRECTIONS, TWO SEVERITIES.
 *   product read, undocumented -> FAIL, unless the name is in WAIVERS with a
 *                                 reason (OS variables, build-time metadata).
 *   documented but unread      -> a RATCHET: the count may shrink, never grow.
 *                                 The baseline is the number measured when
 *                                 this landed; each member is a delete-or-waive
 *                                 decision that deserves its own commit, not a
 *                                 gate red on arrival (the file-size ratchet's
 *                                 lesson). `--list-unread` prints them.
 *
 * Usage:
 *   node scripts/lint-env-flags.js               # report + exit code (docs:check)
 *   node scripts/lint-env-flags.js --json
 *   node scripts/lint-env-flags.js --list-unread
 * LINT_ENV_FLAGS_ENV_EXAMPLE=<path> points the scan at another example file —
 * the test seam that turns the gate red on purpose.
 */
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS = path.resolve(__dirname, '..');
const REPO = path.resolve(MYTHOS, '..');
const ENV_EXAMPLE = process.env.LINT_ENV_FLAGS_ENV_EXAMPLE || path.join(MYTHOS, '.env.example');

// Names product code reads that are NOT MYTHOS configuration. Each carries the
// reason it is exempt; an entry with no reason fails the run.
const WAIVERS = {
  HOME: 'OS-provided', USERPROFILE: 'OS-provided', LOCALAPPDATA: 'OS-provided', APPDATA: 'OS-provided',
  PROGRAMFILES: 'OS-provided', TEMP: 'OS-provided', TMP: 'OS-provided', PATH: 'OS-provided', WINDIR: 'OS-provided',
  XDG_STATE_HOME: 'freedesktop base-dir spec', XDG_CONFIG_HOME: 'freedesktop base-dir spec',
  XDG_DATA_HOME: 'freedesktop base-dir spec', XDG_CACHE_HOME: 'freedesktop base-dir spec',
  NODE_ENV: 'Node convention', NODE_TEST_CONTEXT: 'set by node --test', PORT: 'hosting-platform convention (Render)',
  RENDER: 'set by the Render platform', CI: 'set by CI runners', GITHUB_ACTIONS: 'set by CI runners',
  ELECTRON_RUN_AS_NODE: 'Electron runtime switch, not configuration',
  MYTHOS_APP_VERSION: 'build-time metadata stamped by electron-builder, never operator-set',
  MYTHOS_BUILD_TIME: 'build-time metadata stamped by electron-builder, never operator-set',
  MYTHOS_UPDATE_RESULT: 'written by the updater for the next boot to read, never operator-set',
  DEEPSEEK_API_KEY: 'dsh-agent route-table entry, consulted only if BRAIN_TABLES.build ranks a deepseek model — it does not (root CLAUDE.md: no DeepSeek key is required anywhere)',
  // Names MYTHOS SETS (or scrubs) in a child's environment. The scan sees
  // `env.X = ...` and `delete env.X` as references; they are writes, not config.
  DSH_HOME: 'set by dsh-agent for the dsh child (its project-local install), never read as MYTHOS config',
  DSH_TELEMETRY_DISABLED: 'set to 1 by dsh-agent for the dsh child so it never phones home',
  DSH_TELEMETRY_MODE: 'scrubbed from the dsh child env by dsh-agent',
  DSH_TELEMETRY_OTLP_URL: 'scrubbed from the dsh child env by dsh-agent',
  MYTHOS_PACKAGED: 'injected by electron/main.js into its server child (app.isPackaged), never operator-set',
  MYTHOS_SETTINGS_PATH: 'injected by electron/main.js into its server child; a headless run falls back to a file beside the vault',
  MYTHOS_MODELS_DIR: 'injected by electron/main.js into its server child as <userData>/models; headless derives it from the vault',
  MYTHOS_TEST_HATCH: 'test-only hatch (server/test-hatch.js), off unless exactly 1; never a shipped setting',
};

// The documented-but-unread ratchet. Measured when this gate landed; lower it
// as members are deleted or start being read. Never raise it.
const UNREAD_BASELINE = 0;

const SKIP_DIRS = new Set(['node_modules', '.venv', '.git', '.cache', 'vault', 'dist', 'DeepSeek Harness', 'test', 'coverage', 'models']);
function walk(dir, exts, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), exts, out); continue; }
    if (exts.some((x) => e.name.endsWith(x))) out.push(path.join(dir, e.name));
  }
  return out;
}
const read = (f) => fs.readFileSync(f, 'utf8');
const NAME = '[A-Z][A-Z0-9_]+';
const rel = (f) => path.relative(REPO, f).replace(/\\/g, '/');

function documentedNames(file) {
  const out = new Set();
  for (const line of read(file).split(/\r?\n/)) {
    const m = line.match(new RegExp('^#?\\s*(' + NAME + ')='));
    if (m) out.add(m[1]);
  }
  return out;
}

// Three of these came from measuring the first draft's "unread" list: kokoro's
// client reads an injected `env.KOKORO_MODEL_ID`, provider-cooldown reads
// `(env || process.env).WEB_SEARCH_DISABLED_PROVIDERS`, and every provider
// module names its override as `defaultModelEnv: 'GROQ_MODEL'`. Each looked
// dead to a process.env-only scan.
const JS_RES = [
  new RegExp('process\\.env\\.(' + NAME + ')', 'g'),
  new RegExp('process\\.env\\[[\'"](' + NAME + ')[\'"]\\]', 'g'),
  // `env.X`, and the one-letter alias kokoro/timeouts.js uses (`const e = env || process.env`).
  new RegExp('\\b(?:env|e)\\.(' + NAME + ')\\b', 'g'),
  new RegExp('\\(env \\|\\| process\\.env\\)\\.(' + NAME + ')\\b', 'g'),
  new RegExp('\\b(?:env|apiKeyEnv|keyEnv|tokenEnv|modelEnv|defaultModelEnv)\\s*:\\s*[\'"](' + NAME + ')[\'"]', 'g'),
];

function scan(files, res, into, site) {
  for (const f of files) {
    const text = read(f);
    for (const re of res) for (const m of text.matchAll(re)) if (!into.has(m[1])) into.set(m[1], site || rel(f));
  }
}

// -> { product: Map<name, site>, all: Map<name, site> }
function readNames() {
  const product = new Map();
  const all = new Map();
  const productJs = ['src', 'server', 'adapters', 'providers', 'services'].flatMap((d) => walk(path.join(MYTHOS, d), ['.js'], []))
    .concat(walk(path.join(REPO, 'electron'), ['.js'], []));
  scan(productJs, JS_RES, product);
  for (const key of Object.keys(require(path.join(MYTHOS, 'src', 'core', 'config', 'schema.js')).SCHEMA)) {
    if (!product.has(key)) product.set(key, 'mythos/src/core/config/schema.js');
  }
  scan(walk(path.join(MYTHOS, 'services'), ['.py'], []), [
    new RegExp('os\\.environ(?:\\.get)?\\(?\\[?[\'"](' + NAME + ')[\'"]', 'g'),
    new RegExp('os\\.getenv\\([\'"](' + NAME + ')[\'"]', 'g'),
  ], product);
  scan(walk(path.join(MYTHOS, 'adapters'), ['.ps1'], []), [new RegExp('\\$env:(' + NAME + ')', 'g')], product);

  for (const [k, v] of product) all.set(k, v);
  const harness = walk(path.join(MYTHOS, 'scripts'), ['.js'], []);
  scan(harness, JS_RES, all);
  scan(walk(path.join(MYTHOS, 'scripts'), ['.ps1'], []), [new RegExp('\\$env:(' + NAME + ')', 'g')], all);
  const bats = [REPO, MYTHOS].flatMap((d) => fs.readdirSync(d).filter((n) => /\.(bat|cmd)$/i.test(n)).map((n) => path.join(d, n)));
  scan(bats, [new RegExp('%(' + NAME + ')%', 'g')], all);
  const shells = walk(path.join(REPO, '.githooks'), [''], []).filter((f) => !f.endsWith('.sample'))
    .concat(walk(path.join(MYTHOS, 'scripts'), ['.sh'], []));
  scan(shells, [new RegExp('\\$\\{?(' + NAME + ')\\}?', 'g')], all);
  return { product, all };
}

function evaluate(envExampleFile) {
  const documented = documentedNames(envExampleFile);
  const { product, all } = readNames();
  const undocumented = [...product.keys()].filter((n) => !documented.has(n) && !WAIVERS[n]).sort()
    .map((n) => ({ name: n, site: product.get(n) }));
  const unread = [...documented].filter((n) => !all.has(n)).sort();
  const staleWaivers = Object.keys(WAIVERS).filter((n) => documented.has(n));
  const badWaivers = Object.entries(WAIVERS).filter(([, r]) => typeof r !== 'string' || !r.trim()).map(([n]) => n);
  return { documented: documented.size, productReads: product.size, allReads: all.size, undocumented, unread, staleWaivers, badWaivers, unreadBaseline: UNREAD_BASELINE };
}

function main() {
  const json = process.argv.includes('--json');
  const listUnread = process.argv.includes('--list-unread');
  const r = evaluate(ENV_EXAMPLE);
  const problems = [];
  if (r.badWaivers.length) problems.push('waivers without a reason: ' + r.badWaivers.join(', '));
  if (r.undocumented.length) problems.push('add a `# NAME=` line to mythos/.env.example for each name marked !, or a reasoned WAIVERS entry');
  if (r.unread.length > r.unreadBaseline) problems.push(`documented-but-unread grew ${r.unreadBaseline} -> ${r.unread.length}: a new .env.example line must be read by something (run --list-unread)`);
  if (r.unread.length < r.unreadBaseline - 3) problems.push(`documented-but-unread fell to ${r.unread.length}; lower UNREAD_BASELINE (${r.unreadBaseline}) so the ratchet holds at the new level`);
  if (r.staleWaivers.length) problems.push('stale waivers (now documented, delete them): ' + r.staleWaivers.join(', '));

  if (json) {
    console.log(JSON.stringify(Object.assign({}, r, { unread: listUnread ? r.unread : r.unread.length, problems }), null, 2));
  } else {
    console.log(`lint-env-flags: documented=${r.documented} product-reads=${r.productReads} all-reads=${r.allReads} undocumented=${r.undocumented.length} unread=${r.unread.length} (ratchet ${r.unreadBaseline})`);
    for (const u of r.undocumented) console.log(`  ! read by product code, not in .env.example: ${u.name}  (${u.site})`);
    if (listUnread) for (const n of r.unread) console.log(`  ~ documented but never read: ${n}`);
    for (const p of problems) console.error('lint-env-flags: ' + p);
    if (!problems.length) console.log('lint-env-flags: OK');
  }
  process.exit(problems.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { evaluate, documentedNames, readNames, WAIVERS, UNREAD_BASELINE };
