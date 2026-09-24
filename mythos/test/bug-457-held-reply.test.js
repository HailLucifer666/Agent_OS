'use strict';

// bug-457-held-reply.test.js — BUG-457. Found by the operator in the attended
// run of 2026-09-24: MYTHOS said aloud "user transcription failed, but I am still
// responding to what you said", twice, each time answering a late tool result
// that had arrived as user-role text with no speech behind it.
//
// THE FIX (src/core/voice/held-reply.js): a call that outruns the ack deadline is
// no longer answered "started" at 1.5 s. Its reply is held (at most 12 s, the
// bound tested live on the configured model) and then sent as a real tool
// response. The safety net, the operator's choice: typed words release the hold
// first; a cancellation tells the model the result is unknown; a rotation-refused
// reply and anything past 12 s take today's path. Measured live and pre-registered
// on 2026-09-24; the numbers are in BUGS.md (BUG-457, Proof) and the commit body.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createHeldReplies, TOOL_RESULT_HOLD_MAX_MS, cancelledNotice } = require('../src/core/voice/held-reply');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const stripComments = (t) => t.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const SERVER = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'));
const SESSION = fs.readFileSync(path.join(ROOT, 'src', 'core', 'voice', 'live-session.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-457 — held-reply.js on its own', () => {
  it('(a) a result inside the budget ends the hold as an outcome', async () => {
    const h = createHeldReplies();
    const r = await h.hold('c1', sleep(20).then(() => ({ ok: true })), 500);
    assert.equal(r.kind, 'outcome');
    assert.deepEqual(r.outcome, { ok: true });
    assert.equal(h.size, 0);
  });

  it('(b) past the budget it ends as hold-max (today\'s path takes over)', async () => {
    const h = createHeldReplies();
    // Raced, so a missing bound fails HERE by name instead of hanging the suite.
    const r = await Promise.race([h.hold('c2', new Promise(() => {}), 30), sleep(1000).then(() => ({ kind: 'never-ended' }))]);
    assert.equal(r.kind, 'hold-max', 'a hold must end on its own; an unbounded one keeps the operator in silence');
  });

  it('(c) a cancellation ends only the named hold; an unknown id changes nothing', async () => {
    const h = createHeldReplies();
    const p = h.hold('c3', new Promise(() => {}), 5000);
    assert.equal(h.cancel(['nope']), 0);
    assert.equal(h.cancel(['c3']), 1);
    assert.equal((await p).kind, 'cancelled');
  });

  it('(d) releaseAll answers synchronously, BEFORE it returns — typed words must go out after the reply', () => {
    const h = createHeldReplies();
    const order = [];
    h.hold('c4', new Promise(() => {}), 5000, { onRelease: () => order.push('reply-sent') });
    const n = h.releaseAll();
    order.push('typed-text-sent');
    assert.equal(n, 1);
    assert.deepEqual(order, ['reply-sent', 'typed-text-sent']);
  });

  it('(e) a failing tool ends the hold as an error, never a rejection; a late result after a cancel is ignored', async () => {
    const h = createHeldReplies();
    assert.equal((await h.hold('c5', Promise.reject(new Error('boom')), 500)).kind, 'error');
    let resolve;
    const p = h.hold('c6', new Promise((r) => { resolve = r; }), 5000);
    h.cancel(['c6']);
    resolve({ ok: true });
    assert.equal((await p).kind, 'cancelled');
  });

  it('(f) the default budget is the bound tested live, and the notice forbids guessing', () => {
    assert.equal(TOOL_RESULT_HOLD_MAX_MS, 12000);
    assert.match(cancelledNotice('web_search'), /NOT known yet: do not state, guess or invent it/);
  });
});

// The real adapter, real timers, small numbers.
function rig({ holdMaxMs = 400, deadlineMs = 20, dispatch, sendResult } = {}) {
  const responses = [];
  const texts = [];
  const waits = [];
  let cancelHandler = null;
  const adapter = createLiveToolAdapter({
    leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
    dispatchAction: dispatch,
    bus: { emit() {}, subscribe: (type, fn) => { if (type === 'voice.live.toolcancel') cancelHandler = fn; } },
    logger: { warn() {}, info() {} }, connectionId: 'conn-457',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult: () => null,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t, meta) => { texts.push({ t, site: meta && meta.site }); return true; } }),
    toolAckDeadlineMs: deadlineMs, toolResultHoldMaxMs: holdMaxMs,
    onToolWait: (e) => waits.push(e),
  });
  const send = (r) => { responses.push(r); return sendResult === undefined ? true : sendResult; };
  const call = (name = 'web_search') => adapter.handleLiveToolCalls([{ id: 'call-' + name, name, args: { query: 'q' } }], { sendToolResponse: send });
  return { adapter, responses, texts, waits, call, cancel: (ids) => cancelHandler && cancelHandler({ type: 'voice.live.toolcancel', payload: { ids } }) };
}
const statusOf = (responses) => responses.flat().map((r) => r.response.status);

describe('BUG-457 — the adapter holds the reply', () => {
  it('(g) REPLAY 09:28:07 web_search (result 2.1 s after the call): ONE real reply, no "started", no injected text', async () => {
    const r = rig({ dispatch: () => sleep(60).then(() => ({ ok: true, result: { text: 'Price starts at 52,542' } })) });
    await r.call();
    assert.equal(r.responses.length, 1, 'one toolResponse frame');
    assert.deepEqual(statusOf(r.responses).filter((s) => s === 'started'), [], 'the model is never told "started" for a result that came inside the hold');
    await sleep(30);
    assert.deepEqual(r.texts.filter((x) => x.site === 'late-outcome'), [], 'no user-role injection, which is what the model rationalised aloud');
    assert.deepEqual(r.waits, [{ callId: 'call-web_search', pending: true }, { callId: 'call-web_search', pending: false }],
      'the chime still covers the silent hold, and is settled by the real reply');
  });

  it('(h) past the hold it falls back to today\'s path: "started", then the late result as a notice', async () => {
    const r = rig({ holdMaxMs: 60, dispatch: () => sleep(150).then(() => ({ ok: true, result: { text: 'r' } })) });
    await Promise.race([r.call(), sleep(1000)]);
    assert.deepEqual(statusOf(r.responses), ['started'], 'answered "started" when the hold ran out, before the result');
    await sleep(200);
    assert.equal(r.texts.filter((x) => x.site === 'late-outcome').length, 1);
  });

  it('(i) a cancellation (the operator spoke) tells the model at once the result is unknown; the result follows later', async () => {
    const r = rig({ dispatch: () => sleep(120).then(() => ({ ok: true, result: { text: 'PAPAYA-42' } })) });
    const done = r.call();
    await sleep(40);
    r.cancel(['call-web_search']);
    await done;
    const cancelled = r.texts.filter((x) => x.site === 'held-call-cancelled');
    assert.equal(cancelled.length, 1, 'the safety net: without it the model invented a pickup code live (1 of 2)');
    assert.match(cancelled[0].t, /NOT known yet/);
    assert.deepEqual(r.responses, [], 'no reply for an id Google cancelled');
    await sleep(150);
    assert.equal(r.texts.filter((x) => x.site === 'late-outcome').length, 1, 'the real result still arrives');
  });

  it('(j) typed words release the hold: the "started" reply is sent synchronously, before releaseHeldReplies returns', async () => {
    const r = rig({ dispatch: () => sleep(120).then(() => ({ ok: true, result: { text: 'r' } })) });
    const done = r.call();
    await sleep(40);
    assert.equal(r.responses.length, 0, 'fixture: still held');
    assert.equal(r.adapter.releaseHeldReplies(), 1);
    assert.deepEqual(statusOf(r.responses), ['started'], 'sent BEFORE the typed text can go out, so the text cannot cancel the call');
    await done;
    assert.equal(r.responses.length, 1, 'and never sent twice');
    await sleep(150);
    assert.equal(r.texts.filter((x) => x.site === 'late-outcome').length, 1);
  });

  it('(k) a held reply the session refuses (a rotation) is delivered today\'s way instead of lost', async () => {
    const r = rig({ sendResult: false, dispatch: () => sleep(40).then(() => ({ ok: true, result: { text: 'r' } })) });
    await r.call();
    await sleep(20);
    assert.equal(r.texts.filter((x) => x.site === 'late-outcome').length, 1);
  });

  it('(l) ADJACENT — a call inside the ack deadline is unchanged, and a slow-tool call still answers "started" at once', async () => {
    const fast = rig({ deadlineMs: 500, dispatch: async () => ({ ok: true, result: { text: 'r' } }) });
    await fast.call();
    assert.equal(fast.responses.length, 1);
    assert.deepEqual(fast.waits, [], 'no wait, no chime');
    const slow = rig({ dispatch: () => new Promise(() => {}) });
    await slow.call('spotify_play');
    assert.deepEqual(statusOf(slow.responses), ['started'], 'SLOW_TOOLS are not held: their durations run past any hold');
  });
});

describe('BUG-457 — the wiring', () => {
  it('(m) every typed-text site releases the holds before the text goes out', () => {
    const sites = SERVER.split("{ site: 'operator-typed', operator: true }").length - 1;
    assert.equal(sites, 3, 'the three typed-text sites this test was written against');
    const releases = (SERVER.match(/releaseHeldReplies\(\); (?:liveSession|live)\.sendText\([^\n]{0,60}?\{ site: 'operator-typed', operator: true \}\)/g) || []).length;
    assert.equal(releases, 3, 'each one must release first; a typed message that cancels a call can make the model invent its result');
  });

  it('(n) the session\'s reply door is pinned to the socket the call came from', () => {
    assert.match(SESSION, /sendToolResponse: \(\(g\) => \(r\) => g === socketGeneration && sendToolResponse\(r\)\)\(socketGeneration\)/);
  });

  it('(o) the cancellation notice is an outcome: it is never queued behind a turn or dropped as stale', () => {
    const { noticeClass } = require('../src/core/voice/notice-queue');
    assert.equal(noticeClass({ site: 'held-call-cancelled' }), 'outcome');
  });
});
