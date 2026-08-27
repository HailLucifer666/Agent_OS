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
const dsh = require('./setup-dsh.js');
const { findModelFile, userDataModelsDir } = require('../src/core/setup/model-paths');
// The kokoro PROVIDER, not a path literal — see the kokoro row in assetChecks().
// Requiring it is inert: every heavy import inside it is a dynamic import()
// reached only from loadModel().
const kokoro = require('../providers/kokoro-tts.js');

// Does this directory hold at least one .onnx voice? Mirrors piper-child.js's own
// test so the two never disagree about "installed".
function dirHasOnnx(dir) {
  try { return fs.readdirSync(dir).some((f) => f.endsWith('.onnx')); } catch { return false; }
}

// treeHasOnnx — dirHasOnnx one level down is not enough for a HuggingFace cache.
// @huggingface/transformers writes weights to
// <cacheDir>/models--<org>--<repo>/... , so the cache directory itself contains
// only directories and a bare existsSync() on it would report a MODEL for a
// folder holding nothing but an aborted download's scaffolding. That is the
// failure this whole row exists to stop, so it is measured rather than assumed.
function treeHasOnnx(dir, maxDepth) {
  const limit = typeof maxDepth === 'number' ? maxDepth : 4;
  let frontier = [[dir, 0]];
  while (frontier.length) {
    const next = [];
    for (const [d, depth] of frontier) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.onnx')) return true;
        if (e.isDirectory() && depth + 1 <= limit) next.push([path.join(d, e.name), depth + 1]);
      }
    }
    frontier = next;
  }
  return false;
}

// whichOnPath(cmd) — a PATH lookup done with the filesystem, never a spawn.
// doctor's closing line promises it reports what is CONFIGURED and points at the
// verify-*.js harnesses for real calls, so resolving `adb` must not execute it.
function whichOnPath(cmd) {
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* next */ }
    }
  }
  return null;
}

// adbReachable(bin) — BUG-374. Given the path the RUNTIME will use, can it be
// used? This is a separate question from "where would adb be", and conflating
// them is what let BUG-360 survive a fix.
//
// It matters because `resolveAdbBin()` returns an explicit `ANDROID_ADB_BIN`
// WITHOUT checking that it exists — correctly, since an override is an
// instruction, not a guess. Nothing downstream checked either, so doctor is the
// one that has to.
function adbReachable(bin) {
  if (!bin) return { ok: false, why: 'no adb path resolved at all' };
  if (bin === android.DEFAULT_ADB_BIN) {
    const hit = whichOnPath(bin);
    return hit
      ? { ok: true, why: 'on PATH: ' + hit }
      : { ok: false, why: "resolved to bare 'adb' and there is no adb on PATH" };
  }
  try {
    if (fs.statSync(bin).isFile()) return { ok: true, why: bin };
    return { ok: false, why: 'not a file: ' + bin };
  } catch (_) {
    return { ok: false, why: 'ANDROID_ADB_BIN names a path that does not exist: ' + bin };
  }
}

// ttsChain(env) — parsed in ONE place. It was read inline in the voice section
// only; the kokoro asset row below needs the same answer, and two parses of one
// setting is how a report starts disagreeing with itself.
function ttsChain(env) {
  const e = env || process.env;
  return String(e.VOICE_TTS_CHAIN || e.VOICE_TTS_PROVIDER || 'edge')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

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
  // THREE product names, all real on a machine with any history. Checking only
  // one silently reports "no key store" on whichever install the operator is
  // actually using.
  //
  // CORRECTED 2026-08-11 (installer parity): this used to say userData is
  // "MYTHOS in a packaged build and agent-os in an unpackaged dev run", which is
  // backwards and misses a third directory. electron/main.js never called
  // app.setName, so Electron used package.json's `name` ("agent-os") for the
  // PACKAGED app and the literal "Electron" for a dev run out of node_modules,
  // while build.productName ("MYTHOS") is only what NSIS wrote to. main.js now
  // pins app.setName('MYTHOS'), so new runs of both use the first name here; the
  // other two remain because existing machines still hold keys under them.
  const products = ['MYTHOS', 'agent-os', 'Electron'];
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
    // BUG-387. PRESENCE IS NOT VALIDITY, and this row used to imply it was.
    //
    // Measured 2026-08-28: this printed `OK  configured: GOOGLE_CLIENT_ID,
    // GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN` while the vault held 88
    // invalid_grant failures across 60 separate bursts over three weeks, every
    // one of them saying the refresh token was expired or revoked. The single
    // check an operator runs to answer "is my Gmail set up?" was answering YES
    // about the exact thing that was broken — an existence check standing in for
    // a correlation check. For an OAuth refresh token the two come apart
    // permanently and silently: Google revokes the grant, the string stays in
    // the file forever.
    //
    // THE CHECK CANNOT LIVE HERE, for two reasons this file already states.
    // evaluateKeyChecks handles key NAMES and is forbidden from touching a VALUE
    // (AD-8; setup-route.test.js plants a canary to keep it that way), and
    // asking Google requires sending the refresh token. And main() is
    // synchronous, while that is a network round trip. So the row keeps doing
    // the check it is good at and stops claiming the one it never made.
    //
    // Deliberately still not a red row: the keys ARE configured and that is what
    // was asked. A report that goes red for an expected reason is a report
    // people stop reading — the same reasoning as the kokoro row above.
    id: 'google-oauth',
    label: 'Gmail / Calendar sensors',
    required: false,
    allOf: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    detailSuffix: ' — present, but validity NOT checked here: run `node scripts/verify-google-grant.js`',
    why: 'the gmail and calendar sensors need a real OAuth grant, not an API key — and a revoked grant looks identical to a working one from here',
    fix: 'node scripts/google-auth.js  (all three values land in mythos/.env). To find out whether the grant is actually alive: node scripts/verify-google-grant.js',
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
  // Installer parity (2026-08-11): search EVERY model directory, not just the
  // install tree. The downloaders now write to a userData-scoped directory
  // (mythos/ui/public/models is excluded from build.files and is replaced by
  // every update), so a hardcoded install-tree path would report "missing" on
  // exactly the machine that just installed the models — and this report is what
  // the wizard's Components step trusts to decide whether an install worked.
  // See src/core/setup/model-paths.js.
  const missingWakeword = wakeword.REQUIRED_ASSETS
    .filter((name) => !findModelFile('wakeword', name));

  const userModels = userDataModelsDir();
  const legacyPiperDir = path.join(MYTHOS_DIR, 'models', 'piper');
  // Same order piper-child.js's defaultModelDir() applies, so doctor and the
  // runtime can never disagree about where the voices are.
  const piperDir = process.env.PIPER_MODEL_DIR
    || (userModels && dirHasOnnx(path.join(userModels, 'piper')) ? path.join(userModels, 'piper') : legacyPiperDir);
  let piperVoices = [];
  try {
    piperVoices = fs.readdirSync(piperDir).filter((f) => f.endsWith('.onnx'));
  } catch { /* absent dir — reported as a gap below */ }

  // setup-dsh.js has a require.main guard and exports its own path resolution,
  // so this asks it rather than restating one hardcoded path.
  //
  // That restatement was a real defect under Hermes, not just duplication: it
  // named ONLY <repo>/Hermes Agent, so on a packaged install — where the repo is
  // inside the install tree an update deletes — the engine read as missing after
  // every update and the wizard re-offered an install the operator had already
  // done. Both sides search userData/tools (MYTHOS_TOOLS_DIR) first and the repo
  // second, and setup-dsh.js keeps that rule.
  const dshFound = dsh.findInstalled();

  // BUG-374: resolve adb the way the RUNTIME resolves it — explicit override
  // first — then ask whether that resolution is usable. `findInstalledAdb()`
  // alone answers a different question and cannot see the override.
  const adbRuntimeBin = android.resolveAdbBin(null, process.env);
  const adbReach = adbReachable(adbRuntimeBin);

  // Ask the provider where it reads from. Recomputing this path here is the
  // BUG-360 defect with a different noun — see the kokoro row below.
  const kokoroDir = kokoro.modelCacheDir();
  const kokoroInChain = ttsChain().includes('kokoro');
  const kokoroModelPresent = treeHasOnnx(kokoroDir);

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
      // BUG-240. This report said "No gaps" on a machine where mythos/models/
      // holds only piper and whisper, because the voice section printed the
      // kokoro VOICE ID (af_heart) and nothing ever asked about the kokoro
      // MODEL. A voice id is a string in .env; it is present whether or not
      // any weights exist, so it can never be a gap and reading it as one is
      // the same half-truth the adb row below was fixed for.
      //
      // WHAT THIS COSTS WHEN IT IS MISSING, measured 2026-08-27 rather than
      // assumed — and it is not free, which is what the ticket got wrong.
      // isAvailable() calls KokoroTTS.from_pretrained(), so the PROBE is the
      // download. On a cold machine the first fallback to rung 2 races an
      // ~80MB+ HuggingFace fetch against LOAD_TIMEOUT_MS and then falls
      // through to edge. Measured against a deliberately bogus model id the
      // probe took 4,066ms to fail, which is a live network round-trip, and
      // the result is sticky for the process. So a missing kokoro model is not
      // "rung 2 resolves unavailable" — it is up to LOAD_TIMEOUT_MS of silence
      // on the first fallback of every process, once, and then free.
      //
      // Only a gap when kokoro is actually IN the chain: a machine that has
      // removed it has nothing wrong with it, and a report that is red for an
      // expected reason is a report people stop reading.
      id: 'kokoro',
      label: 'Kokoro model (TTS chain rung)',
      required: false,
      ok: !kokoroInChain || kokoroModelPresent,
      detail: !kokoroInChain
        ? 'not in VOICE_TTS_CHAIN — nothing to install'
        : (kokoroModelPresent
          ? 'cached in ' + kokoroDir
          : 'no .onnx weights under ' + kokoroDir + ' — the first fallback to kokoro '
            + 'will spend up to ' + kokoro.LOAD_TIMEOUT_MS + 'ms downloading before falling through to edge'),
      why: 'kokoro is a member of VOICE_TTS_CHAIN, so its absence is paid for at '
        + 'runtime rather than reported here',
      // Both options are real, and neither loops. The adb hint's failure was
      // naming an --install that unpacked into an already-populated directory
      // and left the runtime resolving elsewhere; there is no setup-kokoro.js
      // to name here, so this says what actually changes the outcome.
      fix: 'either drop kokoro from VOICE_TTS_CHAIN in mythos/.env, or let the first '
        + 'fallback populate ' + kokoroDir + ' (it downloads on demand; nothing to run)',
    },
    {
      id: 'dsh',
      label: 'DeepSeek Harness (build engine)',
      required: false,
      // A present-but-wrong-version install is NOT ok. The adapter asserts the
      // pin before every task, so reporting "installed" for a version it refuses
      // would be the same half-truth that let six consecutive builds fail
      // silently (BUG-168).
      ok: Boolean(dshFound && dshFound.entry && dshFound.version === dsh.DSH_VERSION),
      detail: dshFound
        ? (dshFound.entry || dshFound.pkgDir) + ' (version ' + dshFound.version
          + (dshFound.version === dsh.DSH_VERSION ? ', pinned)' : ', PINNED IS ' + dsh.DSH_VERSION + ')')
        : 'not found in ' + dsh.dshSearchHomes().map(dsh.packageDirFor).join(' | '),
      why: 'the only build-content engine — builds FAIL without it (boot still succeeds)',
      fix: 'node scripts/setup-dsh.js --install',
    },
    {
      // BUG-360 follow-up. This asked android.resolveAdbPath(), which is the
      // WRITE target — the single directory --install would unpack into — and
      // therefore answered a different question from the one the runtime asks.
      // Through the whole of BUG-360 doctor printed "OK  Android platform-tools
      // (adb)" and "No gaps" while all 14 phone_* tools were dead, because the
      // repo copy it pointed at genuinely existed and the adapter was spawning
      // bare 'adb' instead. Fixing only the adapter would have left the same
      // divergence pointing the other way: with MYTHOS_TOOLS_DIR set,
      // resolveAdbPath() names userData only, so doctor would report NOT FOUND
      // for a repo-installed adb the adapter finds and uses happily.
      //
      // findInstalledAdb() is the runtime's own resolver. Two components
      // answering "is adb here" with two different functions is the defect
      // class, not the individual wrong answer — test/android-adb-resolution
      // pins that doctor and the adapter cannot diverge again.
      // BUG-374 — the paragraph above was still true and still not enough.
      // findInstalledAdb() is only the FALLBACK rung. The runtime's first rung is
      // an explicit ANDROID_ADB_BIN, taken VERBATIM
      // (adapters/android-child/index.js: `if (requested && requested !==
      // DEFAULT_ADB_BIN) return requested`), and findInstalledAdb() never looks
      // at that variable at all. Measured 2026-08-27 with
      // ANDROID_ADB_BIN=<nonexistent-dir>/adb.exe:
      //
      //   doctor  -> findInstalledAdb() -> the repo copy      -> "OK", "No gaps"
      //   runtime -> the bogus path verbatim -> spawn ENOENT  -> OFFLINE
      //
      // So BUG-360's outage was reproducible through the documented override,
      // after BUG-360 was closed. The old guard could not catch it: it asserted
      // `row.ok === Boolean(findInstalledAdb())` while the row WAS
      // Boolean(findInstalledAdb()) — the same expression on both sides, a
      // tautology that passes for every input, under a comment claiming it
      // pinned doctor and the adapter together.
      //
      // Now: resolve exactly as the runtime resolves, then ask whether that
      // resolution is usable. Reachability is checked with the filesystem, never
      // a spawn, so this stays a report about configuration.
      id: 'adb',
      label: 'Android platform-tools (adb)',
      required: false,
      ok: adbReach.ok,
      detail: adbReach.ok ? adbReach.why : adbReach.why + '  [the runtime spawns this path]',
      why: 'every phone_* effector shells out to adb — all 14 go dark if this is wrong',
      fix: process.env.ANDROID_ADB_BIN
        ? 'ANDROID_ADB_BIN is set and overrides every install location — correct it or '
          + 'unset it, then re-run. `node scripts/setup-android.js --install` will NOT '
          + 'help while it points somewhere wrong.'
        : 'node scripts/setup-android.js --install',
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
  const chain = ttsChain();
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
// storeNames: key NAMES from the Electron desktop key store, optional. A key
// the operator saved through the setup screen lives THERE, not in process.env,
// until the next launch injects it into the child env — so a report that only
// checked process.env would tell the setup screen "GOOGLE_API_KEY missing"
// five seconds after the operator stored it. Counting store names as present
// is the documented intent (see keyStoreNames() below: "a key set through the
// desktop setup screen therefore shows as present-by-name"). Values never
// reach this function — names only, by construction.
function evaluateKeyChecks(storeNames) {
  const store = new Set(storeNames || []);
  return KEY_CHECKS.map((check) => {
    const names = check.anyOf || check.allOf || [];
    const present = names.filter((n) => envPresent(n) || store.has(n));
    const ok = check.allOf ? present.length === names.length : present.length > 0;
    const missing = names.filter((n) => !envPresent(n) && !store.has(n));
    return {
      id: check.id,
      label: check.label,
      required: check.required,
      ok,
      // Names of what IS configured. Safe by construction: names, never values.
      // `detailSuffix` (BUG-387) lets a row qualify what "configured" means
      // without leaving the names-only contract: it is a constant on the check,
      // never derived from a value. Only appended on the OK arm — a row that is
      // already reporting a gap does not need telling that the gap is unverified.
      detail: ok
        ? `configured: ${present.join(', ')}${check.detailSuffix || ''}`
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

function buildReport(envDir, opts) {
  const env = loadEnv(envDir);
  const store = keyStoreNames();
  const keys = evaluateKeyChecks((opts && opts.keyStoreNames) ? opts.keyStoreNames : store.names);
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
  // opts.keyStoreNames lets a test simulate a machine with no desktop key store
  // (or a specific one). Production passes nothing and gets the real store.
  // Evaluated once here so --strict and the printed report agree with each other
  // and with /api/setup/status (which calls buildReport with the same default).
  if (opts && opts.keyStoreNames === undefined) opts = { ...opts, keyStoreNames: keyStoreNames().names };
  else if (!opts) opts = { keyStoreNames: keyStoreNames().names };
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

  const report = buildReport(envDir, opts);

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
  // Exported for test, and for a specific reason: the bare-'adb' PATH branch is
  // unreachable through assetChecks() on any machine that has a repo-local adb,
  // which is every developer machine here. A test that tried to reach it through
  // the environment had to guard with an early return, and a mutation proving
  // whichOnPath() always-misses then SURVIVED — the branch was untested and the
  // escape hatch hid it. Same remedy the repo already applies to
  // wakewordModelsDir and localAdbPath: expose the seam instead of hoping the
  // machine is in the right state.
  adbReachable,
  whichOnPath,
  evaluateKeyChecks,
  collectSettings,
  compareSettings,
  buildReport,
  main,
};
