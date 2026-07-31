'use strict';

// REMEDIATION P0-1 / item 6 (2026-07-29 audit): the CLI probe in
// adapters/hermes-agent/index.js used to collapse a spawn ENOENT, an
// exit-nonzero, and a probe timeout into the exact same silent
// `resolve(false)` — the single most useful diagnostic in the whole incident
// was thrown away, which is why P0-1's real root cause was undiscoverable
// from the logs. These tests drive REAL child processes (no mocking) through
// each of the three distinct failure shapes and assert getStatus() now
// reports which one actually happened.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hermes = require('../adapters/hermes-agent');

const SAVED_KEYS = ['HERMES_CLI', 'HERMES_API_URL', 'HERMES_API_KEY', 'HERMES_CLI_PROBE_TIMEOUT_MS'];
let saved;
const tempFiles = [];

beforeEach(() => {
  saved = {};
  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  // Force the HTTP half offline too so state is unambiguously CLI-driven —
  // point it at a port nothing listens on.
  process.env.HERMES_API_URL = 'http://127.0.0.1:1';
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (tempFiles.length) {
    try { fs.unlinkSync(tempFiles.pop()); } catch (_) { /* best-effort cleanup */ }
  }
});

function writeTempCmd(name, body) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, body);
  tempFiles.push(p);
  return p;
}

describe('hermes-agent CLI probe: distinct failure diagnostics (P0-1)', () => {
  it('a spawn ENOENT (binary genuinely missing) is reported as spawn-error/ENOENT, not a silent false', async () => {
    process.env.HERMES_CLI = path.join(os.tmpdir(), 'mythos-test-does-not-exist-' + Date.now() + '.exe');
    const online = await hermes.probe(true);
    assert.equal(online, false);
    const status = hermes.getStatus();
    assert.equal(status.state, 'OFFLINE');
    assert.ok(status.cliProbeDiagnostic, 'a failed probe must record a diagnostic');
    assert.equal(status.cliProbeDiagnostic.kind, 'spawn-error');
    assert.equal(status.cliProbeDiagnostic.code, 'ENOENT');
    assert.match(status.hint, /CLI probe: spawn-error ENOENT/);
  });

  it('a non-zero exit is reported as exit-nonzero with the real code, not merged into "not installed"', async function() {
    if (process.platform !== 'win32') { this.skip(); return; }
    process.env.HERMES_CLI = writeTempCmd('mythos-test-hermes-exit7.cmd', '@echo off\r\nexit /b 7\r\n');
    const online = await hermes.probe(true);
    assert.equal(online, false);
    const status = hermes.getStatus();
    assert.equal(status.cliProbeDiagnostic.kind, 'exit-nonzero');
    assert.equal(status.cliProbeDiagnostic.code, 7);
  });

  // CONTRACT CHANGED 2026-07-31 (operator-reported: every build failing with
  // "hermes-agent not installed/running" on a machine where Hermes works).
  // A timeout used to resolve false, i.e. OFFLINE, i.e. no builds at all. But
  // `hermes --version` measured 21.2s on the operator's machine while MYTHOS was
  // running — a slow probe is evidence of SLOWNESS, not of absence. It now stays
  // ONLINE and still reports the timeout diagnostic, so the condition is visible
  // without being fatal. ENOENT / EACCES / exit-nonzero are real evidence and
  // remain OFFLINE (the two tests above).
  it('a hung child stays ONLINE but still reports the timeout diagnostic', async function() {
    if (process.platform !== 'win32') { this.skip(); return; }
    process.env.HERMES_CLI_PROBE_TIMEOUT_MS = '300';
    process.env.HERMES_CLI = writeTempCmd('mythos-test-hermes-hang.cmd', '@echo off\r\nping -n 5 127.0.0.1 >nul\r\n');
    const online = await hermes.probe(true);
    assert.equal(online, true, 'a slow probe must not be reported as "not installed"');
    const status = hermes.getStatus();
    assert.equal(status.state, 'ONLINE');
    assert.equal(status.mode, 'cli');
    assert.equal(status.cliProbeDiagnostic.kind, 'timeout');
    assert.match(status.hint, /slow probe is not evidence of absence/);
  });

  it('a healthy CLI clears any prior diagnostic (no stale failure carried forward)', async function() {
    if (process.platform !== 'win32') { this.skip(); return; }
    // First, force a failure so a diagnostic is recorded...
    process.env.HERMES_CLI = path.join(os.tmpdir(), 'mythos-test-does-not-exist-2-' + Date.now() + '.exe');
    await hermes.probe(true);
    assert.ok(hermes.getStatus().cliProbeDiagnostic);

    // ...then point at a real, always-succeeding command and re-probe.
    process.env.HERMES_CLI = writeTempCmd('mythos-test-hermes-ok.cmd', '@echo off\r\nexit /b 0\r\n');
    const online = await hermes.probe(true);
    assert.equal(online, true);
    assert.equal(hermes.getStatus().cliProbeDiagnostic, null, 'a successful probe must clear the previous failure diagnostic');
  });
});
