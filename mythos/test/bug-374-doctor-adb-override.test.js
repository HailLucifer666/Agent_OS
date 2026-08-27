'use strict';

// test/bug-374-doctor-adb-override.test.js
//
// BUG-360 was closed, and its outage was still reproducible through the
// documented override.
//
// The runtime resolves adb in two rungs. The FIRST is an explicit
// `ANDROID_ADB_BIN`, taken verbatim — adapters/android-child/index.js:
// `if (requested && requested !== DEFAULT_ADB_BIN) return requested`. The second
// is `findInstalledAdb()`, which searches install locations and NEVER looks at
// that variable. doctor's adb row asked only the second one, so:
//
//   ANDROID_ADB_BIN=<nonexistent-dir>/adb.exe
//     doctor  -> findInstalledAdb() -> the repo copy      -> "OK", "No gaps"
//     runtime -> the bogus path verbatim -> spawn ENOENT  -> OFFLINE, 14 tools dead
//
// Measured 2026-08-27, on a machine where adb IS installed — which is why it was
// invisible: both answers coincide unless the override is set.
//
// WHY THE EXISTING GUARD DID NOT CATCH IT. test/android-adb-resolution.test.js
// asserted `row.ok === Boolean(setupAndroid.findInstalledAdb())` while the row
// WAS `Boolean(findInstalledAdb())` — the same expression on both sides. A
// tautology, passing for every possible input, under a comment claiming it
// pinned doctor and the adapter together. Two resolvers cannot be compared by
// asking one of them twice, and that assertion is corrected in its own file.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctor = require('../scripts/doctor.js');
const setupAndroid = require('../scripts/setup-android.js');
const androidChild = require('../adapters/android-child/index.js');

function adbRow() {
  const row = doctor.assetChecks().find((r) => r.id === 'adb');
  assert.ok(row, 'doctor must still carry an adb row — its absence would hide this entirely');
  return row;
}

// Restore is unconditional: a leaked ANDROID_ADB_BIN or PATH would corrupt every
// later test in the process rather than fail this one.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('BUG-374 — doctor resolves adb the way the runtime does, override included', () => {
  test('a bogus ANDROID_ADB_BIN is a GAP, not "OK" — the regression itself', () => {
    const bogus = path.join(os.tmpdir(), 'bug374-no-such-dir', 'adb.exe');
    assert.ok(!fs.existsSync(bogus), 'fixture precondition: the path must not exist');
    const row = withEnv({ ANDROID_ADB_BIN: bogus }, adbRow);
    assert.equal(row.ok, false,
      'the runtime spawns this path verbatim and gets ENOENT; a report that says OK '
      + 'is vouching for a subsystem that cannot start');
    assert.ok(row.detail.includes(bogus),
      'the detail must name the path the runtime will actually use, not the one doctor '
      + `would have preferred; got: ${row.detail}`);
  });

  test('the fix hint does not send the operator round the loop that failed BUG-360', () => {
    // BUG-360's hint said "run setup-android.js --install", which re-downloaded
    // into an already-populated directory and left the override untouched, so
    // following it changed nothing. With the override set, --install cannot help.
    const bogus = path.join(os.tmpdir(), 'bug374-no-such-dir', 'adb.exe');
    const row = withEnv({ ANDROID_ADB_BIN: bogus }, adbRow);
    assert.match(row.fix, /ANDROID_ADB_BIN/,
      'the hint must name the variable that is actually causing this');
    assert.match(row.fix, /will NOT help/,
      'it must say outright that the install command is the wrong remedy here');
  });

  test('no override on a machine with adb installed stays OK — no false alarm', () => {
    // The control. Without it, a row hardcoded to `ok: false` would pass the
    // regression test above.
    const installed = setupAndroid.findInstalledAdb();
    if (!installed) return; // genuinely no adb anywhere: nothing to assert
    const row = withEnv({ ANDROID_ADB_BIN: undefined }, adbRow);
    assert.equal(row.ok, true, 'adb is installed and no override is set; this must not be a gap');
  });

  test('an override pointing at a REAL file is honoured, not merely rejected', () => {
    // The override is an instruction. A row that failed whenever the variable was
    // set would satisfy every other test here while being just as wrong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug374-real-'));
    const fake = path.join(dir, 'adb.exe');
    fs.writeFileSync(fake, 'not a real adb, but a real file');
    try {
      const row = withEnv({ ANDROID_ADB_BIN: fake }, adbRow);
      assert.equal(row.ok, true, 'an existing overridden path must report OK');
      assert.ok(row.detail.includes(fake), 'and must name it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reachability is a filesystem question, never a spawn', () => {
    // doctor's closing line promises it reports what is CONFIGURED and points at
    // the verify-*.js harnesses for real calls. The file written above is not a
    // runnable binary; a check that executed it would report a gap. This pins the
    // contract behaviourally rather than by reading the source.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug374-nonexec-'));
    const notRunnable = path.join(dir, 'adb.exe');
    fs.writeFileSync(notRunnable, '#!/bin/sh\nexit 9\n');
    try {
      const row = withEnv({ ANDROID_ADB_BIN: notRunnable }, adbRow);
      assert.equal(row.ok, true,
        'doctor must not execute adb to decide this — a non-runnable file that EXISTS '
        + 'is a configuration that resolves, and whether it runs is verify-*.js\'s question');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The second rung's own failure mode: `resolveAdbBin` returns the bare command
  // and the runtime spawns it, which is BUG-360's original outage.
  //
  // Driven through doctor.adbReachable() rather than through assetChecks(),
  // because the repo-local adb makes this branch UNREACHABLE from the
  // environment on every machine here. The first version of this test went
  // through assetChecks() with an `if (row.detail.includes('platform-tools'))
  // return;` escape hatch — and a mutation making whichOnPath() always miss then
  // SURVIVED, because the hatch fired and the test asserted nothing. A guard with
  // a conditional return is a guard that reports the machine's state, not the
  // code's.
  test('bare \'adb\' resolves only when something on PATH answers to it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug374-path-'));
    try {
      withEnv({ PATH: dir, PATHEXT: '.EXE' }, () => {
        const miss = doctor.adbReachable('adb');
        assert.equal(miss.ok, false, 'an empty PATH cannot yield an adb');
        assert.match(miss.why, /PATH/, 'the reason must name PATH so the remedy is obvious');
        assert.equal(doctor.whichOnPath('adb'), null, 'and the lookup itself must miss');

        fs.writeFileSync(path.join(dir, 'adb.EXE'), 'stand-in');
        const hit = doctor.adbReachable('adb');
        assert.equal(hit.ok, true, 'once adb is on PATH the bare command resolves');
        assert.ok(hit.why.includes(dir), `and the reason must name where it was found: ${hit.why}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE REAL CROSS-CHECK, replacing the tautology. It compares doctor's
  // resolution against the ADAPTER's — two different functions in two different
  // files — for the exact input src/main.js passes.
  test('doctor and the ADAPTER resolve the same binary, override or not', () => {
    const cases = [undefined, path.join(os.tmpdir(), 'bug374-xcheck', 'adb.exe')];
    for (const override of cases) {
      withEnv({ ANDROID_ADB_BIN: override }, () => {
        // What src/main.js hands the adapter is config.ANDROID_ADB_BIN, whose
        // schema default is the bare string 'adb'.
        const requested = process.env.ANDROID_ADB_BIN || 'adb';
        const adapterSays = androidChild.resolveAdbBin(requested);
        const doctorSays = setupAndroid.resolveAdbBin(null, process.env);
        assert.equal(doctorSays, adapterSays,
          `override=${String(override)}: doctor resolves "${doctorSays}" and the adapter `
          + `resolves "${adapterSays}". A diagnostic that names a different binary from the `
          + 'one the runtime spawns is BUG-360, whichever way it points.');
        const row = adbRow();
        assert.ok(row.detail.includes(adapterSays) || row.detail.includes('PATH'),
          `the row must describe the adapter's binary (${adapterSays}); got: ${row.detail}`);
      });
    }
  });
});
