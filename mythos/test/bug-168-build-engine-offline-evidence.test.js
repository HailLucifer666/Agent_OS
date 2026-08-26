'use strict';

// test/bug-168-build-engine-offline-evidence.test.js — BUG-168.
//
// A live session on 2026-08-07 lost every build. Six consecutive build attempts
// failed, each with the same line — "not installed/running" — and nothing else:
// not which binary was checked, not whether it was missing or merely unrunnable,
// not whether a provider was configured at all. Meanwhile the capability
// manifest ("what can you do") reported no problem, because the build engine was
// the one adapter nobody probed at boot: it has no start*() of its own, so its
// first probe happened inside the first build. There is ONE build-content engine
// and no brain fallback by design, so "the build engine is offline" is a
// capability outage that has to be announced, not discovered six failures in.
//
// RENAMED AND RE-POINTED by W6 step 6 (2026-08-22), when Hermes-Agent was
// deleted and DeepSeek Harness became the engine. The file used to be
// bug-168-hermes-offline-evidence.test.js. The BUG is unchanged; only the
// adapter is.
//
// Two halves, tested here:
//   1. every OFFLINE build failure carries the probe evidence
//   2. boot probes the engine and lets it into the capability manifest
//
// The second half is a source-shape assertion on src/main.js. That is the same
// tool test/electron-cursor-overlay.test.js uses and for the same reason: booting
// the real thing is not available to a unit test, and this repo has already been
// burned by a green suite that could not tell whether something ran at boot.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engine = require('../adapters/dsh-agent');

describe('BUG-168 — an OFFLINE build engine must fail with evidence, not a bare "not installed"', () => {
  // NOTE ON HOW THIS DIFFERS FROM THE HERMES VERSION. That one forced OFFLINE by
  // pointing HERMES_CLI at a path that did not exist. dsh has no equivalent
  // env override — it resolves a PINNED, project-local install and deliberately
  // refuses to reach for a global one, which is the property W6 wanted. So the
  // OFFLINE branch is asserted where it can be observed honestly: on a machine
  // where dsh is genuinely absent it is exercised for real, and on a machine
  // where it is installed the test asserts the SHAPE of the failure message
  // instead of faking absence. Faking it by moving the install aside is exactly
  // the destructive-test pattern this repo has already been bitten by, when a
  // renameSync stranded real ONNX weights in a gitignored backup directory.

  it('an OFFLINE engine names what the probe saw and carries an actionable fix', async () => {
    await engine.probe(true);
    const status = engine.getStatus();
    if (status.state === 'ONLINE') {
      // Installed here. Assert the message SHAPE from the source instead of
      // pretending the engine is missing.
      const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js'), 'utf8');
      assert.match(src, /dsh-agent OFFLINE: ' \+ hint \+ offlineEvidence\(\)/,
        'runTask must refuse with the probe hint AND the evidence block');
      assert.match(src, /setup-dsh\.js --install/, 'the evidence must carry an actionable fix');
      assert.match(src, /build lane would use/,
        'the evidence must name the model the lane would have used — "the build failed" and '
        + '"the build failed on this model" are different reports');
      return;
    }
    await assert.rejects(
      () => engine.runTask('build me a thing', { cwd: os.tmpdir() }),
      (err) => {
        assert.match(err.message, /dsh-agent OFFLINE/);
        assert.match(err.message, /setup-dsh\.js --install/, 'the failure must carry an actionable fix');
        assert.match(err.message, /build lane/, 'the failure must name the lane it would have used');
        return true;
      }
    );
  });

  it('getStatus separates the verdict from the evidence behind it', async () => {
    // The hermes adapter's F5 lesson, carried forward: ONLINE from a version
    // banner is not the same claim as ONLINE from a completed build, and a log
    // that cannot tell them apart is how this bug stayed invisible for six
    // builds. So `state`, `evidence` and `lastTaskFailure` are three fields.
    await engine.probe(true);
    const status = engine.getStatus();
    assert.ok(Object.prototype.hasOwnProperty.call(status, 'evidence'));
    assert.ok(Object.prototype.hasOwnProperty.call(status, 'lastTaskFailure'));
    if (status.state === 'OFFLINE') {
      assert.equal(status.evidence, 'none');
      assert.match(status.hint, /dsh/i);
    } else {
      assert.match(status.evidence, /^version-/);
    }
  });

  it('the evidence never leaks a provider key', async () => {
    // The engine forwards exactly ONE credential and the failure text names the
    // MODEL, not the key. The model is the safe half and belongs in a report.
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js'), 'utf8');
    // offlineEvidence() prints the lane's provider/model, never apiKeyEnv's VALUE.
    assert.match(src, /sel\.laneProvider \+ '\/' \+ sel\.model/);
    const laneKeys = Object.values(engine.PI_AI_CATALOG_ROUTES).map((r) => r.apiKeyEnv);
    for (const name of laneKeys) {
      const value = process.env[name];
      if (!value) continue;
      await engine.probe(true);
      const status = engine.getStatus();
      assert.equal(JSON.stringify(status).includes(value), false,
        'getStatus() must never carry the value of ' + name);
    }
  });
});

describe('BUG-168 — boot must probe the build engine and report it like every other adapter', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  it('the adapters boot step probes the build-engine adapter', () => {
    assert.match(
      MAIN,
      /require\('\.\.\/adapters\/dsh-agent'\)\.probe\(true\)/,
      'src/main.js must probe the build engine at boot — otherwise the first evidence of an offline build engine is a failed build'
    );
  });

  it('an offline build engine is announced once, with its impact', () => {
    assert.match(MAIN, /dsh-agent\.offline/, 'the offline case must be logged under its own event name');
    assert.match(MAIN, /no brain fallback by design/, 'the log must state that this means NO builds, not degraded builds');
  });

  it('the build-engine adapter appears in the capability manifest alongside the others', () => {
    // BUG-366 (2026-08-26): this used to regex `function adapterStatuses()` out of
    // main.js and read adapter names from the matched text. The collector moved to
    // capabilities.js (main.js was at its file-size ratchet ceiling), and this test
    // went red on a change that broke nothing — the invariant it guards was never
    // violated, only relocated. That is the standing hazard of a source-shape
    // window, and this repo has paid for it before.
    //
    // Rewritten as a BEHAVIOURAL assertion now that the collector is an exported
    // function: it asks what is actually reported rather than where the code sits,
    // so it survives the next move and is a stronger guard besides. Source-shape
    // is the fallback for wiring no test can reach, not the default.
    const names = require('../src/core/identity/capabilities')
      .collectAdapterStatuses()
      .map((a) => a.name);

    assert.ok(names.includes('dsh-agent'),
      'the build engine belongs in the honest capability report');
    // Guard the whole set, so a future edit cannot quietly drop one.
    for (const name of ['pc-child', 'cua-driver', 'android-child', 'browser-agent', 'dsh-agent']) {
      assert.ok(names.includes(name), 'collectAdapterStatuses() must report ' + name);
    }
  });
});
