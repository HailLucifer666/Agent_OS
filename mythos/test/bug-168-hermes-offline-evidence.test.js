'use strict';

// test/bug-168-hermes-offline-evidence.test.js — BUG-168.
//
// A live session on 2026-08-07 lost every build. Six consecutive build
// attempts failed, each with the same line — "hermes-agent not
// installed/running" — and nothing else: not which binary was checked, not
// whether it was missing or merely unrunnable, not whether a provider was
// configured at all. Meanwhile the capability manifest ("what can you do")
// reported no problem, because hermes-agent was the one adapter nobody
// probed at boot: it has no start*() of its own, so its first probe happened
// inside the first build. Hermes is the ONLY build-content engine and there
// is no brain fallback by design, so "the build engine is offline" is a
// capability outage that has to be announced, not discovered six failures in.
//
// Two halves, tested here:
//   1. every OFFLINE build failure carries the probe evidence
//   2. boot probes the engine and lets it into the capability manifest
//
// The second half is a source-shape assertion on src/main.js. That is the
// same tool test/electron-cursor-overlay.test.js uses and for the same
// reason: booting the real thing is not available to a unit test, and this
// repo has already been burned by a green suite that could not tell whether
// something ran at boot at all.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hermes = require('../adapters/hermes-agent');

const SAVED_KEYS = [
  'HERMES_CLI', 'HERMES_API_URL', 'HERMES_API_KEY',
  'HERMES_PROVIDER_KEY', 'HERMES_PROVIDER_BASE_URL', 'HERMES_INFERENCE_MODEL',
];
let saved;

beforeEach(() => {
  saved = {};
  for (const k of SAVED_KEYS) saved[k] = process.env[k];
  // Force the HTTP half offline so state is unambiguously CLI-driven.
  process.env.HERMES_API_URL = 'http://127.0.0.1:1';
  // A genuinely absent binary — the shape the live session hit.
  process.env.HERMES_CLI = path.join(os.tmpdir(), 'mythos-bug168-absent-' + Date.now() + '.exe');
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('BUG-168 — an OFFLINE build engine must fail with evidence, not a bare "not installed"', () => {

  it('runTask() names the binary it actually checked and what the probe saw', async () => {
    const absent = process.env.HERMES_CLI;
    await hermes.probe(true);

    await assert.rejects(
      () => hermes.runTask('build me a thing'),
      (err) => {
        assert.match(err.message, /hermes-agent OFFLINE/);
        assert.ok(err.message.includes(absent), 'the failure must name the binary path that was checked, got: ' + err.message);
        assert.match(err.message, /probe: spawn-error ENOENT/, 'the failure must say WHAT the probe saw');
        assert.match(err.message, /setup-hermes\.js --install/, 'the failure must carry an actionable fix');
        return true;
      }
    );
  });

  it('a build failure says so explicitly when no provider slot is configured at all', async () => {
    delete process.env.HERMES_PROVIDER_KEY;
    delete process.env.HERMES_PROVIDER_BASE_URL;
    delete process.env.HERMES_INFERENCE_MODEL;
    await hermes.probe(true);

    await assert.rejects(
      () => hermes.runTask('build me a thing'),
      (err) => {
        assert.match(err.message, /provider slots: NONE CONFIGURED/);
        assert.match(err.message, /HERMES_PROVIDER_KEY/);
        return true;
      }
    );
  });

  it('the evidence never leaks a provider key', async () => {
    process.env.HERMES_PROVIDER_KEY = 'sk-bug168-secret-value';
    process.env.HERMES_INFERENCE_MODEL = 'some-model-name';
    await hermes.probe(true);

    await assert.rejects(
      () => hermes.runTask('build me a thing'),
      (err) => {
        assert.ok(!err.message.includes('sk-bug168-secret-value'), 'the key must never appear in a build failure message');
        assert.match(err.message, /some-model-name/, 'the model is the safe half and belongs in the evidence');
        return true;
      }
    );
  });
});

describe('BUG-168 — boot must probe the build engine and report it like every other adapter', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  it('the adapters boot step probes hermes-agent', () => {
    assert.match(
      MAIN,
      /require\('\.\.\/adapters\/hermes-agent'\)\.probe\(true\)/,
      'src/main.js must probe hermes-agent at boot — otherwise the first evidence of an offline build engine is a failed build'
    );
  });

  it('an offline build engine is announced once, with its impact', () => {
    assert.match(MAIN, /hermes-agent\.offline/, 'the offline case must be logged under its own event name');
    assert.match(MAIN, /no brain fallback by design/, 'the log must state that this means NO builds, not degraded builds');
  });

  it('hermes-agent appears in the capability manifest alongside the other adapters', () => {
    const block = /function adapterStatuses\(\)[\s\S]*?return out;/.exec(MAIN);
    assert.ok(block, 'adapterStatuses() must still exist');
    assert.match(block[0], /name: 'hermes-agent'/, 'the build engine belongs in the honest capability report');
    // Guard the whole set, so a future edit cannot quietly drop one.
    for (const name of ['pc-child', 'cua-driver', 'android-child', 'browser-agent', 'hermes-agent']) {
      assert.ok(block[0].includes("name: '" + name + "'"), 'adapterStatuses() must report ' + name);
    }
  });
});
