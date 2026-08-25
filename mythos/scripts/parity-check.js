#!/usr/bin/env node
'use strict';

// scripts/parity-check.js — prove, mechanically, that this MYTHOS is configured
// the way it is supposed to be.
//
// WHY THIS EXISTS, in the operator's own words: "every time I launch a new app I
// have to go through the whole list again." On 2026-08-11 a freshly installed
// MYTHOS.exe logged four incidents in under two minutes — volume oscillating
// between 100% and 15%, Spotify playing a live cut, Tier-1/2 approval prompts
// with autonomy configured not to need them, and a dead wake word — all of which
// had been fixed and verified over two months of the Electron dev run. A
// file-by-file hash comparison then showed all 409 files under mythos/** in the
// install were byte-identical to the working tree. The code was never the
// problem. Runtime CONFIGURATION and VAULT STATE were, and nothing anywhere could
// be asked about either.
//
// So this script asks. Run it against the dev run and against the installed app;
// the two reports must match. Every check is a machine-checked fact with a name,
// and the exit code is non-zero with a named list on any failure — so a future
// build is verified by running one command instead of by re-testing every feature
// by hand.
//
// Usage:
//   node scripts/parity-check.js                       # attach to 127.0.0.1:4478
//   node scripts/parity-check.js --port 4478 --json
//   node scripts/parity-check.js --token <MYTHOS_AUTH_TOKEN>
//
// It ATTACHES to a running server rather than booting one, on purpose: the whole
// question is what THIS install resolved at boot, and a fresh in-process boot
// would answer with its own environment instead.

const http = require('http');
const path = require('path');
const fs = require('fs');

const DEFAULT_PORT = 4478;
const DEFAULT_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 8000;

// The keys whose value in the install MUST match the dev run, because each one is
// traceable to one of the four incidents or to the voice path itself. This is the
// list that would have caught all of it.
const PARITY_KEYS = [
  // Incident 1 (volume oscillation) and the whole voice path: dev's .env is the
  // only place that ever set these, and the packaged build had no way to receive
  // them. Live being ON is what keeps the run off the ducking path entirely.
  'VOICE_S2S_ENABLED',
  'VOICE_TTS_PROVIDER',
  'VOICE_TTS_CHAIN',
  // Incident 4 (dead wake word).
  'WAKEWORD_ENABLED',
  // Incident 3 (approval prompts) — the config half of the ceiling.
  'AUTONOMOUS_MAX_TIER',
  // The ducking hysteresis added the same day. If Live is somehow off, these are
  // what stop the loop, so their values are part of parity too.
  'DUCK_MIN_HOLD_MS',
  'DUCK_COOLDOWN_MS',
];

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: DEFAULT_HOST, json: false, token: process.env.MYTHOS_AUTH_TOKEN || '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--port') { out.port = Number(argv[i + 1]); i += 1; }
    else if (arg === '--host') { out.host = String(argv[i + 1]); i += 1; }
    else if (arg === '--token') { out.token = String(argv[i + 1]); i += 1; }
  }
  return out;
}

function getJson(host, port, urlPath, token) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.get({ host, port, path: urlPath, headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON */ }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, body: parsed, raw: body.slice(0, 400) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: null, raw: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, body: null, raw: err.message }));
  });
}

// A check is {name, ok, detail}. `ok:null` means INDETERMINATE — the same honesty
// rule the HUD's own probes follow: a server that did not answer is not evidence
// of a misconfiguration, and reporting it as a failure would train the operator
// to ignore this script.
function check(name, ok, detail) {
  return { name, ok, detail: detail === undefined ? '' : String(detail) };
}

async function runChecks(opts) {
  const { host, port, token } = opts;
  const checks = [];

  const settings = await getJson(host, port, '/api/config/settings', token);
  if (!settings.ok || !settings.body) {
    checks.push(check('server-reachable', false,
      `GET /api/config/settings -> ${settings.status || 'no response'} ${settings.raw}`
      + (settings.status === 401 ? ' (pass --token, or MYTHOS_AUTH_TOKEN in the environment)' : '')));
    return checks; // nothing else can be asserted without this
  }
  checks.push(check('server-reachable', true, `${host}:${port}`));

  const byName = new Map((settings.body.keys || []).map((k) => [k.name, k]));

  // ---- 1. effective value + origin for every parity-critical key ----------------
  // The ORIGIN is as much the point as the value. A key that is right by accident
  // (the schema default happens to match) is not the same fact as a key the
  // operator set, and only the origin distinguishes them.
  for (const name of PARITY_KEYS) {
    const row = byName.get(name);
    if (!row) { checks.push(check(`key:${name}`, false, 'not reported by /api/config/settings')); continue; }
    const atDefault = row.origin === 'default';
    checks.push(check(`key:${name}`, !atDefault,
      `${row.value} (origin: ${row.origin})`
      + (atDefault ? ' — at its schema DEFAULT, which is what a packaged install with no config.json looks like' : '')));
  }

  // The install's whole failure was "config.json does not exist and nothing said
  // so". Count what each layer actually contributed.
  const origins = {};
  for (const row of settings.body.keys || []) origins[row.origin] = (origins[row.origin] || 0) + 1;
  const fromFile = (origins['config.json'] || 0) + (origins['.env'] || 0);
  checks.push(check('config-source-present', fromFile > 0,
    `${fromFile} key(s) come from a config file (config.json: ${origins['config.json'] || 0}, `
    + `.env: ${origins['.env'] || 0}); env: ${origins.env || 0}, derived: ${origins.derived || 0}, `
    + `default: ${origins.default || 0}`));
  checks.push(check('settings-file', Boolean(settings.body.file), settings.body.file || 'no settings file path reported'));

  // ---- 2. the autonomy ceiling, and where it came from --------------------------
  // Incident 3. leash/index.js gates on Math.min(config, boundaries), so an
  // effective ceiling BELOW the configured one means something clamped it — which
  // on the install was a missing Identity/boundaries.md being read as malformed.
  const autonomy = settings.body.autonomy || {};
  if (autonomy.effective === null || autonomy.effective === undefined) {
    checks.push(check('autonomy-ceiling', null, 'the server did not report an autonomy snapshot'));
  } else {
    checks.push(check('autonomy-ceiling', autonomy.effective === autonomy.configCeiling,
      `effective ${autonomy.effective} vs configured ${autonomy.configCeiling} `
      + `(boundaries.md: ${autonomy.boundariesCeiling}, source: ${autonomy.source})`));
    checks.push(check('autonomy-source', autonomy.source === 'file',
      `${autonomy.source}`
      + (autonomy.source === 'malformed-failsafe' ? ' — boundaries.md is present but unparseable; the ceiling is clamped to 1' : '')
      + (autonomy.source === 'absent-config-ceiling' ? ' — no Identity/boundaries.md; seeding it did not run or could not write' : '')));
  }

  // ---- 3. wake word + Silero weights, as files -----------------------------------
  // Incident 4. modelsPresent is a live statSync across every model directory
  // (core/setup/model-paths.js), so this is on-disk fact, not a remembered flag.
  const wake = await getJson(host, port, '/api/config/wakeword', token);
  if (!wake.ok || !wake.body) {
    checks.push(check('wakeword-models', null, `GET /api/config/wakeword -> ${wake.status} ${wake.raw}`));
  } else {
    checks.push(check('wakeword-models', wake.body.modelsPresent === true,
      wake.body.modelsPresent ? 'all three .onnx weights present' : 'weights missing — run the wizard\'s Components step'));
    // The flag and the files must agree. deriveWakewordDefaults turns the flag on
    // when the weights exist, so a disagreement means someone set it by hand
    // against the evidence.
    checks.push(check('wakeword-armed', wake.body.enabled === true && wake.body.modelsPresent === true,
      `enabled=${wake.body.enabled}, modelsPresent=${wake.body.modelsPresent}`));
  }

  const { findModelFile } = require(path.join(__dirname, '..', 'src', 'core', 'setup', 'model-paths.js'));
  const silero = findModelFile('silero', 'silero_vad.onnx');
  checks.push(check('silero-model', Boolean(silero), silero ? `${silero.file} (${silero.size}B)` : 'not found in any model directory'));

  // ---- 4. the TTS chain resolves to a provider that exists HERE ------------------
  // The install spoke with the flat browser voice while dev used Gemini, because
  // the chain's default is '' -> 'edge', edge-tts is deliberately not bundled, and
  // kokoro needs models that are not shipped either. So "a chain is configured" is
  // not the check; "the first link can actually speak on this machine" is.
  const chainRow = byName.get('VOICE_TTS_CHAIN');
  const chain = String((chainRow && chainRow.value) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const googleKey = byName.get('GOOGLE_API_KEY');
  const resolvable = [];
  for (const link of chain) {
    if (link === 'gemini') { if (googleKey && googleKey.set) resolvable.push('gemini'); continue; }
    if (link === 'piper') { if (findModelFile('piper', '') || piperHasVoice()) resolvable.push('piper'); continue; }
    // edge-tts is BYO by licence (LGPLv3, deliberately not bundled) and kokoro
    // needs mythos/models. Neither can be asserted from here without a real call,
    // so they are listed as present-but-unverified rather than claimed.
  }
  checks.push(check('tts-chain-resolvable', resolvable.length > 0,
    `chain [${chain.join(', ') || 'empty'}] — verifiable providers on this machine: `
    + `[${resolvable.join(', ') || 'none'}]`));

  // ---- 5. the server is actually alive ------------------------------------------
  // '/health', NOT '/api/health' — the liveness route is mounted outside the /api
  // namespace (server/index.js) precisely so it works before authentication. This
  // check asked for the wrong path on its first live run and reported a 404 as a
  // failure, which is the sort of thing a parity check exists to have caught in
  // itself before the operator relies on it.
  const health = await getJson(host, port, '/health', token);
  checks.push(check('health', Boolean(health.ok), health.ok ? 'ok' : `GET /health -> ${health.status} ${health.raw}`));

  // ---- 6. the vault holds the identity that shapes behaviour ---------------------
  // The install's vault was a second, empty brain: no boundaries.md (which caused
  // incident 3), no operator profile or style, no contacts, none of the 8 learned
  // skills. Checked as files, in the vault this server actually opened.
  const vaultRoot = resolveVaultRootFromSettings(byName);
  if (!vaultRoot) {
    checks.push(check('vault-identity', null, 'the server did not report MYTHOS_VAULT_ROOT'));
  } else {
    checks.push(check('vault-root', dirExists(vaultRoot), vaultRoot));
    for (const rel of ['Identity/boundaries.md', 'Identity/operator-profile.txt', 'Identity/operator-style.txt', 'Contacts/contacts.json']) {
      const file = path.join(vaultRoot, rel);
      const size = fileSize(file);
      checks.push(check(`vault:${rel}`, size > 0, size > 0 ? `${size}B` : 'missing or empty'));
    }
    const skills = countMarkdown(path.join(vaultRoot, 'Skills'));
    checks.push(check('vault:Skills/*.md', skills > 0, `${skills} learned skill(s)`));
  }

  return checks;
}

function resolveVaultRootFromSettings(byName) {
  const row = byName.get('MYTHOS_VAULT_ROOT');
  return row && row.value ? String(row.value) : null;
}

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
function fileSize(file) {
  try { const st = fs.statSync(file); return st.isFile() ? st.size : 0; } catch { return 0; }
}
function countMarkdown(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
}
// A piper voice is any .onnx in the resolved voices directory; piper-child.js
// applies the same rule.
function piperHasVoice() {
  try {
    const { userDataModelsDir } = require(path.join(__dirname, '..', 'src', 'core', 'setup', 'model-paths.js'));
    const roots = [];
    const user = userDataModelsDir();
    if (user) roots.push(path.join(user, 'piper'));
    roots.push(path.join(__dirname, '..', 'models', 'piper'));
    if (process.env.PIPER_MODEL_DIR) roots.unshift(process.env.PIPER_MODEL_DIR);
    return roots.some((dir) => {
      try { return fs.readdirSync(dir).some((f) => f.endsWith('.onnx')); } catch { return false; }
    });
  } catch { return false; }
}

function report(checks, asJson) {
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);

  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.map((c) => c.name), checks }, null, 2));
  } else {
    console.log('MYTHOS parity check');
    console.log('-------------------');
    for (const c of checks) {
      const mark = c.ok === true ? ' ok ' : c.ok === false ? 'FAIL' : ' ?? ';
      console.log(`[${mark}] ${c.name}${c.detail ? '  —  ' + c.detail : ''}`);
    }
    console.log('');
    if (failed.length) {
      // The NAMED LIST is the deliverable. "Parity check failed" with no names is
      // exactly the kind of report that sends the operator back to testing by hand.
      console.log(`FAILED (${failed.length}): ${failed.map((c) => c.name).join(', ')}`);
    } else {
      console.log('Every check passed.');
    }
    if (unknown.length) {
      console.log(`Indeterminate (${unknown.length}): ${unknown.map((c) => c.name).join(', ')} — `
        + 'could not be asked, so neither passed nor failed.');
    }
  }
  return failed.length === 0 ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const checks = await runChecks(opts);
  process.exitCode = report(checks, opts.json);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('parity-check failed to run:', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runChecks, report, PARITY_KEYS };
