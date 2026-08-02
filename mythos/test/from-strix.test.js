'use strict';

// from-strix.test.js — the security-scan effector's gates.
//
// This is the most dangerous effector in the tree: it runs a real autonomous
// pentest. The tests therefore concentrate on the REFUSALS, because a gate that
// silently fails open is how MYTHOS ends up scanning a target nobody authorized.
//
// A fake execFile is injected throughout — no real Strix, no Docker, no network.
// The point is the effector's decision-making, not Strix's behaviour.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fromStrix = require('../src/core/effectors/from-strix');
const { TIER_TABLE, tierOf } = require('../src/core/leash/tiers');

// A fake execFile. `probe` decides whether `strix --version` succeeds
// (installed), and `onRun` receives the real scan argv so a test can assert on
// it. Callbacks are (err, stdout, stderr).
function fakeExec(opts) {
  opts = opts || {};
  const calls = [];
  const fn = function(cmd, args, options, cb) {
    calls.push({ cmd, args, options });
    if (args[0] === '--version') {
      return cb(opts.installed === false ? new Error('not found') : null, 'strix 1.4.1\n', '');
    }
    if (opts.onRun) return opts.onRun(args, options, cb);
    return cb(null, opts.stdout || 'scan complete: 0 findings\n', opts.stderr || '');
  };
  fn.calls = calls;
  return fn;
}

function build(opts, config) {
  return fromStrix.buildTools({
    execFile: fakeExec(opts),
    config: Object.assign({ STRIX_LLM: 'openai/gpt-5.4', LLM_API_KEY: 'k' }, config || {}),
    logger: { debug() {}, info() {}, warn() {} }
  });
}

function scanFn(built) {
  return built.tools.filter(t => t.name === 'security_scan')[0].fn;
}

describe('from-strix — the authorization gate', function() {

  it('refuses without authorized_by, and says why', async function() {
    const res = await scanFn(build())({ target: 'https://staging.example.com' });
    assert.equal(res.ok, false);
    assert.equal(res.result.needsAuthorization, true);
    assert.match(res.result.error, /authorized_by/);
    assert.match(res.result.error, /permission/);
  });

  it('refuses an empty or whitespace authorized_by', async function() {
    for (const auth of ['', '   ', null]) {
      const res = await scanFn(build())({ target: 'https://x.example.com', authorized_by: auth });
      assert.equal(res.ok, false, 'must refuse authorized_by=' + JSON.stringify(auth));
      assert.equal(res.result.needsAuthorization, true);
    }
  });

  it('never runs strix when authorization is missing — the gate is before the spawn', async function() {
    const exec = fakeExec({});
    const built = fromStrix.buildTools({ execFile: exec, config: { STRIX_LLM: 'x', LLM_API_KEY: 'k' }, logger: { info() {}, warn() {}, debug() {} } });
    await scanFn(built)({ target: 'https://x.example.com' });   // no authorized_by
    const ranScan = exec.calls.some(c => c.args[0] !== '--version');
    assert.equal(ranScan, false, 'a refused call must not spawn strix at all, not even the probe-then-abort');
  });
});

describe('from-strix — target validation', function() {

  it('accepts a URL, a github repo and a local path', function() {
    assert.ok(fromStrix.validateTarget('https://app.example.com').target);
    assert.ok(fromStrix.validateTarget('https://github.com/org/repo').target);
    assert.ok(fromStrix.validateTarget('./local-app').target);
    assert.ok(fromStrix.validateTarget('/abs/path').target);
    assert.ok(fromStrix.validateTarget('C:\\code\\app').target);
  });

  it('rejects a bare word, an empty target, and shell metacharacters', function() {
    assert.match(fromStrix.validateTarget('justaword').error, /http\(s\) URL or a local path/);
    assert.match(fromStrix.validateTarget('').error, /non-empty/);
    assert.match(fromStrix.validateTarget('https://x.com; rm -rf /').error, /metachar/);
    assert.match(fromStrix.validateTarget('https://x.com && curl evil').error, /metachar/);
  });

  it('refuses a bad target even WITH authorization — both gates must pass', async function() {
    const res = await scanFn(build())({ target: 'notaurl', authorized_by: 'I own it' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /refused/);
  });
});

describe('from-strix — availability + config', function() {

  it('degrades to an install hint when strix is not installed', async function() {
    const res = await scanFn(build({ installed: false }))({ target: 'https://x.example.com', authorized_by: 'me' });
    assert.equal(res.ok, false);
    assert.equal(res.result.offline, true);
    assert.match(res.result.error, /pip install strix-agent/);
  });

  it('reports missing LLM config distinctly from missing Strix', async function() {
    const built = build({ installed: true }, { STRIX_LLM: '', LLM_API_KEY: '' });
    const res = await scanFn(built)({ target: 'https://x.example.com', authorized_by: 'me' });
    assert.equal(res.ok, false);
    assert.equal(res.result.misconfigured, true);
    assert.match(res.result.error, /STRIX_LLM/);
  });

  it('does not throw when the binary is absent — MYTHOS must boot without Strix', async function() {
    // The whole call resolves cleanly to a fail(), never a rejection.
    await assert.doesNotReject(async () => {
      await scanFn(build({ installed: false }))({ target: 'https://x.example.com', authorized_by: 'me' });
    });
  });
});

describe('from-strix — a run that reaches strix', function() {

  it('passes the target and headless flag, and returns unverified findings', async function() {
    let seenArgs = null;
    const built = build({
      installed: true,
      onRun: (args, options, cb) => { seenArgs = args; cb(null, 'FINDING: reflected XSS on /search\n', ''); }
    });
    const res = await scanFn(built)({ target: 'https://app.example.com', authorized_by: 'operator owns app.example.com' });
    assert.equal(res.ok, true, JSON.stringify(res.result));
    assert.equal(res.result.unverified, true,
      'Strix findings are the tool\'s claims — a bare ok:true would be spoken as confirmed vulnerabilities');
    assert.match(res.result.reason, /did not reproduce/);
    assert.match(res.result.stdout, /reflected XSS/);
    assert.equal(res.result.authorizedBy, 'operator owns app.example.com');
    assert.deepEqual(seenArgs.slice(0, 2), ['--target', 'https://app.example.com']);
    assert.ok(seenArgs.indexOf('-n') !== -1, 'headless flag must be passed by default');
  });

  it('does not leak the operator\'s LLM key into the argv, but passes it in env', async function() {
    let seenArgs = null, seenEnv = null;
    const built = build({
      installed: true,
      onRun: (args, options, cb) => { seenArgs = args; seenEnv = options.env; cb(null, 'ok', ''); }
    }, { STRIX_LLM: 'openai/gpt-5.4', LLM_API_KEY: 'super-secret-key' });
    await scanFn(built)({ target: 'https://x.example.com', authorized_by: 'me' });
    assert.equal(seenArgs.indexOf('super-secret-key'), -1, 'the key must never appear as a command-line argument');
    assert.equal(seenEnv.LLM_API_KEY, 'super-secret-key', 'the key must reach strix via the environment');
    assert.equal(seenEnv.STRIX_LLM, 'openai/gpt-5.4');
  });

  it('rejects a scan_mode outside the allowed set', async function() {
    const res = await scanFn(build({ installed: true }))({ target: 'https://x.example.com', authorized_by: 'me', scan_mode: 'nuclear' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /scan_mode must be/);
  });

  it('surfaces a failed run with its stderr rather than a bare success', async function() {
    const built = build({
      installed: true,
      onRun: (args, options, cb) => {
        const err = new Error('Command failed'); err.code = 1;
        cb(err, '', 'docker: daemon not running');
      }
    });
    const res = await scanFn(built)({ target: 'https://x.example.com', authorized_by: 'me' });
    assert.equal(res.ok, false);
    assert.match(res.result.stderr, /daemon not running/);
  });
});

describe('from-strix — tier', function() {
  it('security_scan is tier 3 and marked danger', function() {
    assert.equal(TIER_TABLE.security_scan, 3);
    assert.equal(tierOf('security_scan'), 3);
    const t = fromStrix.buildTools({ execFile: fakeExec({}), config: {}, logger: { info() {}, warn() {}, debug() {} } }).tools[0];
    assert.equal(t.danger, true);
    assert.equal(t.needs_result, true);
  });
});
