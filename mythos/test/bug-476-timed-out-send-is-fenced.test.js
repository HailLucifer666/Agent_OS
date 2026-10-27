'use strict';

// BUG-476 — a timed-out whatsapp_send kept running underneath, and a retry of the
// same message could go out twice.
//
// MEASURED 2026-10-06 (gate A), from the operator's own vault, not from the ticket:
// Audit/2026-10-06.jsonl shows three leash confirms for the same message to the same
// contact (09:33:57.0, 09:34:07.8, 09:34:32.2), all three clicked, all three
// dispatched on channel 'confirm-accept'. server/index.js:3603 passes NO signal, so
// dispatch-action.js:71-77 arms AbortSignal.timeout(ACTION_TIMEOUT_MS || 30000) —
// 30 s, schema.js:372, unset in .env. The timed-out dispatch was the SECOND confirm
// (tool-timeout at 09:34:39.05 = accepted at about 09:34:09 + 30 s), not the third;
// the "about 8 s" in the ticket measured from the wrong call, and the 09:34:40.656
// immune-explain line is that anomaly's explainer finishing a brain round trip 1.6 s
// after the anomaly itself (Episodic 09:34:39.014). The first send failed honestly
// (09:34:34.88, wrong window); the third ended ok at 09:34:55.76. The second was
// still draining its desktop steps while the third ran.
//
// What these tests pin:
//   1-2  the caller's abort stops the send immediately before typing and before
//        submitting, and the effector says plainly that nothing was sent;
//   3-7  one logical send (recipient + text) at a time: a second identical send
//        while one is running, or after one ended without proof, is refused;
//   8-9  the adjacent cases that must keep working;
//   10   the one raw route to WhatsApp's submit (send_key enter) is fenced too;
//   11   the late outcome is correlated to the call that timed out (traceId).
//
// RED BEFORE THE FIX, 2026-10-06 (same file, unfixed tree): 13 tests, 3 pass
// (8, 9, 10a — the adjacent cases), 10 fail, each on its own BUG-476 message, e.g.
// "BUG-476: ui_type ran after the caller had already stopped waiting" (1 got 1),
// "a duplicate send started its own desktop steps behind the first" (3 got 2).
//
// MUTATION PROBES, 2026-10-06. Each was an exact-once string replace, verified to
// have changed the file (hash), run against this file alone, then restored and
// verified byte-identical. Every probe was green before; each turned red ONLY in
// the test named:
//   M1  drop the pre-type checkpoint return (from-whatsapp.js)     -> 1
//   M2  drop the pre-submit checkpoint return (from-whatsapp.js)   -> 2
//   M3  drop `if (held) return refusal(held)` (send-fence.js)      -> 3, 4, 5, 6
//   M4  never hold a send that landed after its caller gave up     -> 5
//   M5  never hold a submit that ended unproven                    -> 6
//   M6  never mark the submitting stage (from-whatsapp.js)         -> 6
//   M7  never leave the "earlier attempt sent nothing" note        -> 7
//   M8  drop the raw-Enter fence (from-pc.js send_key)             -> 10b
//   M9  drop traceId from dispatch-action's invoke ctx             -> 11b
//   M10 rename the whatsapp-send.settled log line                  -> 11
//   M11 keyOf without its raw-text fallback (send-fence.js)        -> 12b
// The first draft of keyOf had no fallback; the attack pass found that every
// emoji-only message to one contact would share a key, and M11 reproduces it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');
const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');
const { createEffectorHub } = require('../src/core/effectors/hub');

const CONTACTS = { alex: '+15550001111', bo: '+15550002222' };

function resetFence() {
  // Pre-fix the module does not exist; that must not crash the file, it must let
  // the assertions below go red for the reason they name.
  try { require('../src/core/effectors/send-fence')._resetForTests(); } catch (_) { /* pre-fix */ }
}

function gate() {
  let open;
  const p = new Promise((resolve) => { open = resolve; });
  return { p, open };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0));
// Pre-fix, a duplicate send queues behind a gated step and never returns. A test
// must go red on that, not hang: race it against a short budget.
const STUCK = Symbol('stuck');
function bounded(promise, ms) {
  return Promise.race([promise, tick(ms || 300).then(() => STUCK)]);
}
async function until(pred, what) {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await tick(5);
  }
}

// A scripted from-pc. `gates` holds a step at a promise the test opens; `submitOk`
// decides what the submit step reports. Nothing here reaches a real desktop.
function load(opts) {
  const o = opts || {};
  const gates = o.gates || {};
  const calls = [];
  const logs = [];
  const fakePc = {
    launch_app: async (a) => { calls.push({ fn: 'launch_app', ...a }); return { ok: true, result: { pid: 4242, launched: true } }; },
    focus_window: async (a) => { calls.push({ fn: 'focus_window', ...a }); return { ok: true, result: { pid: a.pid, focused: true } }; },
    readComposeBox: async (pid) => {
      calls.push({ fn: 'readComposeBox', pid });
      if (gates.readComposeBox) await gates.readComposeBox.p;
      const launch = calls.filter((c) => c.fn === 'launch_app' && /phone=/.test(String(c.name || ''))).pop();
      const digits = launch ? String(launch.name).replace(/^.*phone=/, '') : '';
      return { ok: true, result: { name: 'Type a message to +' + digits, currentText: '', headerName: null } };
    },
    ui_type: async (a) => {
      calls.push({ fn: 'ui_type', ...a });
      if (gates.ui_type) await gates.ui_type.p;
      return { ok: true, result: { typed: true, typedIntoPid: a.pid, typedIntoTitle: 'WhatsApp' } };
    },
    submitMessage: async (pid) => {
      calls.push({ fn: 'submitMessage', pid });
      if (gates.submitMessage) await gates.submitMessage.p;
      if (o.submitOk === false) return { ok: false, result: 'the message box did not empty' };
      return { ok: true, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'x' } };
    },
  };
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  delete require.cache[WHATSAPP_PATH];
  const wa = require('../src/core/effectors/from-whatsapp');
  const hub = createEffectorHub({ bus: { emit() {} }, config: {} });
  wa.registerFromWhatsapp(hub, {
    memory: { fs: { readJSONStrict: () => CONTACTS } },
    logger: {
      info: (msg, data) => logs.push({ msg, data }),
      warn: (msg, data) => logs.push({ msg, data }),
    },
  });
  const count = (fn) => calls.filter((c) => c.fn === fn).length;
  return { wa, hub, calls, logs, count };
}

describe('BUG-476 — a timed-out WhatsApp send is fenced', { timeout: 10000 }, () => {
  beforeEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('1. an abort while the composer is still being read stops BEFORE typing, and says nothing was sent', async () => {
    const g = gate();
    const { wa, count } = load({ gates: { readComposeBox: g } });
    const ac = new AbortController();
    const running = wa.whatsapp_send({ to: 'alex', text: 'bug476 one' }, { signal: ac.signal });
    await until(() => count('readComposeBox') === 1, 'readComposeBox');
    ac.abort();
    g.open();
    const res = await running;
    assert.equal(count('ui_type'), 0, 'BUG-476: ui_type ran after the caller had already stopped waiting');
    assert.equal(count('submitMessage'), 0, 'BUG-476: the message was submitted after the caller had already stopped waiting');
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true, 'a cancelled send must say so in a field, not only in prose');
    assert.match(String(res.result), /nothing was sent/i);
  });

  it('2. an abort while the text is being typed stops BEFORE submitting', async () => {
    const g = gate();
    const { wa, count } = load({ gates: { ui_type: g } });
    const ac = new AbortController();
    const running = wa.whatsapp_send({ to: 'alex', text: 'bug476 two' }, { signal: ac.signal });
    await until(() => count('ui_type') === 1, 'ui_type');
    ac.abort();
    g.open();
    const res = await running;
    assert.equal(count('submitMessage'), 0, 'BUG-476: the typed message was submitted after the caller had already stopped waiting');
    assert.equal(res.cancelled, true);
    assert.match(String(res.result), /nothing was sent/i);
    assert.match(String(res.result), /message box/i, 'the text may still be sitting in the composer, and the operator needs to know');
  });

  it('3. THE INCIDENT SHAPE: a second identical send while the first is still running is refused, not queued', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 three' }, {});
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    const secondP = hub.invoke('whatsapp_send', { to: 'Alex', text: 'bug476 three' }, {});
    const second = await bounded(secondP);
    g.open();
    await bounded(secondP, 1000);
    assert.equal(count('launch_app'), 1, 'BUG-476: a duplicate send started its own desktop steps behind the first');
    assert.equal(second.ok, false);
    assert.match(String(second.result), /do not send it again/i);
    assert.match(String(second.result), /check the chat/i);
    const res = await first;
    assert.equal(res.ok, true, String(res.result));
    assert.equal(count('submitMessage'), 1, 'BUG-476: two identical sends both reached submit');
  });

  it('4. after the hub timed the first one out, a retry is refused while it is still draining', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 four' }, { signal: ac.signal, traceId: 'confirm-first' });
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    ac.abort();
    const timedOut = await first;
    assert.equal(timedOut.result, 'tool-timeout');
    assert.equal(timedOut.effectMayHaveLanded, true, 'the hub contract (BUG-398 R5a) is unchanged');
    const retryP = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 four' }, {});
    const retry = await bounded(retryP);
    g.open();
    await bounded(retryP, 1000);
    assert.equal(count('launch_app'), 1, 'BUG-476: the retry started a second send while the timed-out one was still running');
    assert.match(String(retry.result), /still/i);
    await tick(30);
    assert.equal(count('submitMessage'), 0, 'the timed-out send must stop before submitting');
  });

  it('5. a send that submitted after its caller gave up is known SENT, and a retry is refused', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { submitMessage: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 five' }, { signal: ac.signal });
    await until(() => count('submitMessage') === 1, 'first send to start submitting');
    ac.abort();
    assert.equal((await first).result, 'tool-timeout');
    g.open();
    await tick(30);
    const retry = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 five' }, {});
    assert.equal(count('submitMessage'), 1, 'BUG-476: a send that already landed was submitted a second time');
    assert.match(String(retry.result), /was sent/i);
  });

  it('6. a submit that failed after its caller gave up is UNCERTAIN, and a retry is refused', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { submitMessage: g }, submitOk: false });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 six' }, { signal: ac.signal });
    await until(() => count('submitMessage') === 1, 'first send to start submitting');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    const retry = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 six' }, {});
    assert.equal(count('submitMessage'), 1, 'BUG-476: an uncertain send triggered an automatic resubmission');
    assert.match(String(retry.result), /may already have been sent/i);
  });

  it('7. a send cancelled before submitting leaves the next attempt free, and the next result says the earlier one sent nothing', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven' }, { signal: ac.signal });
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    const retry = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven' }, {});
    assert.equal(retry.ok, true, String(retry.result));
    assert.equal(count('submitMessage'), 1, 'exactly one submit: the retry, never the cancelled attempt');
    assert.match(String(retry.result.note), /earlier attempt.*sent nothing/i);
  });

  // Review finding, 2026-10-07 (independent reviewer): stopped AFTER typing, the
  // entry used to be released, so the retry test 7 invites typed the message again
  // after the leftover draft, and a raw Enter submitted the leftover. Probes, same
  // date: (a) held='typed' removed in settle() -> 7b and 7c red; (b) stoppedAt not
  // recorded in checkpoint() -> 7b and 7c red. 7 (stopped before typing) stays free.
  it('7b. a send stopped AFTER typing is held: an identical retry is refused and says the text may still be in the box', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { ui_type: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven b' }, { signal: ac.signal });
    await until(() => count('ui_type') === 1, 'first send to type');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    const retry = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven b' }, {});
    assert.equal(retry.ok, false, 'a retry after a typed-but-unsent attempt must not type the message again');
    assert.match(String(retry.result), /message box/i);
    assert.equal(count('ui_type'), 1, 'the retry typed a second copy after the leftover draft');
    assert.equal(count('submitMessage'), 0);
  });

  it('7c. after a send stopped AFTER typing, a raw Enter into WhatsApp is refused (it would submit the leftover)', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { ui_type: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven c' }, { signal: ac.signal });
    await until(() => count('ui_type') === 1, 'first send to type');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    assert.match(String(require('../src/core/effectors/send-fence').refuseRawSubmit('WhatsApp')), /still in the box/i);
  });

  it('7d. ADJACENT: once the hold has expired, the same message can be sent again', async () => {
    let now = 1000000;
    require('../src/core/effectors/send-fence')._resetForTests({ now: () => now });
    const g = gate();
    const { hub, count } = load({ gates: { ui_type: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven d' }, { signal: ac.signal });
    await until(() => count('ui_type') === 1, 'first send to type');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    now += require('../src/core/effectors/send-fence').UNCERTAIN_SEND_HOLD_MS + 1;
    const later = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 seven d' }, {});
    assert.equal(later.ok, true, String(later.result));
  });

  it('8. ADJACENT: a different text, or a different recipient, is not blocked by a send in flight', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 eight' }, {});
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    const otherText = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 eight, different words' }, {});
    const otherPerson = hub.invoke('whatsapp_send', { to: 'bo', text: 'bug476 eight' }, {});
    await until(() => count('launch_app') === 3, 'both other sends to start');
    g.open();
    const results = await Promise.all([first, otherText, otherPerson]);
    for (const r of results) assert.equal(r.ok, true, String(r.result));
    assert.equal(count('submitMessage'), 3);
  });

  it('9. ADJACENT: a normal send succeeds, and sending the same text again after a confirmed ok is allowed', async () => {
    const { hub, count } = load();
    const one = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 nine' }, {});
    assert.equal(one.ok, true, String(one.result));
    assert.equal(one.result.sent, true);
    const two = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 nine' }, {});
    assert.equal(two.ok, true, 'the operator was told the first one was sent; a deliberate second send is theirs to ask for');
    assert.equal(count('submitMessage'), 2);
  });

  it('11. the late outcome is logged against the call that timed out (traceId from dispatch)', async () => {
    const g = gate();
    const { hub, logs, count } = load({ gates: { readComposeBox: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 eleven' }, { signal: ac.signal, traceId: 'confirm-1347' });
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    const settled = logs.find((l) => l.msg === 'whatsapp-send.settled');
    assert.ok(settled, 'BUG-476: the outcome of a timed-out send was never recorded anywhere');
    assert.equal(settled.data.traceId, 'confirm-1347');
    assert.equal(settled.data.outcome, 'cancelled-before-submit');
    assert.equal(settled.data.callerGaveUp, true);
  });

  it('11b. dispatchAction hands the traceId to the effector, so the late log can be joined to the audit row', async () => {
    const { dispatchAction } = require('../src/core/effectors/dispatch-action');
    let seen = null;
    const effectors = {
      breakers: { allow: () => true },
      invoke: async (tool, args, ctx) => { seen = ctx; return { ok: true, result: {} }; },
    };
    await dispatchAction({ tool: 'whatsapp_send', args: {} },
      { effectors, bus: { emit() {} }, goals: null, memory: null, config: {}, traceId: 'confirm-abc', channel: 'confirm-accept' });
    assert.equal(seen && seen.traceId, 'confirm-abc', 'BUG-476: the effector cannot correlate its late outcome to the audit row');
  });
});

// 10. The raw route. send_key('enter') with WhatsApp in the foreground routes to the
// same submit ladder whatsapp_send uses (from-pc.js send_key). While a WhatsApp send
// is running or ended without proof, that Enter would submit whatever is in the box.
describe('BUG-476 — the raw Enter into WhatsApp is fenced while a send is unresolved', { timeout: 10000 }, () => {
  const REAL_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
  const originalRequire = Module.prototype.require;
  const WHATSAPP = { pid: 4242, title: 'WhatsApp', process: 'WhatsApp' };

  function realPc(calls) {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (c) => {
        calls.push(c);
        if (c.cmd === 'get_foreground_window') return { ok: true, result: WHATSAPP };
        if (c.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: c.pid } };
        if (c.cmd === 'ui_type') return { ok: true, result: { typed: true, typedIntoPid: c.pid, typedIntoTitle: 'WhatsApp', readBack: 'confirmed', readBackText: c.text } };
        if (c.cmd === 'submit_message') return { ok: true, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'hi' } };
        return { ok: true, result: {} };
      },
    };
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/pc-child') return mock;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[REAL_PC_PATH];
    try { return require(REAL_PC_PATH); } finally { Module.prototype.require = originalRequire; }
  }

  beforeEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; delete require.cache[REAL_PC_PATH]; });

  it('10a. ADJACENT: with no send in flight, Enter in WhatsApp still reaches the verified submit', async () => {
    const calls = [];
    const pc = realPc(calls);
    await pc.ui_type({ text: 'hello', pid: 4242 });
    const res = await pc.send_key({ key: 'enter' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(calls.filter((c) => c.cmd === 'submit_message').length, 1);
  });

  it('10b. while a WhatsApp send is in flight, a raw Enter into WhatsApp is refused', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const inFlight = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 ten' }, {});
    await until(() => count('readComposeBox') === 1, 'send to reach the composer');
    const calls = [];
    const pc = realPc(calls);
    await pc.ui_type({ text: 'hello', pid: 4242 });
    const res = await pc.send_key({ key: 'enter' });
    assert.equal(calls.filter((c) => c.cmd === 'submit_message').length, 0,
      'BUG-476: a raw Enter submitted into WhatsApp while a send was still in flight');
    assert.equal(res.ok, false);
    assert.match(String(res.result), /check the chat/i);
    g.open();
    await inFlight;
  });

  it('10c. DISPOSITION: ui_type is deliberately NOT fenced - it cannot submit, so it cannot duplicate', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const inFlight = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 ten c' }, {});
    await until(() => count('readComposeBox') === 1, 'send to reach the composer');
    const calls = [];
    const pc = realPc(calls);
    const res = await pc.ui_type({ text: 'hello', pid: 4242 });
    assert.equal(res.ok, true, 'see send-fence.js ATTACK ANSWERS: fencing ui_type is a decision, not an oversight');
    assert.equal(calls.filter((c) => c.cmd === 'ui_type').length, 1);
    g.open();
    await inFlight;
  });

  // BUG-476 review, 2026-10-27. 'landed' is the one held state that must NOT
  // block Enter: it is set only when the submit ladder reported sent:true, i.e.
  // it PROVED the composer emptied. There is no leftover to submit, so refusing
  // there was a pure false refusal - for up to the whole 5-minute hold - on a
  // chat that is already fine. The entry stays held against an identical RETRY;
  // that is run()'s refusal, not this guard's.
  it('10d. ADJACENT: a send that landed after its caller gave up does not block a raw Enter - its composer is empty', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { submitMessage: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 ten d' }, { signal: ac.signal });
    await until(() => count('submitMessage') === 1, 'send to start submitting');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    const fence = require('../src/core/effectors/send-fence');
    assert.equal(fence.refuseRawSubmit('WhatsApp'), null,
      'a landed send proved the composer emptied, so Enter has nothing left to submit');
    const calls = [];
    const pc = realPc(calls);
    // The Wave 2 step C guard (a different one, in from-pc.js) refuses Enter
    // unless THIS session proved text into the window, so prove it first - the
    // question here is only whether send-fence refuses.
    await pc.ui_type({ text: 'hello', pid: 4242 });
    const res = await pc.send_key({ key: 'enter' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(calls.filter((c) => c.cmd === 'submit_message').length, 1,
      'the raw Enter should have reached the verified submit ladder');
  });

  // BUG-476 review, 2026-10-27. The guard cannot be scoped per chat (one window,
  // one composer, and a raw Enter carries no conversation), so the least it owes
  // the operator is the name of the send that is blocking it, and an honest
  // statement that it is refusing everywhere on purpose rather than pretending
  // to know which box is in front.
  it('10e. the refusal names the blocking send and admits it cannot tell which chat is in front', async () => {
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const inFlight = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 ten e' }, {});
    await until(() => count('readComposeBox') === 1, 'send to reach the composer');
    const text = String(require('../src/core/effectors/send-fence').refuseRawSubmit('WhatsApp'));
    assert.match(text, /alex/i, 'the operator has to be told which chat to go and check');
    assert.match(text, /one window and one composer/i,
      'the refusal must say WHY it is global instead of implying it knows the chat');
    assert.match(text, /every chat/i);
    g.open();
    await inFlight;
  });
});

// BUG-476 review, 2026-10-27. A note is one sentence for the NEXT attempt at the
// same message. It used to live forever: nothing deleted one except a later send
// of that exact message, so a long-running process grew the Map without bound,
// and a note from days ago would still be attached to a send it has nothing to do
// with. The Map is not exported, so the observable proxy is the note itself.
describe('BUG-476 - a note for the next attempt expires with the hold', { timeout: 10000 }, () => {
  const fence = () => require('../src/core/effectors/send-fence');
  beforeEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { resetFence(); delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('13. a note older than the hold is not attached to a much later send', async () => {
    let now = 1000000;
    fence()._resetForTests({ now: () => now });
    const g = gate();
    const { hub, count } = load({ gates: { readComposeBox: g } });
    const ac = new AbortController();
    const first = hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 thirteen' }, { signal: ac.signal });
    await until(() => count('readComposeBox') === 1, 'first send to reach the composer');
    ac.abort();
    await first;
    g.open();
    await tick(30);
    now += fence().UNCERTAIN_SEND_HOLD_MS + 1;
    const later = await hub.invoke('whatsapp_send', { to: 'alex', text: 'bug476 thirteen' }, {});
    assert.equal(later.ok, true, String(later.result));
    assert.doesNotMatch(String(later.result.note), /earlier attempt/i,
      'a note from before the hold expired was attached anyway');
  });
});

describe('BUG-476 — the logical-send key', () => {
  const fence = () => require('../src/core/effectors/send-fence');
  it('12. case, punctuation and spacing are one send; other words and other people are not', () => {
    const { keyOf } = fence();
    assert.equal(keyOf('+1 555 000 1111', 'Test, this is a test.'), keyOf('15550001111', 'test this is a test'));
    assert.notEqual(keyOf('+15550001111', 'test one'), keyOf('+15550001111', 'test two'));
    assert.notEqual(keyOf('+15550001111', 'hi'), keyOf('+15550002222', 'hi'));
  });
  it('12b. messages with no letters or digits keep their own text, so they do not collide', () => {
    const { keyOf } = fence();
    assert.notEqual(keyOf('+15550001111', '👍'), keyOf('+15550001111', '❤️'));
  });
});
