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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const lib = require('../scripts/verify-lib.js');
const sweep = require('../scripts/verify-packaged.js');

// A stand-in /health so attach can be tested without booting MYTHOS.
function fakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

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

  it('fails loudly when the server wants a token and none was given', async () => {
    // Otherwise this surfaces much later as a puzzling WS 401 in the middle of a
    // harness, pointing at the tool rather than at the missing flag.
    const { server, port } = await fakeServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: 3, authRequired: true }));
    });
    try {
      await assert.rejects(
        () => lib.attachMythos({ port, token: '' }),
        /requires MYTHOS_AUTH_TOKEN/);
    } finally {
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
