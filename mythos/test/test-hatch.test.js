'use strict';

// test/test-hatch.test.js — the four locks on server/test-hatch.js.
//
// The hatch lets a harness invoke ONE named tool against a RUNNING MYTHOS, which
// is the only way to verify the packaged .exe: all 34 verify-*.js scripts reach
// MYTHOS through verify-lib's bootMythos(), which spawns a fresh DEV-TREE
// process, so none of them has ever exercised the installed application. BUG-360
// is what that costs — an installer shipped with all 14 phone_* tools absent and
// every existing check passing.
//
// A test entrance is a privilege surface, so each lock gets its own test AND its
// own negative: it is not enough that a legitimate call works, it must be shown
// that removing any single lock is caught. Every case below drives handleCommand
// directly with fake deps — no server, no socket, no leash, no effectors — so
// what is asserted is the gate logic itself rather than a machine's state.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hatch = require('../server/test-hatch.js');

const LOOPBACK = { remoteAddress: '127.0.0.1' };

// Records everything the hatch did, so a test can assert on what did NOT happen —
// which for a privilege gate is the more important half.
function rig(overrides) {
  const state = { sent: [], leashCalls: [], dispatchCalls: [], warns: [] };
  const deps = Object.assign({
    send: (frame) => state.sent.push(frame),
    leash: {
      check: (decision, ctx) => {
        state.leashCalls.push({ decision, ctx });
        return { allow: true, tier: 2, reason: null };
      },
    },
    dispatchAction: async (decision, ctx) => {
      state.dispatchCalls.push({ decision, ctx });
      return { ok: true, evidence: 'did the thing' };
    },
    connectionId: 'conn-1',
    socket: LOOPBACK,
    env: { MYTHOS_TEST_HATCH: '1' },
    logger: { warn: (m, d) => state.warns.push({ m, d }) },
  }, overrides || {});
  return { state, deps };
}

const CALL = { type: 'command', reqId: 'r1', tool: 'media_key', args: { key: 'play_pause' } };

describe('lock 1 — the hatch is off unless the environment says otherwise', () => {
  it('an unset flag answers exactly as the old stub did, and executes nothing', async () => {
    // A packaged install sets no such variable, so this IS the shipped
    // behaviour. It must not disclose that a hatch exists, and it must not
    // change what a `command` frame has always replied — the type was routed and
    // answered long before the hatch, and changing that under a feature flag
    // would be a behaviour change smuggled in sideways.
    const { state, deps } = rig({ env: {} });
    await hatch.handleCommand({ type: 'command', reqId: 'r1', command: 'ping', tool: 'media_key' }, deps);

    assert.deepEqual(state.sent, [{ type: 'done', reqId: 'r1', command: 'ping' }]);
    assert.equal(state.leashCalls.length, 0);
    assert.equal(state.dispatchCalls.length, 0, 'a disabled hatch must not execute anything');
  });

  it('only the exact string "1" arms it', async () => {
    for (const value of ['0', 'true', 'yes', 'on', '', ' 1', '1 ']) {
      assert.equal(hatch.hatchEnabled({ MYTHOS_TEST_HATCH: value }), false,
        `MYTHOS_TEST_HATCH=${JSON.stringify(value)} must not arm the hatch`);
    }
    assert.equal(hatch.hatchEnabled({ MYTHOS_TEST_HATCH: '1' }), true);
    assert.equal(hatch.hatchEnabled({}), false, 'the packaged default is off');
  });

  it('is not a config-schema key, so config.json cannot turn it on', () => {
    // Deliberate. Schema keys are settable from config.json, which a packaged
    // install carries and an operator can be talked into editing; an environment
    // variable has to be set by whoever launched the process.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'config', 'schema.js'), 'utf8');
    assert.doesNotMatch(schema, /MYTHOS_TEST_HATCH/,
      'the hatch flag must stay out of the config schema — see server/test-hatch.js');
  });

  it('a command frame carrying no tool keeps the old behaviour even when armed', async () => {
    const { state, deps } = rig();
    await hatch.handleCommand({ type: 'command', reqId: 'r1', command: 'ping' }, deps);
    assert.deepEqual(state.sent, [{ type: 'done', reqId: 'r1', command: 'ping' }]);
    assert.equal(state.dispatchCalls.length, 0);
  });
});

describe('lock 2 — loopback only', () => {
  it('refuses a non-loopback peer even with the flag on, and executes nothing', async () => {
    // NOT redundant with the auth token, which is the easy mistake here. The
    // documented phone-node setup tells the operator to bind 0.0.0.0 and hand
    // the token to the phone — so on precisely the machines that followed the
    // docs, "has the token" stops implying "is sitting at this desk".
    const { state, deps } = rig({ socket: { remoteAddress: '192.168.1.50' } });
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].error, true);
    assert.match(state.sent[0].refused, /loopback/i);
    assert.equal(state.leashCalls.length, 0, 'a remote caller must not even reach the leash');
    assert.equal(state.dispatchCalls.length, 0);
    assert.equal(state.warns.length, 1, 'a refused remote call is worth a log line');
  });

  it('accepts every real shape of a local address', () => {
    // ::ffff:127.0.0.1 is what a dual-stack listener reports for an IPv4 client.
    // Rejecting it would make the hatch unreachable on the very default bind
    // (127.0.0.1) it exists for.
    for (const addr of ['127.0.0.1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::1', '127.0.0.2', 'localhost']) {
      assert.equal(hatch.isLoopbackAddress(addr), true, `${addr} is local`);
    }
  });

  it('treats an unreadable address as remote, never as local', () => {
    // An address we cannot parse is not evidence that the caller is local. This
    // is the direction the default has to fail in.
    for (const addr of ['192.168.1.50', '10.0.0.5', '0.0.0.0', '', null, undefined, 42, {}, '127.0.0.999', 'evil127.0.0.1']) {
      assert.equal(hatch.isLoopbackAddress(addr), false, `${JSON.stringify(addr)} must not count as local`);
    }
  });

  it('reads the peer address off a live ws object too, not just a plain socket', () => {
    // Production passes the ws itself; the underlying net.Socket hangs off
    // ws._socket. Getting this wrong would make every real call look remote —
    // fail-closed, so it would present as "the hatch does not work" rather than
    // as a hole, but it would still be broken.
    const { state, deps } = rig({ socket: { _socket: { remoteAddress: '::ffff:127.0.0.1' } } });
    return hatch.handleCommand(CALL, deps).then(() => {
      assert.equal(state.dispatchCalls.length, 1, 'a ws-shaped socket must resolve to its underlying peer');
    });
  });
});

describe('lock 3 — the leash still applies', () => {
  it('asks the leash before dispatching, with the real tool and connection', async () => {
    const { state, deps } = rig();
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.leashCalls.length, 1);
    assert.deepEqual(state.leashCalls[0].decision, { tool: 'media_key', args: { key: 'play_pause' } });
    assert.equal(state.leashCalls[0].ctx.connectionId, 'conn-1',
      'the real connection id must be threaded — a synthetic constant would make any session grant apply to every caller');
  });

  it('refuses a denied tool and does not dispatch it', async () => {
    const { state, deps } = rig({
      leash: { check: () => ({ allow: false, reason: 'tier 4 is above the ceiling', tier: 4 }) },
    });
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.sent[0].error, true);
    assert.equal(state.sent[0].refused, 'tier 4 is above the ceiling');
    assert.equal(state.dispatchCalls.length, 0, 'a denied tool must never reach dispatch');
  });

  it('REPORTS a required confirm and never satisfies it', async () => {
    // The load-bearing one. A confirm means a human said yes; a harness
    // answering on their behalf would run every T3/T4 tool unattended AND would
    // stop this from testing the operator's real ceiling, which is the thing the
    // packaged app is most likely to differ on.
    const { state, deps } = rig({
      leash: { check: () => ({ allow: false, requireConfirm: true, reason: 'needs your approval', tier: 3 }) },
    });
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.sent[0].requireConfirm, true);
    assert.equal(state.sent[0].error, true);
    assert.equal(state.dispatchCalls.length, 0, 'requireConfirm must not be auto-approved by the hatch');
  });

  it('refuses when the leash itself throws, rather than falling through to dispatch', async () => {
    // Fail closed. An exception evaluating the gate is not permission.
    const { state, deps } = rig({ leash: { check: () => { throw new Error('boundaries.md unreadable'); } } });
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.sent[0].error, true);
    assert.match(state.sent[0].refused, /boundaries\.md unreadable/);
    assert.equal(state.dispatchCalls.length, 0);
  });

  it('refuses when the server did not wire a leash at all', async () => {
    const { state, deps } = rig({ leash: null });
    await hatch.handleCommand(CALL, deps);
    assert.equal(state.sent[0].error, true);
    assert.equal(state.dispatchCalls.length, 0);
  });
});

describe('lock 4 — through dispatchAction, never a raw invoke', () => {
  it('dispatches an allowed tool with the leash tier and its own channel', async () => {
    const { state, deps } = rig();
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.dispatchCalls.length, 1);
    assert.deepEqual(state.dispatchCalls[0].decision, { tool: 'media_key', args: { key: 'play_pause' } });
    assert.equal(state.dispatchCalls[0].ctx.tier, 2, 'the tier must come from the leash verdict, not from the caller');
    assert.equal(state.dispatchCalls[0].ctx.channel, 'test-hatch',
      'a distinct channel keeps harness-driven calls separable from voice and cortex ones in the audit');
    assert.deepEqual(state.sent[0].result, { ok: true, evidence: 'did the thing' });
  });

  it('never accepts a tier or channel from the caller', async () => {
    // The frame is attacker-shaped input as far as this file is concerned: it
    // arrives over a socket. A tier supplied on the wire would make lock 3
    // decorative.
    const { state, deps } = rig();
    await hatch.handleCommand(Object.assign({}, CALL, { tier: 0, channel: 'voice' }), deps);
    assert.equal(state.dispatchCalls[0].ctx.tier, 2);
    assert.equal(state.dispatchCalls[0].ctx.channel, 'test-hatch');
  });

  it('reports a dispatch failure instead of throwing into the socket handler', async () => {
    const { state, deps } = rig({ dispatchAction: async () => { throw new Error('effector exploded'); } });
    await hatch.handleCommand(CALL, deps);

    assert.equal(state.sent[0].error, true);
    assert.match(state.sent[0].say, /effector exploded/);
  });

  it('coerces a non-object args to an empty object rather than passing it through', async () => {
    const { state, deps } = rig();
    await hatch.handleCommand({ type: 'command', reqId: 'r1', tool: 'media_key', args: 'not-an-object' }, deps);
    assert.deepEqual(state.dispatchCalls[0].decision.args, {});
  });
});

describe('the wiring in server/index.js', () => {
  const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

  it('routes the command frame through the hatch module', () => {
    const handler = /function handleCommand\(msg\)[\s\S]{0,400}?\n    \}/.exec(INDEX);
    assert.ok(handler, 'server/index.js must still define handleCommand');
    assert.match(handler[0], /require\('\.\/test-hatch'\)\.handleCommand\(/);
  });

  it('hands the hatch the leash and dispatchAction, not the effector hub', () => {
    // The single-execution-surface rule. server/routes/media.js records what the
    // alternative costs: its raw effectors.invoke left 42 of 43 media_key calls
    // with no outcome recorded anywhere.
    const handler = /function handleCommand\(msg\)[\s\S]{0,400}?\n    \}/.exec(INDEX);
    assert.match(handler[0], /leash/);
    assert.match(handler[0], /dispatchAction/);
    assert.doesNotMatch(handler[0], /effectors\.invoke/,
      'the hatch must never be handed a raw invoke path');
  });

  it('passes the live socket so the loopback check has something real to read', () => {
    // Without this the address is undefined, isLoopbackAddress returns false and
    // the hatch refuses everything. Fail-closed, but silently useless — and a
    // "the hatch does not work" report is exactly the kind of thing that gets
    // fixed by deleting the check.
    const handler = /function handleCommand\(msg\)[\s\S]{0,400}?\n    \}/.exec(INDEX);
    assert.match(handler[0], /socket:\s*ws/);
  });
});
