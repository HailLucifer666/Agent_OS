'use strict';

// bug-457-residuals.test.js — the two residuals the attended run of 2026-09-25
// found in BUG-457's held-reply fix (BUGS.md, BUG-457, "Attended session
// 2026-09-25"). Written red-first on 2026-10-06.
//
// R1 — DOUBLE DELIVERY. 02:12:44.704 Gemini issued think_deeply + use_skill;
// 131 ms later the operator's words closed the turn (live.turn-parts turnId=6
// scFields=inputTranscription,interrupted,turnComplete). No toolCallCancellation
// arrived. think_deeply was held 569 ms past the 1.5 s deadline and ended
// `end=outcome`, so its real result went out as the tool response — and ALSO as
// a late-for-turn [SYSTEM] notice (live.text-injected site=late-for-turn
// tool=think_deeply at 02:12:46.780), because commitAction's late branch only
// knew `entry.started`, which is false for a held reply.
//
// R2 — SLOW_TOOLS STILL CUT IN. screen_look sat on the hand list, so it was
// answered "started" at once and its result arrived as user-role text 6 of 6
// times, each 3.5-4.6 s after the call: inside the 12 s hold window.
//
// RED FIRST, 2026-10-06, against the unfixed adapter and held-reply.js: 8 of 11
// red ((a) late-for-turn 1, expected 0; (b) 2 notices, expected 1; (d)/(e)
// ['started'], expected ['ok']; (f), (h), (j), (k)); (c), (g), (i) green, as
// adjacent cases should be.
//
// MUTATION PROBES, 2026-10-06. Each applied once by string replacement that had to
// match exactly once, the file hash checked as changed, this file and
// bug-457-held-reply.test.js run (26 tests), restored from a copy, hash verified.
// Seven probes, seven red:
//   P1 commitAction's late branch ignores the held set
//      (`&& !answeredByHeldReply(..)` removed)              -> (a), (b) red
//   P2 the held set is never written (heldAnswered.push removed)
//                                     -> (a), (b), and bug-457-held-reply (k) red
//   P3 SLOW_TOOLS routing ignores the route (`&& slowRoute.acksAtOnce(..)`
//      removed from the condition)                        -> (d), (e), (f), (h) red
//   P4 acksAtOnce compares `>= 0` instead of `> holdWindowMs` -> (f), (j) red
//   P5 the disabled-hold line in acksAtOnce removed       -> (g), (k) red
//   P6 timed() never records a duration                   -> (f), (j) red
//   P7 FIXTURE probe: (d)'s screen_look fake answers at once, so the hold is
//      never reached                                      -> (d) red, by name
// Timing: Windows timers are ~15 ms coarse and a loaded runner stalls; every
// timing margin here is several ticks wide, and (f) asserts holds by their log
// line, not by elapsed time (a 15 ms bound flaked 1 in ~6 on 2026-10-06).
// Adjacent cases that must keep passing: (c) a non-held late call keeps BUG-297's
// notice (pinned disposition), (f) a listed tool past the hold keeps today's path,
// (g) a disabled hold keeps the instant ack, (h) a cancellation during a
// screen_look hold keeps the safety net, (i) a fast tool is unchanged.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSlowToolRoute } = require('../src/core/voice/held-reply');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real adapter, real timers, small numbers (same rig shape as bug-457-held-reply).
function rig({ holdMaxMs = 400, deadlineMs = 20, dispatch, sendResult } = {}) {
  const responses = [];
  const texts = [];
  const dispatched = [];
  const logs = [];
  let cancelHandler = null;
  const adapter = createLiveToolAdapter({
    leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
    dispatchAction: (decision, ctx) => { dispatched.push(ctx.traceId); return dispatch(decision, ctx); },
    bus: { emit() {}, subscribe: (type, fn) => { if (type === 'voice.live.toolcancel') cancelHandler = fn; } },
    logger: { warn() {}, info: (msg, fields) => logs.push({ msg, ...fields }) }, connectionId: 'conn-457r',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult: () => null,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t, meta) => { texts.push({ t, site: meta && meta.site }); return true; } }),
    toolAckDeadlineMs: deadlineMs, toolResultHoldMaxMs: holdMaxMs,
  });
  const send = (r) => { responses.push(r); return sendResult === undefined ? true : sendResult; };
  const call = (name, id = 'call-' + name) => adapter.handleLiveToolCalls([{ id, name, args: { q: id } }], { sendToolResponse: send });
  const sites = (site) => texts.filter((x) => x.site === site).length;
  const heldEnds = (tool) => logs.filter((l) => l.msg === 'live.tool-held' && l.tool === tool).map((l) => l.end);
  return { adapter, responses, texts, dispatched, call, sites, heldEnds,
    cancel: (ids) => cancelHandler && cancelHandler({ type: 'voice.live.toolcancel', payload: { ids } }) };
}
const statusOf = (responses) => responses.flat().map((r) => r.response.status);

describe('R1 — a held reply is ONE terminal outcome, even when the turn closes under it', () => {
  it('(a) REPLAY 02:12:44: the operator closes the turn during the hold; the result goes out once, as the tool response', async () => {
    const r = rig({ dispatch: () => sleep(80).then(() => ({ ok: true, result: { text: 'it is 2:12 AM, not evening' } })) });
    const done = r.call('think_deeply');
    await sleep(5); // 131 ms after the call, scaled: the turn closes while the call is still running
    r.adapter.onLiveTurnComplete({ userText: 'He said good evening.', assistantText: '' });
    await done;
    await sleep(30);
    assert.deepEqual(statusOf(r.responses), ['ok'], 'the held reply carries the real result');
    assert.match(JSON.stringify(r.responses), /2:12 AM/);
    assert.equal(r.sites('late-for-turn'), 0, 'NOT also a late-for-turn notice: that second copy started an unprompted turn live');
    assert.equal(r.sites('late-outcome'), 0, 'and not a late-outcome notice either');
    assert.deepEqual(r.dispatched, ['call-think_deeply'], 'run once');
    assert.deepEqual(r.heldEnds('think_deeply'), ['outcome'], 'fixture: the call really was held, and the hold ended on its result');
  });

  it('(b) the same, but the session refuses the reply (rotation): delivered once, today\'s way', async () => {
    const r = rig({ sendResult: false, dispatch: () => sleep(80).then(() => ({ ok: true, result: { text: 'r' } })) });
    const done = r.call('think_deeply');
    await sleep(5);
    r.adapter.onLiveTurnComplete({ userText: 'He said good evening.', assistantText: '' });
    await done;
    await sleep(30);
    assert.equal(r.sites('late-outcome') + r.sites('late-for-turn'), 1, 'exactly one notice for a refused reply');
    assert.equal(r.sites('late-outcome'), 1, 'and it is the re-route of the refused reply');
  });

  it('(c) PINNED DISPOSITION — a call answered inside the ack deadline whose turn closed keeps BUG-297\'s late-for-turn notice', async () => {
    // Deliberately unchanged on 2026-10-06: nothing measured says whether Gemini
    // reads a NON-held toolResponse addressed to an interrupted turn (G3 says it
    // does not). Changing it is an operator decision, not this fix. See the
    // comment at commitAction's late branch.
    const r = rig({ deadlineMs: 500, dispatch: () => sleep(40).then(() => ({ ok: true, result: { text: 'loaded' } })) });
    const done = r.call('use_skill');
    await sleep(5);
    r.adapter.onLiveTurnComplete({ userText: 'He said good evening.', assistantText: '' });
    await done;
    assert.deepEqual(statusOf(r.responses), ['ok']);
    assert.equal(r.sites('late-for-turn'), 1);
  });
});

describe('R2 — a slow-listed tool that fits the hold window is held, not injected', () => {
  it('(d) REPLAY screen_look (3.5-4.6 s live, inside the 12 s window): one real reply, no "started", no injected text', async () => {
    const r = rig({ dispatch: () => sleep(80).then(() => ({ ok: true, result: { description: 'a terminal window' } })) });
    await r.call('screen_look');
    assert.deepEqual(statusOf(r.responses), ['ok'], 'answered with its real result as a tool response');
    assert.deepEqual(r.heldEnds('screen_look'), ['outcome'], 'through the HOLD, not a fast answer inside the ack deadline');
    await sleep(30);
    assert.equal(r.sites('late-outcome'), 0, 'no user-role injection: that is what cut MYTHOS mid-sentence 6 of 6 times');
  });

  it('(e) camera_look, the other half of the vision pair, likewise', async () => {
    const r = rig({ dispatch: () => sleep(80).then(() => ({ ok: true, result: { description: 'a person' } })) });
    await r.call('camera_look');
    assert.deepEqual(statusOf(r.responses), ['ok']);
    await sleep(30);
    assert.equal(r.sites('late-outcome'), 0);
  });

  it('(f) ADJACENT — past the window it keeps today\'s path, and that MEASURED overrun makes the next call ack at once', async () => {
    let ms = 400; // Windows timers are ~15 ms coarse: every margin here is several ticks wide
    const r = rig({ holdMaxMs: 200, dispatch: () => sleep(ms).then(() => ({ ok: true, result: { text: 'r' } })) });
    await r.call('screen_look', 'c1');
    assert.deepEqual(statusOf(r.responses), ['started'], 'held to the window, then "started"');
    await sleep(300);
    assert.equal(r.sites('late-outcome'), 1, 'the result arrives once, on today\'s path');
    ms = 10;
    await r.call('screen_look', 'c2');
    assert.deepEqual(r.heldEnds('screen_look'), ['hold-max'], 'acked at once: no second hold for a tool this session measured past the window');
    assert.deepEqual(statusOf(r.responses), ['started', 'started']);
    await sleep(40);
    ms = 90; // past the 20 ms ack deadline, inside the 200 ms window: a real hold
    await r.call('screen_look', 'c3');
    assert.deepEqual(statusOf(r.responses), ['started', 'started', 'ok'], 'its last run fitted again, so it is held again');
    assert.deepEqual(r.heldEnds('screen_look'), ['hold-max', 'outcome']);
  });

  it('(g) ADJACENT — with the hold switched off (toolResultHoldMaxMs: 0) a listed tool still acks at once', async () => {
    const r = rig({ holdMaxMs: 0, deadlineMs: 5000, dispatch: () => new Promise(() => {}) });
    const t0 = Date.now();
    await r.call('screen_look');
    assert.ok(Date.now() - t0 < 2500, 'at once, not after the 5 s ack deadline (wide: a loaded runner stalls for 100s of ms)');
    assert.deepEqual(statusOf(r.responses), ['started']);
  });

  it('(h) ADJACENT — a cancellation during a screen_look hold keeps the safety net', async () => {
    const r = rig({ dispatch: () => sleep(120).then(() => ({ ok: true, result: { description: 'd' } })) });
    const done = r.call('screen_look');
    await sleep(40);
    r.cancel(['call-screen_look']);
    await done;
    assert.equal(r.sites('held-call-cancelled'), 1);
    assert.deepEqual(r.responses, [], 'no reply for a cancelled id');
    await sleep(150);
    assert.equal(r.sites('late-outcome'), 1, 'the real result still arrives, once');
  });

  it('(i) ADJACENT — a fast tool is unchanged: one reply, no wait', async () => {
    const r = rig({ deadlineMs: 500, dispatch: async () => ({ ok: true, result: { text: 'r' } }) });
    await r.call('get_time');
    assert.deepEqual(statusOf(r.responses), ['ok']);
    assert.equal(r.texts.length, 0);
  });
});

describe('R2 — createSlowToolRoute on its own', () => {
  it('(j) an unmeasured tool is held; a measured overrun acks at once; a measured fit is held again', async () => {
    let t = 0;
    const route = createSlowToolRoute({ holdWindowMs: 100, now: () => t });
    assert.equal(route.acksAtOnce('screen_look'), false, 'cold start: hold, the live measurements all fit');
    await route.timed('screen_look', Promise.resolve().then(() => { t = 150; }), 0);
    await sleep(0);
    assert.equal(route.acksAtOnce('screen_look'), true);
    t = 200;
    await route.timed('screen_look', Promise.reject(new Error('x')).catch(() => { t = 260; return Promise.reject(new Error('x')); }), 200).catch(() => {});
    await sleep(0);
    assert.equal(route.acksAtOnce('screen_look'), false, 'a failure is a run too: 60 ms fits');
    assert.equal(route.acksAtOnce('launch_app'), false, 'per tool');
  });

  it('(k) a disabled hold always acks at once, and timed() hands back the same promise', () => {
    const route = createSlowToolRoute({ holdWindowMs: 0 });
    assert.equal(route.acksAtOnce('screen_look'), true);
    const p = Promise.resolve(1);
    assert.equal(route.timed('x', p, 0), p);
  });
});
