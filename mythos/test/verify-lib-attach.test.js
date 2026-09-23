'use strict';

// test/verify-lib-attach.test.js — attach mode, deterministic tool dispatch, and
// the packaged sweep's verdicts.
//
// WHY THIS CODE EXISTS AT ALL: all 34 scripts/verify-*.js harnesses reach MYTHOS
// through verify-lib's bootMythos(), which spawns a fresh DEV-TREE process. Not
// one of them has ever exercised the installed application — the only thing the
// operator now runs. BUG-360 is the bill for that: an installer shipped with all
// 14 phone_* tools withheld from the model, and every check in the repo green.
//
// A harness is a measuring instrument, so the tests that matter here are the
// ones about it LYING — reporting a pass it did not earn. Two such bugs were
// found while building it and both are pinned below: the double-`ok` false green,
// and the disabled-hatch echo being mistaken for a result.
//
// THIS FILE ITSELF USED TO VANISH (2026-09-23). Roughly one run in three it
// died with `Unable to deserialize cloned data due to invalid or unsupported
// version` and no test named, and its later tests dropped out of the count
// (7903 -> 7891 in one full run). Not a flake: attachMythos's status line
// `🔌  attached to MYTHOS on port N` went to stdout, which under `node --test`
// is the runner's binary report channel, and Node 26.1's parser misreads text
// that follows a frame in the same pipe read as a negative frame length. The
// full byte-level account is on log() in scripts/verify-lib.js. Measured
// standalone, long-form TEMP: 6 of 15 runs failed before the fix, 0 of 30 after.
// The first describe block pins it, and sits first so that a regression reports
// there before a sibling test's write can take the file down again.
//
// Mutation probes, 2026-09-23, each applied to scripts/verify-lib.js, confirmed
// applied, run against this file, restored from a copy and checked by sha256:
//   (1) delete the NODE_TEST_CONTEXT gate in log()  -> fails (a) and (b); (c) green
//   (2) make log() silent everywhere                -> fails (c); (a) and (b) green
//   (3) add a raw console.log inside attachMythos   -> fails (b); (a) and (c) green
// Probe (3) is why (b) exists: (a) guards the helper, (b) guards the whole path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');

const lib = require('../scripts/verify-lib.js');
const sweep = require('../scripts/verify-packaged.js');

// A stand-in /health so attach can be tested without booting MYTHOS.
function fakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run attachMythos in a fresh node process whose stdout THIS test holds, so a
// write can be observed without it ever touching this file's report channel.
function attachInChild(port, env) {
  const script = `require(${JSON.stringify(require.resolve('../scripts/verify-lib.js'))})`
    + '.attachMythos({ port: Number(process.argv[1]), token: "" })'
    + '.then(() => process.exit(0), (e) => { console.error(e.message); process.exit(2); });';
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, String(port)], { env, timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`attach child failed: ${err.message}\n${stderr}`)) : resolve(stdout)));
  });
}

describe('stdout is the test runner\'s report channel — verify-lib must stay off it under test', () => {
  it('(a) log() writes nothing to stdout inside a node --test child', () => {
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'premise: node --test sets NODE_TEST_CONTEXT in each file\'s process — without it the gate in log() is inert');
    const writes = [];
    const realWrite = process.stdout.write;
    // Synchronous on purpose. Nothing can yield between patch and restore, so
    // none of the runner's own frames can be captured — or swallowed — here.
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      lib.log('🔌', 'attached to MYTHOS on port 0');
    } finally {
      process.stdout.write = realWrite;
    }
    assert.deepEqual(writes, [], 'a raw line on this stdout is parsed by the runner as a frame header');
  });

  it('(b) attachMythos end to end in a real process writes nothing to stdout under the runner', async () => {
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 1, authRequired: false }));
    });
    try {
      const stdout = await attachInChild(port, { ...process.env, NODE_TEST_CONTEXT: 'child-v8' });
      assert.equal(stdout, '');
    } finally {
      server.close();
    }
  });

  it('(c) the adjacent case that must keep passing: outside the runner a human still sees the status line', async () => {
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 1, authRequired: false }));
    });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    try {
      const stdout = await attachInChild(port, env);
      assert.match(stdout, new RegExp(`attached to MYTHOS on port ${port}`));
    } finally {
      server.close();
    }
  });
});

describe('parseHarnessTarget', () => {
  it('defaults to booting, not attaching', () => {
    // The safe default. A harness that silently attached would report on
    // whatever happened to be listening on 4478.
    const t = lib.parseHarnessTarget([], {});
    assert.equal(t.attach, false);
    assert.equal(t.port, lib.DEFAULT_PORT);
  });

  it('takes an optional port after --attach', () => {
    assert.deepEqual(lib.parseHarnessTarget(['--attach', '4999'], {}), { attach: true, port: 4999, token: '' });
    assert.equal(lib.parseHarnessTarget(['--attach'], {}).port, lib.DEFAULT_PORT);
  });

  it('does not swallow the next flag when --attach has no port', () => {
    // The bug this shape invites: a naive `port = argv[i+1]` turns
    // `--attach --token X` into port='--token', then the token goes missing and
    // the harness complains about authentication — a confusing error a long way
    // from its cause.
    const t = lib.parseHarnessTarget(['--attach', '--token', 'secret'], {});
    assert.equal(t.attach, true);
    assert.equal(t.port, lib.DEFAULT_PORT);
    assert.equal(t.token, 'secret');
  });

  it('falls back to the environment, and the flag wins over it', () => {
    const env = { MYTHOS_PORT: '5555', MYTHOS_AUTH_TOKEN: 'from-env' };
    assert.equal(lib.parseHarnessTarget([], env).port, 5555);
    assert.equal(lib.parseHarnessTarget([], env).token, 'from-env');
    assert.equal(lib.parseHarnessTarget(['--token', 'from-flag'], env).token, 'from-flag');
  });
});

describe('attachMythos', () => {
  it('attaches to a healthy server and reports no child', async () => {
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 12, authRequired: false }));
    });
    try {
      const handle = await lib.attachMythos({ port });
      assert.equal(handle.attached, true);
      assert.equal(handle.port, port);
      // The load-bearing field. killTree(child) returns immediately for null, so
      // a harness's existing cleanup becomes "never kill a server you did not
      // start" with no change on its side — and the operator's own session
      // survives the run.
      assert.equal(handle.child, null);
      assert.equal(typeof handle.getStdout, 'function', 'harnesses call this on failure paths');
    } finally {
      server.close();
    }
  });

  it('killTree does nothing when handed an attached handle\'s null child', async () => {
    await lib.killTree(null); // must resolve, not throw
    assert.ok(true);
  });

  // BUG-413 (2026-09-09): this test used to pass only on machines WITHOUT a
  // User-scope MYTHOS_AUTH_TOKEN. attachMythos read `opts.token || env`, so the
  // explicit '' below fell through to the host's token and the attach succeeded.
  // The fixture now sets the env var deliberately, so the assertion is about the
  // contract ("explicit empty means none") rather than about the host.
  // Probe, run 2026-09-09 with MYTHOS_AUTH_TOKEN set in the shell: restoring the
  // `||` fallback fails (a) with "Missing expected rejection" and leaves (b)
  // green; deleting the env fallback entirely fails (b) with the rejection.
  it('fails loudly when the server wants a token and none was given — (a) explicit empty ignores the host env', async () => {
    // Otherwise this surfaces much later as a puzzling WS 401 in the middle of a
    // harness, pointing at the tool rather than at the missing flag.
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 3, authRequired: true }));
    });
    const saved = process.env.MYTHOS_AUTH_TOKEN;
    process.env.MYTHOS_AUTH_TOKEN = 'host-token-that-must-not-be-used';
    try {
      await assert.rejects(
        () => lib.attachMythos({ port, token: '' }),
        /requires MYTHOS_AUTH_TOKEN/);
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_AUTH_TOKEN; else process.env.MYTHOS_AUTH_TOKEN = saved;
      server.close();
    }
  });

  it('an OMITTED token still falls back to MYTHOS_AUTH_TOKEN in the environment — (b) the adjacent case that must keep passing', async () => {
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 3, authRequired: true }));
    });
    const saved = process.env.MYTHOS_AUTH_TOKEN;
    process.env.MYTHOS_AUTH_TOKEN = 'from-the-environment';
    try {
      const handle = await lib.attachMythos({ port });
      assert.equal(handle.attached, true);
      assert.equal(handle.token, 'from-the-environment');
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_AUTH_TOKEN; else process.env.MYTHOS_AUTH_TOKEN = saved;
      server.close();
    }
  });

  it('refuses a non-200 /health instead of attaching to it', async () => {
    const { server, port } = await fakeServer((req, res) => { res.writeHead(503); res.end('nope'); });
    try {
      await assert.rejects(() => lib.attachMythos({ port }), /attach failed/);
    } finally {
      server.close();
    }
  });

  it('refuses when nothing is listening', async () => {
    // Port 1 is privileged and unbound; the point is the error names the port
    // and the likely cause rather than surfacing a bare ECONNREFUSED.
    await assert.rejects(() => lib.attachMythos({ port: 1, timeoutMs: 2000 }), /Is MYTHOS running on port 1\?/);
  });

  // BUG-367 (2026-08-27). The assertion above raced two of attachMythos's OWN
  // failure modes and only one of them satisfied it. Port 1 normally refuses
  // instantly, taking the 'error' path, whose message ends "Is MYTHOS running
  // on port 1?". Under full-suite load the connect attempt can instead reach
  // the 2000ms deadline and take the 'timeout' path, which said only
  // "attach failed: /health timed out after 2000ms on port 1" — no hint, so
  // the regex missed and the test failed. It blocked a commit in two
  // independent sessions on different trees, hours apart, always inside a hook
  // run and never in isolation, which is what made it read as flakiness.
  //
  // Fixed in the SOURCE rather than by loosening the assertion: both rejection
  // paths now carry the same hint, so there is one failure contract instead of
  // two and the outcome no longer depends on which path wins. This test pins
  // the timeout path deterministically — a server that accepts the connection
  // and never answers cannot take the 'error' path at all.
  it('names the port and the likely cause when /health hangs, not only when it is refused', async () => {
    const { server, port } = await fakeServer(() => { /* accept, never respond */ });
    try {
      await assert.rejects(
        () => lib.attachMythos({ port, timeoutMs: 150 }),
        (err) => {
          assert.match(err.message, /timed out/, 'the timeout path must still say it timed out');
          assert.match(err.message, new RegExp(`Is MYTHOS running on port ${port}\\?`),
            'the timeout path must carry the same hint as the refused path');
          return true;
        },
      );
    } finally {
      server.close();
    }
  });
});

describe('interpretDoneFrame — what a reply is allowed to mean', () => {
  it('reads a plain success', () => {
    const r = lib.interpretDoneFrame({ type: 'done', reqId: 'x', tool: 'get_time', tier: 0, result: { ok: true, result: { iso: 'now' } } });
    assert.equal(r.ok, true);
    assert.equal(r.tool, 'get_time');
  });

  it('does NOT read an effector failure as a success — the double-ok false green', () => {
    // Found live. The frame arriving without `error` means the DISPATCH
    // succeeded: the tool was found, allowed and called. The effector's own
    // verdict is inside result.ok, and an effector rejecting its arguments
    // returns {ok:false, result:'A path is required.'} through a perfectly
    // successful dispatch. Reading only the outer layer made the sweep print
    //     [PASS] search_files   A path is required.
    // a green row whose own payload said it had failed.
    const r = lib.interpretDoneFrame({
      type: 'done', reqId: 'x', tool: 'search_files', tier: 0,
      result: { ok: false, result: 'A path is required.' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.effectorFailed, true);
    assert.equal(r.error, 'A path is required.', 'the effector\'s own words must survive to the report');
  });

  it('reads an {ok:false, error} payload too, not only the string form', () => {
    const r = lib.interpretDoneFrame({ type: 'done', reqId: 'x', tool: 't', result: { ok: false, error: 'adapter offline' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'adapter offline');
  });

  it('recognises the legacy echo as a DISABLED HATCH, not as a result', () => {
    // The other false green. With MYTHOS_TEST_HATCH unset the server replies
    // {type:'done', reqId, command}. A harness that accepted that would report a
    // fully green sweep against a server that executed nothing at all.
    const r = lib.interpretDoneFrame({ type: 'done', reqId: 'x', command: 'ping' });
    assert.equal(r.ok, false);
    assert.equal(r.hatchDisabled, true);
    assert.match(r.error, /MYTHOS_TEST_HATCH=1/, 'the message must name the remedy, not just the symptom');
  });

  it('surfaces a leash refusal with its confirm flag intact', () => {
    const r = lib.interpretDoneFrame({ type: 'done', reqId: 'x', error: true, refused: 'tier-3-requires-confirm', requireConfirm: true, tier: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.requireConfirm, true);
    assert.equal(r.tier, 3);
  });
});

describe('the packaged sweep\'s verdicts', () => {
  const probe = { area: 'phone bridge', tool: 'phone_list_devices', args: {} };

  it('passes a working tool', () => {
    assert.equal(sweep.classify(probe, { ok: true, result: { ok: true, result: { devices: [] } } }).verdict, sweep.PASS);
  });

  it('calls a tool the server does not offer WITHHELD, not merely failed', () => {
    // The BUG-360 shape, and it earns its own verdict because it is a
    // categorically different problem from a tool that ran and failed: the
    // adapter is down, its tools are withheld from the capability snapshot, and
    // the model is told they do not EXIST. That is why it read as a missing
    // feature for weeks instead of as a bug.
    const v = sweep.classify(probe, { ok: false, error: 'unknown tool: phone_list_devices' });
    assert.equal(v.verdict, sweep.WITHHELD);
  });

  it('calls a known degraded mode DEGRADED, not FAIL', () => {
    // browser-agent is offline until browser_launch_debug runs. A report that is
    // red for an expected reason is a report people stop reading.
    const browser = { area: 'browser', tool: 'browser_get_title', args: {}, expectOffline: true, why: 'debug browser not running' };
    const v = sweep.classify(browser, { ok: false, error: 'CDP connect failed' });
    assert.equal(v.verdict, sweep.DEGRADED);
    assert.match(v.note, /debug browser not running/);
  });

  it('fails a probe that unexpectedly needs a confirm', () => {
    // Every probe must be Tier 0. One that asks for a confirm is a probe-list
    // mistake, and saying so is more useful than reporting the tool as broken.
    const v = sweep.classify(probe, { ok: false, requireConfirm: true, tier: 3, error: 'tier-3-requires-confirm' });
    assert.equal(v.verdict, sweep.FAIL);
    assert.match(v.note, /must be Tier 0/);
  });

  it('fails loudly when the hatch is disabled', () => {
    const v = sweep.classify(probe, { ok: false, hatchDisabled: true, error: 'legacy echo — start with MYTHOS_TEST_HATCH=1' });
    assert.equal(v.verdict, sweep.FAIL);
    assert.match(v.note, /MYTHOS_TEST_HATCH=1/);
  });

  it('every probe is read-only and none is a danger tool', () => {
    // Guard-the-guard, and the one that protects the operator rather than the
    // report. This sweep runs against their REAL install: real vault, real
    // desktop, real phone. Tier is read from the live table, so a probe cannot
    // become dangerous later through a re-tier elsewhere without failing here.
    const { TIER_TABLE } = require('../src/core/leash/tiers.js');
    for (const p of sweep.PROBES) {
      assert.equal(TIER_TABLE[p.tool], 0,
        `probe ${p.tool} is tier ${TIER_TABLE[p.tool]} — every probe must be Tier 0 and read-only`);
    }
  });

  it('probe args use the parameter names the effectors actually register', () => {
    // search_files takes {root, pattern}. The first draft guessed {path, query}
    // and the guess was reported as a PASS whose own note read "A path is
    // required." Args are copied from the effector's registered `params`, never
    // invented — so this pins the two that a guess would get wrong.
    const search = sweep.PROBES.find((p) => p.tool === 'search_files');
    assert.deepEqual(Object.keys(search.args).sort(), ['pattern', 'root']);
    const folder = sweep.PROBES.find((p) => p.tool === 'list_folder');
    assert.deepEqual(Object.keys(folder.args), ['path']);
  });
});
