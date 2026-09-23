'use strict';

// test/bug-433-greeting-waits-for-a-hud-that-can-hear-it.test.js
//
// OBSERVED 2026-09-16, cold boot 10:26:42Z from source, HUD PIN-locked:
//
//   proactive.live-skipped-no-listener            x2
//   live.text-injected site:proactive-speak       0
//   tts.spoke path:proactive chunks:3 synthesized:3
//
// The audio WAS synthesized and sent. Nobody heard it. The server armed the
// single greeting 2.5 s after the FIRST dashboard connection and marked the shot
// fired at ARMING time; that connection was a locked HUD, whose proactive-speech
// handler returns early behind the PIN gate, so the chunks landed with no
// registered handler and were silently discarded. The server logged a delivery.
//
// THE OLD QUESTION WAS WRONG. "Has anything connected yet?" is not "is there a
// client that can play this?" — and only the client can answer the second one,
// because it depends on the PIN state, on whether the voice configuration has
// loaded, and on whether playback is wired. The client now says so in a
// `hud-ready` message and this scheduler waits for one that can.
//
// TWO HYPOTHESES, AND WHY BOTH ARE NOW MOOT. app.js had two silent early
// returns on the proactive-speech path — `!voiceConfigLoaded` and the lock gate
// — and nothing recorded which one fired on 09-16, so the plan for this repair
// required instrumentation before the readiness change could be judged
// sufficient. Both now log a structured reason instead of returning bare, and
// both feed the same readiness verdict, so the greeting is not armed while
// EITHER would drop it. The instrumentation ships with the fix rather than
// ahead of it because the fix does not depend on which one it was.
//
// BRANCH TRAVERSED (protocol STAGE 4.11): the scheduler state machine directly,
// with an injected clock and delivery. The wiring into server/index.js and the
// client's readiness calculation are source-shape assertions below, for the
// standing reason that neither file can be require()d under node --test.
//
// MUTATION PROBES, all six run 2026-09-18 and each diffed against a full-path
// backup to confirm it actually applied before its result was believed:
//   (q1) make fire() deliver without re-asking stillEligible()
//        => fails 'a target that relocks during the delay does not get it'.
//   (q2) make the target-lost path set state to 'dispatched' instead of
//        'pending' => fails 'a lost target hands the greeting back'.
//   (q3) drop the `state !== 'pending'` guard in offer()
//        => fails 'two tabs cannot both be greeted'.
//   (q4) relax deriveHudReady to `lockState === 'locked'` — the ORIGINAL defect
//        shape => fails both tri-state tests.
//   (q5) stop pin-lock-screen announcing transitions
//        => fails all three tests in 'announces every state change'.
//   (q6) remove setLockState's idempotence check => fails 'the relock/probe
//        race announces locked exactly once'.
//   (q7) loosen the delivery hand-back from `result === false` to `!result`
//        => fails 'any other return value is a dispatch, including undefined',
//        i.e. the false-positive bound, not the true-positive one.
//
// q6 IS WHY THIS BLOCK IS WORTH READING. Its first run passed everything. The
// test meant to cover that guard drove the relock subscriber, which returns
// early on `lockState === 'locked'` all by itself, so the guard under test was
// never reached and its removal changed nothing. The test was rewritten to
// produce the order that actually reaches it — a stale-session 401 locking the
// screen BEFORE GET /api/pin/status answers configured:true — and only then did
// the probe bite. A guard whose test cannot reach it is not covered; it is
// defect class 14, and a green run is what it looks like.
//
// ADJACENT CASES THAT MUST KEEP PASSING: a node still cannot consume the
// greeting (BUG-178), one eligible HUD still gets exactly one greeting, a
// delivery failure still spends the shot rather than re-greeting somebody over
// speech that may already be audible, a wrong PIN is still not a state change,
// and a no-PIN boot still renders no overlay at all.
//
// Run: cd mythos && node --test test/bug-433-greeting-waits-for-a-hud-that-can-hear-it.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createGreetingScheduler, DEFAULT_DELAY_MS } = require('../server/boot-greeting');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ui = (name) => pathToFileURL(path.join(__dirname, '..', 'ui', 'public', 'js', name)).href;
const settle = () => new Promise((r) => setImmediate(r));
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });

function makeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        t = next.timer.at;
        next.timer.fn();
      }
      t = target;
    },
  };
}

function harness(over) {
  const o = over || {};
  const logs = [];
  const delivered = [];
  const clock = o.clock || makeClock();
  const scheduler = createGreetingScheduler({
    delayMs: DEFAULT_DELAY_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (event, data) => logs.push({ event, data }),
    stillEligible: o.stillEligible || (() => true),
    deliver: o.deliver || ((id) => { delivered.push(id); }),
  });
  return { scheduler, clock, logs, delivered, reasons: () => logs.map((l) => l.event) };
}

describe('BUG-433 — the greeting waits for a HUD that can actually play it', () => {
  test('a locked HUD does not consume the single shot', async () => {
    const h = harness();
    const armed = h.scheduler.offer({ id: 'hud-1', greetable: false, why: 'pin-locked' });

    assert.equal(armed, false, 'THE FILED DEFECT: this is the connection that burned the greeting on 2026-09-16');
    assert.equal(h.scheduler.state(), 'pending', 'the shot must still be available');
    assert.equal(h.clock.pending(), 0, 'and nothing is scheduled');

    const later = h.scheduler.offer({ id: 'hud-1', greetable: true });
    assert.equal(later, true, 'the same HUD, once unlocked, can have it');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, ['hud-1']);
  });

  test('the refusal says WHY, so the next run does not need a hypothesis', () => {
    const h = harness();
    h.scheduler.offer({ id: 'hud-1', greetable: false, why: 'voice-config-not-loaded' });
    const entry = h.logs.find((l) => l.event === 'boot-greeting.not-armed');
    assert.ok(entry, 'a refusal must be recorded, not silent — silence is why 09-16 needed a hypothesis at all');
    assert.equal(entry.data.reason, 'client-not-greetable');
    assert.equal(entry.data.why, 'voice-config-not-loaded',
      'and it must carry the client s own reason, which is what distinguishes the two drop branches');
  });

  test('a target that relocks during the delay does not get it', () => {
    let eligible = true;
    const h = harness({ stillEligible: () => eligible });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    eligible = false; // the operator relocks inside the 2.5s window
    h.clock.advance(DEFAULT_DELAY_MS);

    assert.deepEqual(h.delivered, [], 'eligibility must be re-asked when the timer fires, not trusted from arming time');
    assert.ok(h.reasons().includes('boot-greeting.target-lost'));
  });

  test('a lost target hands the greeting back rather than spending it', () => {
    let eligible = true;
    const h = harness({ stillEligible: () => eligible });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    eligible = false;
    h.clock.advance(DEFAULT_DELAY_MS);

    assert.equal(h.scheduler.state(), 'pending',
      'nothing was spoken, so the shot is not spent — burning it here is the 2026-09-16 defect with a longer fuse');
    eligible = true;
    assert.equal(h.scheduler.offer({ id: 'hud-2', greetable: true }), true, 'the next eligible HUD can have it');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, ['hud-2']);
  });

  test('a disconnect withdraws a scheduled greeting', () => {
    const h = harness();
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    assert.equal(h.scheduler.withdraw('hud-1', 'socket-closed'), true);
    assert.equal(h.scheduler.state(), 'pending');
    assert.equal(h.clock.pending(), 0, 'the timer is cleared, not left to fire into a closed socket');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, []);
  });

  test('withdrawing somebody else s greeting does nothing', () => {
    const h = harness();
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    assert.equal(h.scheduler.withdraw('hud-2', 'socket-closed'), false,
      'a second tab closing must not cancel the first tab s greeting');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, ['hud-1']);
  });

  // ---- the BUG-112 invariant, and the BUG-178 one -------------------------------

  test('two tabs cannot both be greeted', () => {
    const h = harness();
    assert.equal(h.scheduler.offer({ id: 'tab-1', greetable: true }), true);
    assert.equal(h.scheduler.offer({ id: 'tab-2', greetable: true }), false, 'one greeting per boot, never one per tab');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, ['tab-1'], 'exactly one, and no overlapping voices');
  });

  test('duplicate readiness messages from one tab cannot schedule twice', () => {
    const h = harness();
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    assert.equal(h.clock.pending(), 1, 'readiness is republished on reconnect and on every state change — it must be idempotent');
    h.clock.advance(DEFAULT_DELAY_MS);
    assert.deepEqual(h.delivered, ['hud-1']);
  });

  test('a voice node cannot nominate itself (BUG-178)', () => {
    const h = harness();
    assert.equal(h.scheduler.offer({ id: 'node-1', greetable: true, isNode: true }), false,
      'speaking through a phone is an election-gated feature; picking a socket bypasses that gate');
    assert.equal(h.scheduler.state(), 'pending', 'and the shot stays available for the HUD');
    const entry = h.logs.find((l) => l.event === 'boot-greeting.not-armed');
    assert.equal(entry.data.reason, 'node-cannot-be-greeted');
  });

  // ---- dispatch is not audibility ----------------------------------------------

  test('a delivery failure spends the shot and is recorded as its own outcome', async () => {
    const h = harness({ deliver: () => Promise.reject(new Error('socket went away mid-send')) });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.clock.advance(DEFAULT_DELAY_MS);
    await new Promise((r) => setImmediate(r));

    assert.equal(h.scheduler.state(), 'dispatched',
      'partial speech may already have been audible; re-greeting somebody over it is worse than silence');
    const entry = h.logs.find((l) => l.event === 'boot-greeting.delivery-failed');
    assert.ok(entry, 'and the failure is visible rather than folded into a success');
    assert.match(String(entry.data.error), /socket went away/);
  });

  test('a delivery that spoke nothing hands the shot back', async () => {
    // deliverBootGreeting() rechecks the target AFTER generating the briefing —
    // a real second window, because generation reaches the brain and the tools.
    // Finding the tab gone and no replacement connected, it returns false: the
    // shot is handed back rather than spent, which is safe HERE and only here
    // because proactiveSpeak has not run and there is no partial audio to talk
    // over. Distinct from a thrown failure, which spends it (next test but one).
    const h = harness({ deliver: async () => false });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.clock.advance(DEFAULT_DELAY_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.scheduler.state(), 'pending', 'nothing was spoken, so nothing was spent');
    assert.equal(h.scheduler.targetId(), null);
    assert.equal(h.scheduler.offer({ id: 'hud-2', greetable: true }), true, 'the next eligible HUD can still be greeted');
  });

  test('any other return value is a dispatch, including undefined', async () => {
    // The bound on the rule above. `false` is the ONLY hand-back — a deliver()
    // that simply returns nothing has spoken, and must not be re-run at someone
    // else. Without this the guard would be a silent re-greeting machine.
    const h = harness({ deliver: async () => undefined });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.clock.advance(DEFAULT_DELAY_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.scheduler.state(), 'dispatched');
    assert.equal(h.scheduler.offer({ id: 'hud-2', greetable: true }), false);
  });

  test('once in flight, a withdrawal cannot cancel it', async () => {
    let release;
    const h = harness({ deliver: () => new Promise((r) => { release = r; }) });
    h.scheduler.offer({ id: 'hud-1', greetable: true });
    h.clock.advance(DEFAULT_DELAY_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.scheduler.state(), 'in-flight');
    assert.equal(h.scheduler.withdraw('hud-1', 'socket-closed'), false, 'the point of no return is the point of no return');
    release();
  });
});

// ---- the client's half of the answer --------------------------------------------

// hud-ready.js is browser ESM with no imports of its own, so it loads straight
// from a file URL — the same trick pin-gate-state.test.js uses. That is the
// whole reason the rule was pulled out of app.js: app.js cannot be loaded here
// at all, and a readiness rule that can only be checked by READING it is how the
// 2026-09-16 mismatch survived a code review in the first place.
describe('BUG-433 — the readiness rule', () => {
  const load = () => import(ui('hud-ready.js'));

  test("'unknown' is not 'unlocked' — the tri-state is the point", async () => {
    const { deriveHudReady } = await load();
    // `lockState !== 'locked'` would pass this, and that is precisely the bug:
    // 'unknown' is the window before GET /api/pin/status has answered. A
    // greeting armed there is armed on a guess about a PIN that may be set.
    assert.deepEqual(deriveHudReady({ voiceConfigLoaded: true, lockState: 'unknown' }),
      { greetable: false, why: 'pin-unknown' });
    assert.deepEqual(deriveHudReady({ voiceConfigLoaded: true, lockState: 'locked' }),
      { greetable: false, why: 'pin-locked' });
    assert.deepEqual(deriveHudReady({ voiceConfigLoaded: true, lockState: 'unlocked' }),
      { greetable: true, why: null });
  });

  test('an absent lock state is unknown, not unlocked', async () => {
    const { deriveHudReady } = await load();
    // Fails SAFE on a shape nobody planned for. The opposite default would mean
    // one renamed field silently re-enables speech over a locked HUD.
    assert.deepEqual(deriveHudReady({ voiceConfigLoaded: true }), { greetable: false, why: 'pin-unknown' });
    assert.deepEqual(deriveHudReady(undefined), { greetable: false, why: 'voice-config-not-loaded' });
    assert.deepEqual(deriveHudReady({}), { greetable: false, why: 'voice-config-not-loaded' });
  });

  test('a pending voice configuration is reported as itself, not as a PIN problem', async () => {
    const { deriveHudReady } = await load();
    // The two drop branches in app.js were written separately and this is the
    // single verdict that replaced them; a `why` that named the wrong one would
    // send the next investigation down the same two-hypothesis path as 09-16.
    assert.deepEqual(deriveHudReady({ voiceConfigLoaded: false, lockState: 'unlocked' }),
      { greetable: false, why: 'voice-config-not-loaded' });
  });

  test('the reporter re-reads state on every call rather than capturing it', async () => {
    const { createHudReadyReporter } = await load();
    const sent = [];
    let state = { voiceConfigLoaded: false, lockState: 'unknown' };
    const publish = createHudReadyReporter({ send: (m) => sent.push(m), readState: () => state });
    publish();
    // Both inputs change AFTER construction — the configuration lands, the PIN
    // resolves — so a reporter that captured them would report the boot state
    // forever and the greeting would never be armed at all.
    state = { voiceConfigLoaded: true, lockState: 'unlocked' };
    publish();
    assert.deepEqual(sent, [
      { type: 'hud-ready', greetable: false, why: 'voice-config-not-loaded' },
      { type: 'hud-ready', greetable: true, why: null },
    ]);
  });

  test('a send that throws is swallowed, and the verdict still comes back', async () => {
    const { createHudReadyReporter } = await load();
    // ws.js throws while the socket is still opening, which is exactly when the
    // first readiness call happens. Failing loudly would put a console error on
    // every ordinary boot; the next transition re-sends the current verdict.
    const publish = createHudReadyReporter({
      send: () => { throw new Error('socket not open'); },
      readState: () => ({ voiceConfigLoaded: true, lockState: 'unlocked' }),
    });
    assert.deepEqual(publish(), { greetable: true, why: null });
  });
});

// ---- the transition nobody was told about ---------------------------------------

describe('BUG-433 — the lock screen announces every state change', () => {
  // Loaded through the data: URL rewriter voice-config-unlock.test.js
  // established, for the same reason: focus-trap needs a DOM this fixture does
  // not have, and a data: URL has no base for the relative specifiers.
  async function loadLockScreen() {
    const source = fs.readFileSync(new URL(ui('pin/pin-lock-screen.js')), 'utf8')
      .replace("import { trapFocus } from '../a11y/focus-trap.js';", 'const trapFocus = () => () => {};')
      .replace("'./pin-gate.js'", JSON.stringify(ui('pin/pin-gate.js')))
      .replace("'../auth/auth-state.js'", JSON.stringify(ui('auth/auth-state.js')));
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  }

  function fakeDom(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => (previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document));
    const captured = {};
    globalThis.document = {
      querySelectorAll: () => [],
      createElement() {
        const controls = Object.fromEntries(['form', '.pin-input', '.pin-submit', '.pin-message'].map((k) => [k, {
          value: '', focus() {}, addEventListener(type, cb) { this[type] = cb; },
        }]));
        captured.overlay = {
          controls, setAttribute() {}, remove() {}, classList: { toggle() {} }, querySelector: (k) => controls[k],
        };
        return captured.overlay;
      },
    };
    return captured;
  }

  test('a no-PIN boot announces unlocked WITHOUT an unlock event', async (t) => {
    const { mountPinLockScreen } = await loadLockScreen();
    fakeDom(t);
    const announced = [];
    let unlocks = 0;
    // THE REGRESSION THIS EXISTS TO CATCH. The ordinary install has no PIN, so
    // onUnlock never fires; lockState resolves 'unknown' -> 'unlocked' inside
    // the status probe and, before this change, in complete silence. Readiness
    // published before that probe answered would have said 'pin-unknown' and
    // nothing would ever have corrected it — no greeting on any no-PIN machine,
    // which is a worse outcome than the bug being fixed.
    const screen = mountPinLockScreen({ appendChild() { assert.fail('no PIN must not render a lock'); } }, {
      onUnlock: () => { unlocks++; },
      onLockState: (s) => announced.push(s),
      fetchImpl: async () => response({ configured: false }),
    });
    t.after(() => screen.cleanup());
    await settle();
    assert.deepEqual(announced, ['unlocked']);
    assert.equal(unlocks, 0, 'and it is NOT an unlock — nothing was verified');
    assert.equal(screen.lockState(), 'unlocked');
  });

  test('a configured PIN announces locked, then unlocked on a correct PIN', async (t) => {
    const { mountPinLockScreen } = await loadLockScreen();
    const dom = fakeDom(t);
    const announced = [];
    let accepted = false;
    const screen = mountPinLockScreen({ appendChild() {} }, {
      onLockState: (s) => announced.push(s),
      fetchImpl: async (url) => (url.endsWith('/status') ? response({ configured: true })
        : accepted ? response({ ok: true }) : response({ error: 'Incorrect PIN.' }, 401)),
    });
    t.after(() => screen.cleanup());
    await settle();
    assert.deepEqual(announced, ['locked']);
    dom.overlay.controls['.pin-input'].value = '1234';
    dom.overlay.controls.form.submit({ preventDefault() {} });
    await settle();
    // A WRONG PIN CHANGES NOTHING, so it announces nothing. A reporter woken on
    // every keystroke would republish an unchanged verdict at the server.
    assert.deepEqual(announced, ['locked'], 'a refused PIN is not a state change');
    accepted = true;
    dom.overlay.controls['.pin-input'].value = '5678';
    dom.overlay.controls.form.submit({ preventDefault() {} });
    await settle();
    assert.deepEqual(announced, ['locked', 'unlocked']);
  });

  test('the relock/probe race announces locked exactly once', async (t) => {
    const { mountPinLockScreen } = await loadLockScreen();
    fakeDom(t);
    const announced = [];
    let fireSessionLost = null;
    let answerStatus = null;
    const screen = mountPinLockScreen({ appendChild() {} }, {
      onLockState: (s) => announced.push(s),
      onPinSessionLostImpl: (cb) => { fireSessionLost = cb; return () => {}; },
      fetchImpl: () => new Promise((r) => { answerStatus = () => r(response({ configured: true })); }),
    });
    t.after(() => screen.cleanup());
    await settle();
    assert.deepEqual(announced, [], 'nothing has answered yet — the state is still unknown');
    // THE ORDER THAT REACHES IT. A `missing:['pin']` 401 landing before
    // GET /api/pin/status answers locks the screen; the probe then answers
    // configured:true and writes 'locked' a SECOND time. This is the sequence
    // the 2026-09-18 security review found on the other side of the same race,
    // and an earlier version of this test could not produce it — the relock
    // subscriber's own `lockState === 'locked'` return was doing all the work,
    // so removing the idempotence check left every assertion green.
    fireSessionLost();
    assert.deepEqual(announced, ['locked']);
    answerStatus();
    await settle();
    assert.deepEqual(announced, ['locked'], 'the same state written twice is not a transition');
    assert.equal(screen.lockState(), 'locked');
  });
});

// ---- the wiring the shape cannot derive ----------------------------------------

describe('BUG-433 — the wiring', () => {
  const SERVER = fs.readFileSync(path.join(REPO_ROOT, 'mythos', 'server', 'index.js'), 'utf8');
  const APP = fs.readFileSync(path.join(REPO_ROOT, 'mythos', 'ui', 'public', 'js', 'app.js'), 'utf8');

  test('the server no longer arms on "something connected"', () => {
    assert.doesNotMatch(SERVER, /if \(!bootGreetingFired\) \{\s*\n\s*bootGreetingFired = true;/,
      'arming on the first connection and marking the shot fired at that moment IS the defect: the first '
      + 'connection on 2026-09-16 was a locked HUD that could not play anything');
    assert.match(SERVER, /greetingScheduler\.offer\(/, 'the decision belongs to the scheduler, where a test can reach it');
    assert.match(SERVER, /greetingScheduler\.withdraw\(/, 'and a socket that goes away must hand the greeting back');
  });

  test('the server derives the target socket from the scheduler s own id', () => {
    // A first draft kept a single `greetableWs` beside the scheduler's targetId.
    // Two variables for one fact: a second tab announcing itself was correctly
    // REFUSED the greeting and still overwrote the socket, so delivery would
    // have gone to a tab the scheduler never chose. No scheduler test can see
    // that — the fault was entirely in the server's bookkeeping — so it is
    // pinned here, on the shape that makes the disagreement unrepresentable.
    // Named as a variable, not as prose: this assertion first failed against
    // the comment that explains it, which is the standing brittleness of every
    // source-shape pin in this repo.
    assert.doesNotMatch(SERVER, /(let|const|var) greetableWs\b/, 'one fact, one home');
    assert.match(SERVER, /stillEligible: \(id\) => \{ const s = greetableSockets\.get\(id\)/,
      'eligibility must be asked about the scheduled connection, not about whoever announced last');
    assert.match(SERVER, /deliver: \(id\) => deliverBootGreeting\(greetableSockets\.get\(id\)\)/,
      'and delivery must go to that same one');
  });

  test('the server refuses a node that claims to be a HUD', () => {
    assert.match(SERVER, /isNode: !!ws\._mythosNodeId/,
      'readiness is a playback hint, never an authentication claim — the server decides what the socket IS, '
      + 'not the message');
  });

  test('the client computes readiness from both inputs and publishes it', () => {
    // The tri-state rule itself is asserted BEHAVIOURALLY above, against the
    // real module — that is the point of extracting it. What a source-shape pin
    // is still needed for is the wiring app.js holds and no test can execute:
    // that the reporter is constructed at all, that it reads BOTH inputs, and
    // that the lock screen's transitions reach it. Miss any one and the rule is
    // correct and never consulted.
    assert.match(APP, /createHudReadyReporter\(/, 'the client is the only thing that knows whether it can play');
    assert.match(APP, /voiceConfigLoaded, lockState: pinLockScreen\.lockState\(\)/,
      'both drop branches must feed ONE verdict — written separately is how they drifted apart');
    assert.match(APP, /onLockState: \(\) => publishHudReady\(\)/,
      'the no-PIN boot resolves the lock state with no onUnlock, so without this subscription readiness '
      + 'would be published once as pin-unknown and never corrected');
  });

  test('both silent drops now record a reason', () => {
    const block = APP.slice(APP.indexOf("subscribe(['proactive-speech']"), APP.indexOf("subscribe(['proactive-speech']") + 1800);
    assert.match(block, /proactive-drop/,
      'nothing recorded which branch fired on 2026-09-16, so the cause had to be inferred. Two bare `return`s '
      + 'on a path that discards audio is the evidence-destroying shape this repo has on record elsewhere');
  });
});
