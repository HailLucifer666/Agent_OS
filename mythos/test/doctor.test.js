'use strict';

// scripts/doctor.js — the first-run/parity report.
//
// What is worth pinning here is not the prose but the three promises the report
// makes, each of which is easy to break in a later edit:
//   1. it never emits a secret VALUE, only names;
//   2. anyOf vs allOf are different questions (one provider key is enough for
//      the brain; a partial OAuth grant is a gap, not a pass);
//   3. --compare reports a difference without calling it a failure, because two
//      machines are allowed to differ deliberately.
//
// Run: cd mythos && node --test test/doctor.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const doctor = require('../scripts/doctor.js');

const KEY_NAMES = [
  'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY', 'NIM_API_KEY', 'ZCODE_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
  'MYTHOS_AUTH_TOKEN',
];

let saved;

beforeEach(() => {
  saved = {};
  for (const name of [...KEY_NAMES, ...doctor.PARITY_SETTINGS]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('doctor: key checks', () => {
  it('one provider key satisfies the brain — anyOf is not allOf', () => {
    process.env.GROQ_API_KEY = 'x'.repeat(20);
    const brain = doctor.evaluateKeyChecks().find((r) => r.id === 'brain');
    assert.equal(brain.ok, true, 'a single lane key is enough to have a brain');
  });

  it('no provider key at all is a REQUIRED gap, not an optional one', () => {
    const brain = doctor.evaluateKeyChecks().find((r) => r.id === 'brain');
    assert.equal(brain.ok, false);
    assert.equal(brain.required, true,
      'a machine with no LLM key is not "mostly working" — this is the gap that makes it a half-broken twin');
  });

  it('a PARTIAL Google OAuth grant is a gap — allOf means all three', () => {
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    // GOOGLE_REFRESH_TOKEN deliberately absent — this is the shape a half-run
    // google-auth.js leaves behind, and it must not read as configured.
    const oauth = doctor.evaluateKeyChecks().find((r) => r.id === 'google-oauth');
    assert.equal(oauth.ok, false);
    assert.match(oauth.detail, /GOOGLE_REFRESH_TOKEN/, 'the report must name what is missing');
    assert.doesNotMatch(oauth.detail, /secret/,
      'and must never echo a value, even a fake one, while naming it');
  });

  it('an empty-string key counts as absent, not as present', () => {
    process.env.GOOGLE_API_KEY = '   ';
    const live = doctor.evaluateKeyChecks().find((r) => r.id === 'live-voice');
    assert.equal(live.ok, false, 'a blank value in .env is the classic "I set it" false positive');
  });

  it('a key stored in the desktop key store counts as configured by name', () => {
    // The operator saves keys through the setup screen straight into the
    // Electron key store — they are NOT in process.env until the next launch
    // injects them. A report that ignored the store would tell the setup screen
    // "GOOGLE_API_KEY missing" right after the operator stored it (the exact
    // "I set it and it still says no keys" false negative). This pins the
    // documented intent: present-by-name counts as configured.
    const live = doctor.evaluateKeyChecks(['GOOGLE_API_KEY']).find((r) => r.id === 'live-voice');
    assert.equal(live.ok, true);
    assert.match(live.detail, /GOOGLE_API_KEY/);
    const brain = doctor.evaluateKeyChecks(['CEREBRAS_API_KEY']).find((r) => r.id === 'brain');
    assert.equal(brain.ok, true, 'a single stored provider key is a brain, same as a single env one');
  });

  it('a stored key closes the required gap in the assembled report', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-store-'));
    const report = doctor.buildReport(isolated, { keyStoreNames: ['GOOGLE_API_KEY'] });
    assert.equal(report.requiredGaps.some((g) => g.id === 'live-voice'), false,
      'the setup screen must stop nagging about a key that is already stored');
  });

  it('no report line ever contains a key VALUE', () => {
    // The whole surface, with distinctive values planted in every key.
    const canary = 'CANARY-SECRET-VALUE-a1b2c3';
    for (const name of KEY_NAMES) process.env[name] = canary;
    const report = doctor.buildReport();
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, new RegExp(canary),
      'doctor must report names and booleans only — a value in the report can reach a log, a paste, or the HUD');
  });
});

describe('doctor: settings parity', () => {
  it('collects only tracked non-secret settings, and never a key', () => {
    process.env.VOICE_TTS_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'super-secret';
    const settings = doctor.collectSettings();
    assert.equal(settings.VOICE_TTS_PROVIDER, 'gemini');
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'GOOGLE_API_KEY'), false,
      'the export is meant to be safe to copy between machines — an API key in it defeats that');
  });

  it('reports the exact voice delta between a working laptop and a half-wired PC', () => {
    const laptop = { VOICE_S2S_ENABLED: 'true', VOICE_TTS_PROVIDER: 'gemini', VOICE_TTS_CHAIN: 'gemini,edge,piper' };
    const pc = { VOICE_TTS_PROVIDER: 'edge', VOICE_TTS_CHAIN: 'edge' };
    const rows = doctor.compareSettings(laptop, pc);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(rows.length, 3);
    assert.deepEqual(byName.VOICE_S2S_ENABLED, { name: 'VOICE_S2S_ENABLED', here: 'true', there: null },
      'a setting missing on the other machine must show as (unset), not be skipped');
    assert.equal(byName.VOICE_TTS_PROVIDER.there, 'edge');
  });

  it('identical settings produce no rows', () => {
    const same = { VOICE_TTS_PROVIDER: 'gemini' };
    assert.deepEqual(doctor.compareSettings(same, { ...same }), []);
  });
});

describe('doctor: cli contracts', () => {
  const logs = [];
  let realLog;
  // An env dir with no .env in it. Without this every main() call reloads the
  // operator's real mythos/.env into process.env, undoing the beforeEach that
  // cleared the keys — so a "no keys configured" test silently ran against a
  // fully configured machine and passed for the wrong reason.
  let isolatedEnv;
  beforeEach(() => {
    realLog = console.log;
    console.log = (...a) => logs.splice(logs.length, 0, a.join(' '));
    isolatedEnv = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-env-'));
  });
  afterEach(() => { console.log = realLog; logs.length = 0; });

  it('--compare exits 0 on a difference by default — two machines may differ deliberately', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')), 'other.json');
    fs.writeFileSync(file, JSON.stringify({ settings: { VOICE_TTS_PROVIDER: 'edge' } }));
    process.env.VOICE_TTS_PROVIDER = 'gemini';
    assert.equal(doctor.main(['--compare', file], { envDir: isolatedEnv }), 0);
    assert.equal(logs.some((l) => /VOICE_TTS_PROVIDER/.test(l)), true, 'and still reports the difference');
  });

  it('--compare --strict exits 1 on a difference, for a parity gate', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')), 'other.json');
    fs.writeFileSync(file, JSON.stringify({ settings: { VOICE_TTS_PROVIDER: 'edge' } }));
    process.env.VOICE_TTS_PROVIDER = 'gemini';
    assert.equal(doctor.main(['--compare', file, '--strict'], { envDir: isolatedEnv }), 1);
  });

  it('--compare accepts a bare settings object as well as an --export envelope', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')), 'bare.json');
    fs.writeFileSync(file, JSON.stringify({ VOICE_TTS_PROVIDER: 'gemini' }));
    process.env.VOICE_TTS_PROVIDER = 'gemini';
    assert.equal(doctor.main(['--compare', file], { envDir: isolatedEnv }), 0);
    assert.equal(logs.some((l) => /Settings match/.test(l)), true);
  });

  it('--export writes settings and no secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
    const file = path.join(dir, 'exported.json');
    process.env.VOICE_TTS_PROVIDER = 'gemini';
    process.env.GOOGLE_API_KEY = 'CANARY-KEY';
    assert.equal(doctor.main(['--export', file], { envDir: isolatedEnv }), 0);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /"VOICE_TTS_PROVIDER": "gemini"/);
    assert.doesNotMatch(text, /CANARY-KEY/, 'an exported file is meant to be copied around');
  });

  it('--strict exits 1 while a required key gap remains, and 0 once it is filled', () => {
    // No provider key and no desktop key store -> the brain gap is required.
    // keyStoreNames:[] makes this a machine-with-nothing simulation: a real
    // store on the dev machine would otherwise satisfy the gap and pass --strict
    // for the wrong reason.
    assert.equal(doctor.main(['--strict', '--json'], { envDir: isolatedEnv, keyStoreNames: [] }), 1);
    process.env.GOOGLE_API_KEY = 'x'.repeat(20);
    const code = doctor.main(['--strict', '--json'], { envDir: isolatedEnv, keyStoreNames: [] });
    // Asset gaps (adb, piper voices) are machine-dependent and never required,
    // so filling the key gaps is enough to pass --strict anywhere.
    assert.equal(code, 0, 'only REQUIRED gaps may fail a strict run');
  });
});

describe('doctor: voice identity', () => {
  // The operator's requirement is that MYTHOS sounds like the same person on the
  // laptop, the PC and the phone. providers/tts.js already makes that true within
  // one machine; what these pin is that doctor can PROVE it across machines.
  it('every voice-identity key is tracked for parity, or a mismatch is invisible', () => {
    for (const key of ['GEMINI_LIVE_VOICE', 'VOICE_TTS_VOICE', 'PIPER_VOICE', 'KOKORO_VOICE']) {
      assert.equal(doctor.PARITY_SETTINGS.includes(key), true,
        `${key} decides who is speaking — if --compare does not track it, the other machine can answer ` +
        'in a different voice and nothing reports it');
    }
  });

  it('resolves each engine through production\'s own voiceFor, with the schema defaults applied', () => {
    const report = doctor.buildReport();
    assert.equal(report.voice.error, null, report.voice.error || '');
    const byEngine = Object.fromEntries(report.voice.rows.map((r) => [r.engine, r.voice]));
    // The matched set: these two ids were deliberately chosen to sit beside each
    // other (see voice-identity-consistent.test.js). Reporting "(engine default)"
    // for the edge row would understate exactly the mechanism that matters.
    assert.equal(byEngine['Gemini (Live + TTS)'], 'Aoede');
    assert.equal(byEngine['edge-tts (fallback)'], 'en-US-AvaNeural');
    for (const row of report.voice.rows) {
      assert.notEqual(row.voice, '(engine default)',
        `${row.engine} must resolve to a concrete voice id — an unresolved row cannot be compared between machines`);
    }
  });

  it('an explicit env override wins, so a deliberate voice change is visible in the report', () => {
    const saved = process.env.GEMINI_LIVE_VOICE;
    process.env.GEMINI_LIVE_VOICE = 'Puck';
    try {
      const report = doctor.buildReport();
      const gemini = report.voice.rows.find((r) => /Gemini/.test(r.engine));
      assert.equal(gemini.voice, 'Puck');
    } finally {
      if (saved === undefined) delete process.env.GEMINI_LIVE_VOICE;
      else process.env.GEMINI_LIVE_VOICE = saved;
    }
  });

  it('reports the chain order and whether the unified Live voice is on', () => {
    // With unified off, the greeting and typed replies leave the Live session and
    // come from a different engine — the original "three voices in one session"
    // complaint. Whether it is on is therefore part of voice identity, not a detail.
    const saved = process.env.VOICE_UNIFIED_LIVE_VOICE;
    process.env.VOICE_UNIFIED_LIVE_VOICE = 'false';
    try {
      assert.equal(doctor.buildReport().voice.unified, false);
    } finally {
      if (saved === undefined) delete process.env.VOICE_UNIFIED_LIVE_VOICE;
      else process.env.VOICE_UNIFIED_LIVE_VOICE = saved;
    }
    assert.equal(Array.isArray(doctor.buildReport().voice.chain), true);
  });
});

describe('doctor: asset checks', () => {
  it('every asset row carries a runnable fix, and none advertises a script that does not exist', () => {
    const rows = doctor.assetChecks();
    assert.ok(rows.length >= 6);
    for (const row of rows) {
      assert.equal(typeof row.fix, 'string');
      assert.notEqual(row.fix.trim(), '', `${row.id} must name how to close its gap`);
      // The piper row deliberately MENTIONS scripts/setup-piper.js in order to
      // warn that it is absent, so it is the one row allowed to name it.
      const claimsScript = /scripts\/setup-([a-z-]+)\.js/.exec(row.fix);
      if (claimsScript && row.id !== 'piper') {
        const script = path.join(__dirname, '..', 'scripts', `setup-${claimsScript[1]}.js`);
        assert.equal(fs.existsSync(script), true,
          `${row.id}'s fix names setup-${claimsScript[1]}.js, which must exist to be runnable`);
      }
    }
  });

  it('the key store reports names only, and an absent store is not an error', () => {
    const store = doctor.keyStoreNames();
    assert.ok(Array.isArray(store.names));
    // Whatever this machine has, the shape must never carry values.
    assert.equal(store.names.every((n) => typeof n === 'string'), true);
  });
});
