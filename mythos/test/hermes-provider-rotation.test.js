'use strict';

// Phase A — Hermes provider failover.
//
// scrubbedEnv() forwarded exactly ONE provider key pair, first match wins, so a
// single 401/429/timeout killed the whole build. Hermes's vendored docs confirm
// HERMES_INFERENCE_MODEL overrides the model at process level (above
// config.yaml) and PASSTHROUGH_PREFIX_RE already forwards HERMES_*, so rotation
// is ENV-ONLY: per attempt we set OPENAI_API_KEY / OPENAI_BASE_URL /
// HERMES_INFERENCE_MODEL in the child env. Hermes's config.yaml is never
// written — there is no MYTHOS-managed state to restore.
//
// 429 is the dominant real-world failure, not 401: every free provider
// rate-limits before it fails auth and none expose rate-limit headers, so
// exhaustion surfaces only as a mid-build 429. It must be classified
// provider-class and rotate.
//
// These tests drive the adapter through a FAKE child_process.spawn rather than
// a fixture binary, so they are deterministic and cross-platform (the existing
// tree-kill test's .bat fixture is win32-only). The adapter destructures
// { spawn } at require time, so the patch must land BEFORE the fresh require —
// same cache-busting precedent as hermes-adapter.test.js's treeKill spy.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const HERMES_PATH = require.resolve('../adapters/hermes-agent');
const CHILD_PROCESS_PATH = require.resolve('child_process');

// Every env var these tests touch, so nothing leaks into sibling suites.
const TOUCHED = [
  'HERMES_CLI', 'HERMES_INFERENCE_MODEL',
  'HERMES_PROVIDER_KEY', 'HERMES_PROVIDER_BASE_URL',
  'HERMES_PROVIDER_KEY_2', 'HERMES_PROVIDER_BASE_URL_2', 'HERMES_PROVIDER_MODEL_2',
  'HERMES_PROVIDER_KEY_3', 'HERMES_PROVIDER_BASE_URL_3', 'HERMES_PROVIDER_MODEL_3',
  'HERMES_PROVIDER_KEY_4', 'HERMES_PROVIDER_BASE_URL_4', 'HERMES_PROVIDER_MODEL_4',
  'NVIDIA_API_KEY', 'NVIDIA_BASE_URL',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GOOGLE_API_KEY',
];

let savedEnv;
let cp;
let originalSpawn;
let hermes;
/** Recorded spawns: { args, env } — one entry per attempt, in order. */
let spawns;
/**
 * Scripted replies keyed by the OPENAI_API_KEY the child was handed.
 * Each value: { stdout?, code?, error?, hang? }
 */
let script;

function fakeChild(plan) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  child.kill = () => {};
  if (plan.hang) return child; // never exits — the caller's timeout must fire
  setImmediate(() => {
    if (plan.error) { child.emit('error', Object.assign(new Error(plan.error.message), { code: plan.error.code })); return; }
    if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout));
    if (plan.stderr) child.stderr.emit('data', Buffer.from(plan.stderr));
    child.emit('exit', plan.code === undefined ? 0 : plan.code, null);
  });
  return child;
}

function installFakeSpawn() {
  delete require.cache[CHILD_PROCESS_PATH];
  cp = require('child_process');
  originalSpawn = cp.spawn;
  cp.spawn = function (bin, args, opts) {
    const env = (opts && opts.env) || {};
    spawns.push({ bin, args, env });
    // The liveness probe (`--version`) must always succeed so the adapter
    // reaches ONLINE/cli and the rotation path is actually reachable.
    if (args && args[0] === '--version') return fakeChild({ stdout: 'hermes 2026.7.20\n', code: 0 });
    const plan = script[env.OPENAI_API_KEY] || script['*'] || { stdout: 'DEFAULT-OK', code: 0 };
    // Snapshot the per-attempt config.yaml WHILE the attempt home still
    // exists (it's cleaned up the instant this attempt's promise settles).
    let configYaml = null;
    let hadDotEnv = false;
    if (env.HERMES_HOME) {
      try { configYaml = fs.readFileSync(path.join(env.HERMES_HOME, 'config.yaml'), 'utf8'); } catch (_) { /* n/a */ }
      hadDotEnv = fs.existsSync(path.join(env.HERMES_HOME, '.env'));
    }
    spawns[spawns.length - 1].configYaml = configYaml;
    spawns[spawns.length - 1].hadDotEnv = hadDotEnv;
    return fakeChild(plan);
  };
  delete require.cache[HERMES_PATH];
  hermes = require('../adapters/hermes-agent');
}

describe('hermes-agent — provider slot rotation', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of TOUCHED) savedEnv[k] = process.env[k];
    for (const k of TOUCHED) delete process.env[k];
    process.env.HERMES_CLI = 'hermes'; // no .bat → shell:false, real argv
    spawns = [];
    script = {};
    installFakeSpawn();
  });

  afterEach(() => {
    if (cp && originalSpawn) cp.spawn = originalSpawn;
    for (const k of TOUCHED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    delete require.cache[HERMES_PATH];
    delete require.cache[CHILD_PROCESS_PATH];
  });

  function wireTwoSlots() {
    process.env.HERMES_PROVIDER_KEY = 'slot1-key';
    process.env.HERMES_PROVIDER_BASE_URL = 'https://api.mistral.ai/v1';
    process.env.HERMES_INFERENCE_MODEL = 'mistral-medium-latest';
    process.env.HERMES_PROVIDER_KEY_2 = 'slot2-key';
    process.env.HERMES_PROVIDER_BASE_URL_2 = 'https://model.inferx.net/endpoints/v1';
    process.env.HERMES_PROVIDER_MODEL_2 = 'Qwen3-Coder-Next-FP8';
  }

  // ---- slot table ---------------------------------------------------------

  it('a single-key install resolves to exactly ONE slot (behaviour unchanged)', () => {
    process.env.HERMES_PROVIDER_KEY = 'only-key';
    process.env.HERMES_PROVIDER_BASE_URL = 'https://api.mistral.ai/v1';
    const slots = hermes.providerSlots();
    assert.equal(slots.length, 1);
    assert.equal(slots[0].slot, 1);
    assert.equal(slots[0].baseUrl, 'https://api.mistral.ai/v1');
  });

  it('absent slots are skipped, not left as holes — slot 4 alone becomes the 2nd entry', () => {
    process.env.HERMES_PROVIDER_KEY = 'k1';
    process.env.HERMES_PROVIDER_KEY_4 = 'k4';
    process.env.HERMES_PROVIDER_BASE_URL_4 = 'https://api.kilo.ai/api/gateway/v1';
    const slots = hermes.providerSlots();
    assert.equal(slots.length, 2);
    assert.deepEqual(slots.map((s) => s.slot), [1, 4]);
  });

  it('scrubbedEnv(extra, slot) rewrites the OpenAI-compatible trio for a non-primary slot', () => {
    wireTwoSlots();
    const slots = hermes.providerSlots();
    const env = hermes.scrubbedEnv({}, slots[1]);
    assert.equal(env.OPENAI_API_KEY, 'slot2-key');
    assert.equal(env.OPENAI_BASE_URL, 'https://model.inferx.net/endpoints/v1');
    assert.equal(env.HERMES_INFERENCE_MODEL, 'Qwen3-Coder-Next-FP8', 'must override the slot-1 model, not inherit it');
    assert.equal(env.HERMES_PROVIDER_KEY_2, undefined, 'slot plumbing must not leak into the child env');
  });

  // ---- RED-FIRST rotation triggers ---------------------------------------

  it('rotates to slot 2 when slot 1 returns exit 0 with an "HTTP 401:" reply on stdout', async () => {
    wireTwoSlots();
    script['slot1-key'] = { stdout: 'HTTP 401: Missing Authentication header', code: 0 };
    script['slot2-key'] = { stdout: 'THE ARTIFACT', code: 0 };

    const rotations = [];
    hermes.onProviderRotated((e) => rotations.push(e));

    const reply = await hermes.runTask('build a thing', { requireCli: true });
    assert.equal(reply, 'THE ARTIFACT');

    const taskSpawns = spawns.filter((s) => s.args[0] === '-z');
    assert.equal(taskSpawns.length, 2, 'both slots must have been attempted');
    assert.equal(taskSpawns[0].env.OPENAI_API_KEY, 'slot1-key');
    assert.equal(taskSpawns[1].env.OPENAI_API_KEY, 'slot2-key');

    assert.equal(rotations.length, 1);
    assert.equal(rotations[0].from, 1);
    assert.equal(rotations[0].to, 2);
    assert.match(rotations[0].reason, /provider-error-reply/);
    assert.equal(hermes.getStatus().activeSlot, 2);
  });

  // ---- Track D: per-attempt HERMES_HOME (real cross-provider failover) ---

  it('each attempt gets its OWN HERMES_HOME, pointed at that slot\'s endpoint/model', async () => {
    wireTwoSlots();
    script['slot1-key'] = { stdout: 'HTTP 401: Missing Authentication header', code: 0 };
    script['slot2-key'] = { stdout: 'THE ARTIFACT', code: 0 };

    await hermes.runTask('build a thing', { requireCli: true });
    const taskSpawns = spawns.filter((s) => s.args[0] === '-z');
    assert.equal(taskSpawns.length, 2);

    // Different attempts must never share a HERMES_HOME — that is the whole
    // concurrency-safety argument (no shared mutable config.yaml to race on).
    assert.ok(taskSpawns[0].env.HERMES_HOME, 'slot 1 attempt must get a HERMES_HOME override');
    assert.ok(taskSpawns[1].env.HERMES_HOME, 'slot 2 attempt must get a HERMES_HOME override');
    assert.notEqual(taskSpawns[0].env.HERMES_HOME, taskSpawns[1].env.HERMES_HOME);

    // Slot 2's config.yaml must name ITS OWN endpoint/model — this is the
    // mechanism that makes a cross-provider slot reachable at all, since
    // Hermes reads model.base_url from config.yaml, not OPENAI_BASE_URL.
    assert.match(taskSpawns[1].configYaml || '', /provider:\s*openai-api/);
    assert.match(taskSpawns[1].configYaml || '', /base_url:\s*https:\/\/model\.inferx\.net\/endpoints\/v1/);
    assert.match(taskSpawns[1].configYaml || '', /default:\s*Qwen3-Coder-Next-FP8/);

    // Thrown away right after — nothing MYTHOS-managed persists on disk.
    assert.equal(fs.existsSync(taskSpawns[0].env.HERMES_HOME), false);
    assert.equal(fs.existsSync(taskSpawns[1].env.HERMES_HOME), false);
  });

  it('a per-attempt HERMES_HOME never carries an .env — the override=True shadow cannot reach it', async () => {
    wireTwoSlots();
    script['*'] = { stdout: 'THE ARTIFACT', code: 0 };
    await hermes.runTask('x', { requireCli: true });
    const taskSpawns = spawns.filter((s) => s.args[0] === '-z');
    assert.equal(taskSpawns[0].hadDotEnv, false, 'the attempt home must not carry a .env at spawn time');
  });

  it('rotates on a 429 — the dominant real failure, since free tiers rate-limit before they fail auth', async () => {
    wireTwoSlots();
    script['slot1-key'] = { stdout: 'API call failed after 3 retries: HTTP 429: Rate limit exceeded', code: 0 };
    script['slot2-key'] = { stdout: 'THE ARTIFACT', code: 0 };

    const rotations = [];
    hermes.onProviderRotated((e) => rotations.push(e));

    const reply = await hermes.runTask('build a thing', { requireCli: true });
    assert.equal(reply, 'THE ARTIFACT');
    assert.equal(rotations.length, 1);
    assert.equal(rotations[0].to, 2);
  });

  it('rotates on a non-zero exit and on a spawn error (both provider-class)', async () => {
    wireTwoSlots();
    script['slot1-key'] = { stderr: 'boom', code: 3 };
    script['slot2-key'] = { stdout: 'THE ARTIFACT', code: 0 };
    assert.equal(await hermes.runTask('x', { requireCli: true }), 'THE ARTIFACT');

    spawns = [];
    script['slot1-key'] = { error: { message: 'spawn hermes ENOENT', code: 'ENOENT' } };
    assert.equal(await hermes.runTask('x', { requireCli: true }), 'THE ARTIFACT');
    assert.equal(spawns.filter((s) => s.args[0] === '-z').length, 2);
  });

  it('rotates on a timeout — a hung child is provider-class, not a bad prompt', async () => {
    wireTwoSlots();
    script['slot1-key'] = { hang: true };
    script['slot2-key'] = { stdout: 'THE ARTIFACT', code: 0 };
    const reply = await hermes.runTask('x', { requireCli: true, timeoutMs: 120 });
    assert.equal(reply, 'THE ARTIFACT');
  });

  // ---- must NOT rotate ----------------------------------------------------

  it('does NOT rotate on a prompt error — an empty prompt throws before any spawn', async () => {
    wireTwoSlots();
    await assert.rejects(() => hermes.runTask('   ', { requireCli: true }), /prompt required/);
    assert.equal(spawns.filter((s) => s.args[0] === '-z').length, 0);
  });

  it('does NOT rotate on a good reply that merely mentions an HTTP status mid-text', async () => {
    wireTwoSlots();
    script['slot1-key'] = { stdout: 'Handle the case where the API returns HTTP 401: retry with a fresh token.', code: 0 };
    const rotations = [];
    hermes.onProviderRotated((e) => rotations.push(e));
    const reply = await hermes.runTask('x', { requireCli: true });
    assert.match(reply, /^Handle the case/);
    assert.equal(rotations.length, 0, 'the error regex is anchored to the start of the reply for exactly this reason');
    assert.equal(spawns.filter((s) => s.args[0] === '-z').length, 1);
  });

  // ---- exhaustion ---------------------------------------------------------

  it('when every slot fails, the last error propagates (build-engine still gets its brain fallback)', async () => {
    wireTwoSlots();
    script['*'] = { stdout: 'HTTP 500: upstream exploded', code: 0 };
    await assert.rejects(() => hermes.runTask('x', { requireCli: true }), /HTTP 500/);
    assert.equal(spawns.filter((s) => s.args[0] === '-z').length, 2, 'every slot must be tried before giving up');
  });

  // ---- one definition of the error shape ---------------------------------

  it('the adapter still owns its error regex, and build-engine no longer imports it', () => {
    // W6 (2026-08-22): build-engine.js used to import this regex, so there was
    // exactly one definition shared by two consumers. It now has ONE consumer —
    // the Hermes adapter's own rotation logic, tested throughout this file — and
    // build-engine deliberately re-exports nothing, because dsh's exit code is
    // its oracle and a speculative detector there would be a guard that never
    // fires. See build-engine.test.js for the pinned disposition.
    const buildEngine = require('../src/core/effectors/build-engine');
    assert.ok(hermes.HERMES_ERROR_REPLY_RE instanceof RegExp,
      'the adapter still needs it for rotation while the adapter exists');
    assert.equal(buildEngine.HERMES_ERROR_REPLY_RE, undefined,
      'build-engine must not carry a regex for a failure mode dsh does not have');
  });
});
