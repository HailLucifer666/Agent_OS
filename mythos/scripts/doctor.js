'use strict';

// scripts/doctor.js — "why is this machine not the same as the other one?"
//
// A fresh install, or a second machine, reaches parity with the first only if
// somebody remembers every key, every downloaded model and every optional
// binary. Nothing reported that list, so a half-wired install looked identical
// to a working one until a specific feature silently used its fallback: the
// wrong voice, no Gemini, a tool that quietly does nothing.
//
// This prints that list, honestly, and names the exact command that closes each
// gap. It is a READ-ONLY report: it never downloads, never writes a key, never
// starts a subsystem. Two deliberate consequences of that:
//
//   - It reports CONFIGURATION, not liveness. "GOOGLE_API_KEY present" does not
//     mean the key is valid or in quota — gemini-tts can be perfectly
//     configured and still 429 on a free tier. Liveness belongs to the
//     verify-*.js scripts, which make real calls.
//   - It cannot see keys stored in the Electron key store's encrypted values,
//     only their NAMES (AD-8: values never leave the main process). A key set
//     through the desktop setup screen therefore shows as present-by-name, and
//     that is the strongest honest claim available here.
//
// Usage:
//   node scripts/doctor.js                  full report
//   node scripts/doctor.js --strict         exit 1 if any REQUIRED gap remains (CI)
//   node scripts/doctor.js --json           machine-readable, for the HUD
//   node scripts/doctor.js --export [file]  write this machine's non-secret settings
//   node scripts/doctor.js --compare <file> diff those settings against another machine

const fs = require('fs');
const path = require('path');
const os = require('os');

const MYTHOS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');

// Single source of truth for the downloaded assets: require the installers that
// put them there rather than restating their filenames, so a changed asset list
// cannot silently drift out of this report. Both files guard on
// `require.main === module`, so requiring them installs nothing.
const silero = require('./setup-silero.js');
const wakeword = require('./setup-wakeword.js');
const android = require('./setup-android.js');

// ---- environment ------------------------------------------------------------
// Same convention as src/main.js: .env is loaded into process.env, and a real
// environment variable wins over the file. Missing .env is not an error — a
// Docker/CI install legitimately has none.
function loadEnv(dir) {
  const envPath = path.join(dir || MYTHOS_DIR, '.env');
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath };
  try {
    process.loadEnvFile(envPath);
    return { loaded: true, path: envPath };
  } catch (err) {
    return { loaded: false, path: envPath, error: err.message };
  }
}

function envPresent(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

// Names only — never a value, not even a length or a prefix. This function
// exists so a future edit has to work at it to leak one.
function keyStoreNames() {
  // The Electron key store lives in app.getPath('userData'), which is
  // %APPDATA%/<productName> on Windows and the platform equivalent elsewhere.
  // Resolved from the environment (never a hardcoded user path) and treated as
  // absent rather than fatal when it is not there, because a headless install
  // has no Electron store at all.
  // TWO product names, both real: Electron names userData after build.productName
  // ("MYTHOS") in a packaged build, and after package.json's `name` ("agent-os")
  // in an unpackaged dev run. Checking only one silently reports "no key store"
  // on whichever install the operator is actually using.
  const products = ['MYTHOS', 'agent-os'];
  const candidates = [];
  for (const product of products) {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, product, 'keys.json'));
    if (process.env.XDG_CONFIG_HOME) candidates.push(path.join(process.env.XDG_CONFIG_HOME, product, 'keys.json'));
    candidates.push(path.join(os.homedir(), '.config', product, 'keys.json'));
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', product, 'keys.json'));
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      return { file, names: Object.keys(parsed) };
    } catch { /* corrupt or unreadable — treated as absent, same as loadStore() */ }
  }
  return { file: null, names: [] };
}

// ---- the requirement tables -------------------------------------------------
// `anyOf` means the subsystem needs at least one of these keys, not all. Every
// row cites where the requirement actually comes from, so a stale row is
// falsifiable by reading that file.
const KEY_CHECKS = [
  {
    id: 'brain',
    label: 'Brain (any LLM lane)',
    required: true,
    anyOf: ['GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY',
      'MISTRAL_API_KEY', 'NIM_API_KEY', 'ZCODE_API_KEY'],
    why: 'every lane in src/core/brain/registry.js is gated on one of these',
    fix: 'add at least one provider key to mythos/.env (see mythos/.env.example)',
  },
  {
    id: 'live-voice',
    label: 'Gemini Live (S2S voice)',
    required: true,
    anyOf: ['GOOGLE_API_KEY'],
    why: 'VOICE_S2S_ENABLED opens a Gemini Live session; server/index.js returns null without this key',
    fix: 'set GOOGLE_API_KEY in mythos/.env — without it S2S never opens and the TTS chain speaks instead',
  },
  {
    id: 'stt',
    label: 'Speech-to-text (Groq Whisper)',
    required: false,
    anyOf: ['GROQ_API_KEY'],
    why: 'the groq STT provider needs it; the browser recognizer still works without',
    fix: 'set GROQ_API_KEY in mythos/.env for server-side STT',
  },
  {
    id: 'google-oauth',
    label: 'Gmail / Calendar sensors',
    required: false,
    allOf: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    why: 'the gmail and calendar sensors need a real OAuth grant, not an API key',
    fix: 'node scripts/google-auth.js  (all three values land in mythos/.env)',
  },
  {
    id: 'auth-token',
    label: 'MYTHOS_AUTH_TOKEN',
    required: false,
    anyOf: ['MYTHOS_AUTH_TOKEN'],
    why: 'MANDATORY when MYTHOS_BIND is not loopback (the phone node needs that); a loopback-only install needs none',
    fix: 'set MYTHOS_AUTH_TOKEN in mythos/.env to a long random string — required before a phone node can connect',
  },
];

// ---- asset / binary checks --------------------------------------------------
function fileAtLeast(file, minBytes) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size >= (minBytes || 1);
  } catch { return false; }
}

function assetChecks() {
  const wakewordDir = path.join(MYTHOS_DIR, 'ui', 'public', 'models', 'wakeword');
  const missingWakeword = wakeword.REQUIRED_ASSETS
    .filter((name) => !fileAtLeast(path.join(wakewordDir, name), 100 * 1024));

  const piperDir = process.env.PIPER_MODEL_DIR || path.join(MYTHOS_DIR, 'models', 'piper');
  let piperVoices = [];
  try {
    piperVoices = fs.readdirSync(piperDir).filter((f) => f.endsWith('.onnx'));
  } catch { /* absent dir — reported as a gap below */ }

  // setup-hermes.js has no export guard, so requiring it would RUN the
  // installer. The path is restated here from that file's binaryPath() instead,
  // deliberately and with the citation.
  const hermesBin = process.platform === 'win32'
    ? path.join(REPO_ROOT, 'Hermes Agent', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
    : path.join(REPO_ROOT, 'Hermes Agent', 'hermes-agent', 'venv', 'bin', 'hermes');

  return [
    {
      id: 'silero',
      label: 'Silero VAD model',
      required: false,
      ok: fileAtLeast(path.join(silero.OUT_DIR, silero.OUT_FILE), silero.MIN_BYTES),
      why: 'voice activity detection in the HUD',
      fix: 'node scripts/setup-silero.js',
    },
    {
      id: 'wakeword',
      label: 'openWakeWord models',
      required: false,
      ok: missingWakeword.length === 0,
      detail: missingWakeword.length ? `missing: ${missingWakeword.join(', ')}` : null,
      why: 'WAKEWORD_ENABLED cannot arm without all three .onnx assets',
      fix: 'node scripts/setup-wakeword.js',
    },
    {
      id: 'piper',
      label: 'Piper voices (offline TTS fallback)',
      required: false,
      ok: piperVoices.length > 0,
      detail: piperVoices.length ? `${piperVoices.length} voice(s) in ${piperDir}` : `no .onnx voices in ${piperDir}`,
      why: 'the last link of VOICE_TTS_CHAIN; without it a network failure means no speech at all',
      // setup-piper.js genuinely exists as of 2026-08-11 (it did not for months,
      // which is why this row used to spell out that the advertised command was
      // fictional). Verified by pointing at the file, not by memory.
      fix: 'node scripts/setup-piper.js --install   (installs into ' + piperDir + ')',
    },
    {
      id: 'hermes',
      label: 'Hermes-Agent (build engine)',
      required: false,
      ok: fileAtLeast(hermesBin, 1),
      detail: hermesBin,
      why: 'the only build-content engine — builds FAIL without it (boot still succeeds)',
      fix: 'node scripts/setup-hermes.js --install',
    },
    {
      id: 'adb',
      label: 'Android platform-tools (adb)',
      required: false,
      ok: fileAtLeast(android.resolveAdbPath(), 1),
      detail: android.resolveAdbPath(),
      why: 'every phone_* effector shells out to adb',
      fix: 'node scripts/setup-android.js --install',
    },
    {
      id: 'pc-child',
      label: 'pc-child automation script',
      required: true,
      ok: fileAtLeast(path.join(MYTHOS_DIR, 'adapters', 'pc-child', 'ps-automation.ps1'), 1),
      why: 'desktop control (typing, clicking, window management) runs through it',
      fix: 'reinstall/repair the checkout — this file is tracked, so an absent one means a broken clone',
    },
  ];
}

// ---- non-secret settings, for machine-to-machine parity ---------------------
// Only settings, never secrets. The whole point is that this file can be copied
// between machines (or pasted into a chat) without leaking anything, so the list
// is an allowlist of names and nothing here reads a key's value.
const PARITY_SETTINGS = [
  'VOICE_S2S_ENABLED', 'VOICE_UNIFIED_LIVE_VOICE', 'VOICE_TTS_PROVIDER', 'VOICE_TTS_CHAIN',
  // The voice-IDENTITY keys. These belong here for a specific operator
  // requirement: the entity must sound like the same person on the laptop, the
  // PC and the phone. providers/tts.js already makes that true within one
  // machine (a matched set of defaults, VOICE_UNIFIED_LIVE_VOICE routing
  // greeting/typed/spoken through one Live session, and
  // voice-identity-consistent.test.js as the gate) — but nothing could tell you
  // whether the OTHER machine agreed, and a single differing value there is a
  // different person answering. The phone needs no entry: it plays
  // server-synthesized audio and has no TTS of its own, so it inherits whichever
  // engine answered.
  'GEMINI_LIVE_VOICE', 'VOICE_TTS_VOICE', 'PIPER_VOICE', 'KOKORO_VOICE', 'GEMINI_TTS_MODEL',
  'VOICE_STT_CHAIN', 'VOICE_STT_PROVIDER', 'WAKEWORD_ENABLED', 'WAKEWORD_THRESHOLD',
  'AETHER_ENABLED', 'AETHER_NODE_AUDIO', 'AETHER_NODE_IDS', 'AETHER_NODE_TRUST',
  'MYTHOS_PORT', 'MYTHOS_BIND', 'MYTHOS_NAME', 'BOOT_GREETING',
  'BRAIN_LANE_VOICE', 'BRAIN_LANE_CODE', 'PIPER_MODEL_DIR', 'EDGE_TTS_PORT',
];

// Which voice each engine would actually use, resolved through production's OWN
// voiceFor() rather than a copy of its rules — a copy is how "the report says they
// match" and "they match" drift apart. Reported as plain data: doctor cannot hear,
// so it never claims two voices SOUND alike, only which ids are in play and which
// engine is first in the chain.
//
// The point of printing this at all is cross-machine: run it on both, and a
// different id anywhere is a different person answering on that machine.
function voiceIdentity() {
  let voiceFor;
  try {
    ({ voiceFor } = require(path.join(MYTHOS_DIR, 'providers', 'tts.js')));
  } catch (err) {
    return { error: `could not load the TTS chain: ${err.message}`, rows: [] };
  }
  // Schema defaults UNDER env overrides, which is the layering production uses.
  // Reporting env-only would print "(engine default)" for any voice the operator
  // has not explicitly set — understating the answer for exactly the keys that
  // matter here, since the matched-set defaults ARE the mechanism (edge-tts's
  // en-US-AvaNeural was chosen to sit beside Gemini's Aoede, not left to chance).
  const cfg = {};
  try {
    const { SCHEMA } = require(path.join(MYTHOS_DIR, 'src', 'core', 'config', 'schema.js'));
    for (const key of ['GEMINI_LIVE_VOICE', 'VOICE_TTS_VOICE', 'PIPER_VOICE', 'KOKORO_VOICE']) {
      if (SCHEMA[key] && SCHEMA[key].default !== undefined) cfg[key] = SCHEMA[key].default;
      if (envPresent(key)) cfg[key] = String(process.env[key]);
    }
  } catch { /* schema unreadable — fall back to voiceFor's own env chain */ }
  const engines = [
    { name: 'gemini-tts', label: 'Gemini (Live + TTS)' },
    { name: 'edge-tts', label: 'edge-tts (fallback)' },
    { name: 'piper-tts', label: 'piper (offline fallback)' },
    { name: 'kokoro-tts', label: 'kokoro (fallback)' },
  ];
  const rows = engines.map((e) => ({
    engine: e.label,
    voice: voiceFor({ name: e.name }, cfg) || '(engine default)',
  }));
  const chain = String(process.env.VOICE_TTS_CHAIN || process.env.VOICE_TTS_PROVIDER || 'edge')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { error: null, rows, chain, unified: process.env.VOICE_UNIFIED_LIVE_VOICE !== 'false' };
}

function collectSettings() {
  const out = {};
  for (const name of PARITY_SETTINGS) {
    if (envPresent(name)) out[name] = String(process.env[name]);
  }
  return out;
}

function compareSettings(mine, theirs) {
  const names = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort();
  const rows = [];
  for (const name of names) {
    const a = Object.prototype.hasOwnProperty.call(mine, name) ? mine[name] : null;
    const b = Object.prototype.hasOwnProperty.call(theirs, name) ? theirs[name] : null;
    if (a === b) continue;
    rows.push({ name, here: a, there: b });
  }
  return rows;
}

// ---- report assembly --------------------------------------------------------
function evaluateKeyChecks() {
  return KEY_CHECKS.map((check) => {
    const names = check.anyOf || check.allOf || [];
    const present = names.filter(envPresent);
    const ok = check.allOf ? present.length === names.length : present.length > 0;
    const missing = names.filter((n) => !envPresent(n));
    return {
      id: check.id,
      label: check.label,
      required: check.required,
      ok,
      // Names of what IS configured. Safe by construction: names, never values.
      detail: ok
        ? `configured: ${present.join(', ')}`
        : (check.allOf ? `missing: ${missing.join(', ')}` : `none of: ${names.join(', ')}`),
      why: check.why,
      fix: check.fix,
      // The requirement's key names, structured. `detail` above is prose for a
      // human terminal; the setup screen needs the list itself, and used to
      // recover it by regexing that prose — so a reworded sentence produced a
      // key row with no input box and no way to fix the gap it was reporting.
      // Names only: this whole file is forbidden from touching a value (AD-8),
      // and test/setup-route.test.js pins that a planted canary cannot appear.
      keyNames: names.slice(),
    };
  });
}

function buildReport(envDir) {
  const env = loadEnv(envDir);
  const store = keyStoreNames();
  const keys = evaluateKeyChecks();
  const assets = assetChecks();
  const gaps = [...keys, ...assets].filter((r) => !r.ok);
  return {
    envFile: env,
    keyStore: store,
    keys,
    assets,
    settings: collectSettings(),
    voice: voiceIdentity(),
    gaps,
    requiredGaps: gaps.filter((g) => g.required),
  };
}

// ---- printing ---------------------------------------------------------------
const PAD = 38;

function mark(row) {
  if (row.ok) return 'OK   ';
  return row.required ? 'GAP! ' : 'gap  ';
}

function printSection(title, rows) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
  for (const row of rows) {
    console.log(`  ${mark(row)} ${row.label.padEnd(PAD)} ${row.detail || ''}`);
    if (!row.ok) {
      console.log(`         why: ${row.why}`);
      console.log(`         fix: ${row.fix}`);
    }
  }
}

function printReport(report) {
  console.log('MYTHOS doctor — configuration report (not a liveness check)');
  console.log(`  env file: ${report.envFile.loaded ? report.envFile.path : `NOT LOADED (${report.envFile.path})`}`);
  console.log(`  desktop key store: ${report.keyStore.file
    ? `${report.keyStore.names.length} key name(s) — ${report.keyStore.file}`
    : 'none found (headless install, or no key set through the setup screen yet)'}`);

  printSection('Keys', report.keys);
  printSection('Models and binaries', report.assets);

  console.log('');
  console.log('Voice identity (must be identical on every machine)');
  console.log('--------------------------------------------------');
  if (report.voice.error) {
    console.log(`  ${report.voice.error}`);
  } else {
    console.log(`  chain order: ${report.voice.chain.join(' -> ')}`);
    console.log(`  unified Live voice: ${report.voice.unified ? 'on — greeting, typed and spoken all use the Live session' : 'OFF — the greeting and typed replies use the TTS chain instead, which is a different engine'}`);
    for (const row of report.voice.rows) console.log(`  ${row.engine.padEnd(28)} ${row.voice}`);
    console.log('  The phone has no TTS of its own — it plays whatever the server synthesized,');
    console.log('  so it matches by construction. A DIFFERENT id here than on the other machine');
    console.log('  is a different person answering there.');
  }

  console.log('');
  console.log('Non-secret settings on this machine');
  console.log('-----------------------------------');
  const names = Object.keys(report.settings);
  if (!names.length) console.log('  (none of the tracked settings are set — everything is on its schema default)');
  for (const name of names) console.log(`  ${name.padEnd(PAD)} ${report.settings[name]}`);

  console.log('');
  if (!report.gaps.length) {
    console.log('No gaps. Every tracked key, model and binary is present.');
  } else {
    console.log(`${report.gaps.length} gap(s), ${report.requiredGaps.length} of them required:`);
    for (const g of report.gaps) console.log(`  ${g.required ? 'REQUIRED' : 'optional'}  ${g.label} -> ${g.fix}`);
  }
  console.log('');
  console.log('Reminder: this reports what is CONFIGURED. A present key can still be');
  console.log('invalid or out of quota — use the verify-*.js scripts for real calls.');
}

// ---- cli --------------------------------------------------------------------
// opts.envDir points the .env load somewhere other than mythos/ — the only
// reason it exists is that a test cannot otherwise isolate itself: this machine's
// real .env is loaded into process.env by every run, so a test that clears a key
// gets it straight back and every gap silently reads as configured. Production
// never passes it.
function main(argv, opts) {
  const envDir = (opts && opts.envDir) || MYTHOS_DIR;
  const wantsJson = argv.includes('--json');
  const strict = argv.includes('--strict');
  const exportIdx = argv.indexOf('--export');
  const compareIdx = argv.indexOf('--compare');

  if (compareIdx !== -1) {
    const file = argv[compareIdx + 1];
    if (!file) {
      console.error('--compare needs a file written by --export');
      return 2;
    }
    loadEnv(envDir);
    let theirs;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      theirs = parsed && parsed.settings ? parsed.settings : parsed;
    } catch (err) {
      console.error(`--compare could not read ${file}: ${err.message}`);
      return 2;
    }
    const mine = collectSettings();
    const rows = compareSettings(mine, theirs);
    if (!rows.length) {
      console.log('Settings match. Every tracked non-secret setting is identical on both machines.');
      return 0;
    }
    console.log(`${rows.length} setting(s) differ (here = this machine, there = ${path.basename(file)}):`);
    for (const r of rows) {
      console.log(`  ${r.name.padEnd(PAD)} here=${r.here === null ? '(unset)' : r.here}  there=${r.there === null ? '(unset)' : r.there}`);
    }
    // A difference is information, not a failure: the machines are allowed to
    // differ deliberately (a laptop with no phone node, say). Only --strict
    // treats it as one.
    return strict ? 1 : 0;
  }

  const report = buildReport(envDir);

  if (exportIdx !== -1) {
    const file = argv[exportIdx + 1] || path.join(MYTHOS_DIR, 'mythos-settings.json');
    const payload = { exportedFrom: os.hostname(), platform: process.platform, settings: report.settings };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${Object.keys(report.settings).length} non-secret setting(s) to ${file}`);
    console.log('No secrets are included — this file is safe to copy to the other machine.');
    return 0;
  }

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  return strict && report.requiredGaps.length ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  KEY_CHECKS,
  PARITY_SETTINGS,
  loadEnv,
  envPresent,
  keyStoreNames,
  assetChecks,
  evaluateKeyChecks,
  collectSettings,
  compareSettings,
  buildReport,
  main,
};
