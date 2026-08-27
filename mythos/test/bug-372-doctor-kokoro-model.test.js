'use strict';

// test/bug-372-doctor-kokoro-model.test.js
//
// doctor.js printed "No gaps. Every tracked key, model and binary is present."
// on a machine where mythos/models/ holds only piper and whisper, while
// VOICE_TTS_CHAIN was gemini,kokoro,edge,piper. It looked at the kokoro VOICE ID
// (af_heart) and never at the kokoro MODEL. A voice id is a string in .env — it
// is present whether or not any weights exist, so it can never be a gap, and
// reading it as evidence of an installed engine is the same half-truth that let
// the report say "OK  Android platform-tools (adb)" through the whole of
// BUG-360 while all 14 phone_* tools were dead.
//
// These tests drive the REAL assetChecks() against real directories rather than
// asserting on the shape of doctor.js's source, because the defect was never a
// missing line — it was a line that measured the wrong thing and passed.
//
// SCOPE, stated so nothing reads as closed that is not: this fixes the REPORT.
// BUG-372's other half — whether kokoro should be installed or dropped from the
// default chain — is an operator decision and is deliberately untouched here.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('../scripts/doctor.js');
const kokoro = require('../providers/kokoro-tts.js');

function kokoroRow() {
  const row = doctor.assetChecks().find((r) => r.id === 'kokoro');
  assert.ok(row, 'doctor must carry a row for the kokoro model at all — its absence was the bug');
  return row;
}

// Mutating process.env is the only way to ask assetChecks() a different
// question, since it reads the environment at call time exactly as the running
// report does. Restore is unconditional so an assertion failure cannot leak a
// chain setting into the rest of the suite.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tempDir() {
  // os.tmpdir() is safe here in a way it is not for the file effectors: nothing
  // in this test spawns a server, watches a directory, or goes through
  // resolveSandboxed(), so neither the libuv short-name abort nor the
  // 8.3-versus-long-form prefix compare can bite.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug240-kokoro-'));
}

describe('BUG-372 — doctor reports on the kokoro MODEL, not the kokoro voice id', () => {
  test('a chain that names kokoro with no weights cached is a GAP, not "No gaps"', () => {
    const dir = tempDir();
    try {
      const row = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper', KOKORO_MODEL_DIR: dir },
        kokoroRow,
      );
      assert.equal(row.ok, false, 'an empty cache while kokoro is in the chain must not report ok');
      assert.match(row.detail, /no \.onnx weights under/,
        'the detail must say what is missing, not merely that something is');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same machine with kokoro removed from the chain is NOT a gap', () => {
    // A report that is red for an expected reason is a report people stop
    // reading. A machine that has dropped the rung has nothing wrong with it.
    const dir = tempDir();
    try {
      const row = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,edge,piper', KOKORO_MODEL_DIR: dir },
        kokoroRow,
      );
      assert.equal(row.ok, true, 'kokoro absent from the chain cannot be a gap');
      assert.match(row.detail, /not in VOICE_TTS_CHAIN/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cached weights clear the gap, found through a HuggingFace-shaped nested cache', () => {
    // @huggingface/transformers does not write into the cache root — it writes
    // to <cacheDir>/models--<org>--<repo>/... , so a check that only listed the
    // top level would report MISSING for a fully downloaded model.
    const dir = tempDir();
    try {
      const nested = path.join(dir, 'models--onnx-community--Kokoro-82M-v1.0-ONNX', 'onnx');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'model_q8f16.onnx'), 'not real weights, but a real .onnx');
      const row = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper', KOKORO_MODEL_DIR: dir },
        kokoroRow,
      );
      assert.equal(row.ok, true, 'weights nested the way HuggingFace nests them must count as present');
      assert.match(row.detail, /cached in/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an aborted download that left only directories is NOT a model', () => {
    // The precise trap this row exists to avoid: existsSync() on the cache dir
    // is true the moment a download starts, so a bare directory check would go
    // green on an abandoned fetch — which is exactly the state a 15s probe
    // timeout leaves behind.
    const dir = tempDir();
    try {
      fs.mkdirSync(path.join(dir, 'models--onnx-community--Kokoro-82M-v1.0-ONNX', 'blobs'),
        { recursive: true });
      fs.writeFileSync(path.join(dir, 'models--onnx-community--Kokoro-82M-v1.0-ONNX', 'config.json'), '{}');
      const row = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper', KOKORO_MODEL_DIR: dir },
        kokoroRow,
      );
      assert.equal(row.ok, false,
        'directories and a config.json are the residue of a failed download, not weights');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE CLASS GUARD, and the reason this file exists rather than a one-line
  // patch. The plan's requirement was not "add a kokoro check" — it was that
  // every capability doctor reports on must resolve through the same helper the
  // runtime consumer uses. Two resolvers is how BUG-360 stayed green for weeks.
  test('doctor reports on the directory the PROVIDER reads, not a second opinion', () => {
    const dir = tempDir();
    try {
      const [row, providerDir] = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper', KOKORO_MODEL_DIR: dir },
        () => [kokoroRow(), kokoro.modelCacheDir()],
      );
      assert.equal(providerDir, dir,
        'sanity: the provider itself must honour KOKORO_MODEL_DIR, or this test proves nothing');
      assert.ok(row.detail.includes(dir),
        `doctor must name the provider's own cache dir (${dir}); naming any other path means the `
        + 'report and the runtime are answering different questions, which is BUG-360 exactly');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fix hint names a remedy that exists', () => {
    // BUG-360's hint told the operator to run an --install that unpacked into an
    // already-populated directory and left the runtime resolving elsewhere, so
    // following it looped forever. A hint naming a setup-kokoro.js that is not
    // in the repo would be the same defect, so that is checked rather than
    // trusted.
    const dir = tempDir();
    try {
      const row = withEnv(
        { VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper', KOKORO_MODEL_DIR: dir },
        kokoroRow,
      );
      assert.match(row.fix, /VOICE_TTS_CHAIN/,
        'dropping the rung is one of the two real remedies and must be offered');
      const scripts = row.fix.match(/[\w-]+\.js/g) || [];
      for (const s of scripts) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', s)),
          `the hint names scripts/${s}, which does not exist — a hint that cannot be followed is worse `
          + 'than no hint, because it looks like progress');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
