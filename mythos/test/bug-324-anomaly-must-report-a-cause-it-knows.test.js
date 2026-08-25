'use strict';

// test/bug-324-anomaly-must-report-a-cause-it-knows.test.js — BUG-324.
//
// THE DEFECT, MEASURED ON THE WIRED CHAIN (bus -> diagnostician -> healer ->
// explainer) on 2026-08-23. Two anomaly kinds reach the no-match path and are
// spoken to the operator like this:
//
//   "One of my internal checks has no automatic fix: confirm-expired-silently
//    in ui_click. I DO NOT YET KNOW THE CAUSE. This one needs your attention."
//   "One of my internal checks has no automatic fix: live-turn-stalled.
//    I DO NOT YET KNOW THE CAUSE."
//
// Both sentences are false, and the code that speaks them is not the code at
// fault. announcer.js's honestCauseClause() is correct: with no `reason` on the
// payload it says so rather than inventing one. The fault is at the EMITTERS,
// which know the cause exactly and do not forward it:
//
//   - leash/index.js's onExpire writes `reason: 'confirm-ttl-expired'` into the
//     audit row and then, THREE LINES LOWER, emits the anomaly without it. The
//     cause is "the confirmation prompt timed out unanswered" — not a mystery,
//     and the same function had already written it down.
//   - live-session.js's armTurnStall holds `waitedMs` (the deadline it just
//     missed) and puts it on the payload, but nothing turns it into a cause
//     clause, so the operator is told the cause is unknown while the number
//     sits on the event.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The same one as BUG-278: a field that
// exists one line away from the emit and is not forwarded, so a downstream
// control reads `undefined` and degrades. BUG-278 was the healer dropping
// needsOperator/reason in transit; this is two sensors never setting `reason` at
// all. Third sighting of "a gate that passes on a metric it cannot read".
//
// WHY NOT A PLAYBOOK. The obvious-looking fix — give these kinds an
// `acknowledge` playbook, as live-turn-silent-known and
// live-turn-no-transcript-known have — is the WRONG fix and would be a
// regression of the class this branch spent four phases removing. An
// acknowledge playbook resolves with outcome 'applied', and immune/announcer.js
// speaks every 'applied' outcome as "Self-healed: <title>." Nothing is healed
// when a confirm expires. Reporting a heal that did not happen is exactly
// BUG-311/316, and it would also route the anomaly OFF the no-match path, which
// is the only path that runs the explainer at all.
//
// WHY gmail-reauth-required IS NOT IN THIS FILE, though the audit listed it
// beside these two as "no playbook": measured on the same chain, it is already
// correct. gmail-sensor.js sets needsOperator:true and a full reason, so BUG-273
// C2's short-circuit fires, the brain is never asked, and the spoken line
// carries the real instruction. Adding a playbook for it would BREAK a working
// path. Recorded here so the same ground is not re-hunted.
//
// Run: cd mythos && node --test test/bug-324-anomaly-must-report-a-cause-it-knows.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createBus } = require('../src/core/bus/index');
const { createDiagnostician } = require('../src/core/immune/diagnostician');
const { createHealer } = require('../src/core/immune/healer');
const { createExplainer } = require('../src/core/immune/explainer');
const { createLeash } = require('../src/core/leash');
const { createLiveSession } = require('../src/core/voice/live-session');
const { SEED_PLAYBOOKS } = require('../src/core/immune/healer');

// ---------------------------------------------------------------------------
// The wired chain. Deliberately the real modules end to end: the whole point of
// BUG-278 was that every test which injected the payload into the explainer
// passed while the field was being dropped in transit. Anything asserted here is
// asserted on the bus.
// ---------------------------------------------------------------------------
function wire() {
  const state = { asked: 0, prompt: null };
  const logs = [];
  const spoken = [];
  const healed = [];

  const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
  const origEmit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    if (type === 'action.speak-requested') spoken.push(payload.text);
    return origEmit(type, payload);
  };

  // Eager on purpose: it answers a remedy for anything, so a remedy NOT being
  // proposed is this code's doing and not the model declining.
  const brain = {
    async think(req) {
      state.asked++;
      state.prompt = req.messages[0].content;
      return { parsed: { remedy: 'probe_provider' }, content: '{"remedy":"probe_provider"}', offline: false };
    },
  };

  const diag = createDiagnostician({ bus });
  const healer = createHealer({ bus, config: {}, memory: null });
  const explainer = createExplainer({
    bus, brain, config: {}, memory: null,
    logger: { info: (msg, fields) => logs.push({ msg, fields }), warn() {} },
  });

  bus.subscribe('health.healed', (e) => healed.push(e.payload));
  diag.start(); healer.start(); explainer.start();

  return {
    bus, state, spoken, healed,
    emit: async (anomaly) => {
      bus.emit('health.anomaly', anomaly);
      await new Promise((r) => setTimeout(r, 300));
    },
    stop: () => { diag.stop(); healer.stop(); explainer.stop(); },
  };
}

const UNKNOWN_CAUSE = /I do not yet know the cause/;

// ---------------------------------------------------------------------------
// Emitter 1 — the leash's confirm expiry.
// ---------------------------------------------------------------------------
// checkBoundary returns null for "no boundary hit" — a TRUTHY return is a DENY.
function noopIdentity() {
  return { checkBoundary: () => null, getMaxAutonomousTier: () => 4 };
}
function collectingAudit() {
  const writes = [];
  return { write: (row) => writes.push(row), _writes: () => writes };
}
function leashHarness(bus, ttlMs) {
  return createLeash({
    bus,
    config: { LEASH_CONFIRM_TTL_MS: ttlMs, LEASH_MODE: 'assist' },
    identity: noopIdentity(),
    auditWriter: collectingAudit(),
    goals: { get: () => null },
    effectors: { get: () => undefined },
  });
}

describe('BUG-324 — an anomaly that knows its cause must say so', () => {
  it('the leash puts the cause of a confirm expiry on the anomaly, not only in the audit row', (t) => {
    // The audit row already carried reason:'confirm-ttl-expired' before this fix.
    // The anomaly — the thing the operator actually hears about — did not.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createBus({ historySize: 100 });
    const anomalies = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));

    const leash = leashHarness(bus, 1000);
    leash.confirm.create('send the email', { decision: { tool: 'gmail_send', tier: 3 } }, 'conn-A');
    t.mock.timers.tick(1200);

    assert.equal(anomalies.length, 1, 'expiry must still be loud — BUG-119/Wave-1 behaviour');
    const a = anomalies[0];
    assert.equal(a.kind, 'confirm-expired-silently');
    assert.equal(a.target, 'gmail_send', 'the tool must survive the envelope unwrap');
    assert.ok(a.reason, 'the emitter knows the cause and must forward it');
    assert.match(String(a.reason), /timed out|expired|unanswered/i,
      'the reason must name what actually happened, not restate the kind: ' + a.reason);
    assert.equal(a.needsOperator, true,
      'an unanswered prompt is fixed by the operator answering — there is no mechanical remedy '
      + 'to guess, and guessing one is what BUG-273 C2 exists to prevent');
  });

  it('a confirm expiry is spoken with its cause, from a real leash on the real bus chain', async () => {
    // END TO END, AND DELIBERATELY NOT HAND-FED. An earlier draft of this test
    // built the anomaly payload itself with `reason` already on it — and passed
    // against unfixed code, because it was only exercising transit (which
    // BUG-278 already fixed). The reason has to ORIGINATE at the leash and then
    // survive four hops, so the leash is the real one here.
    //
    // Real clock, short TTL: confirm.js reads config.LEASH_CONFIRM_TTL_MS raw
    // (no schema coercion), so 60ms is honoured. A mocked clock cannot be used
    // at all — it would freeze the settle window the async bus needs.
    const h = wire();
    const leash = leashHarness(h.bus, 60);
    leash.confirm.create('click the button', { decision: { tool: 'ui_click', tier: 3 } }, 'conn-A');
    await new Promise((r) => setTimeout(r, 500));
    h.stop();

    assert.equal(h.spoken.length, 1, 'the operator must still be told');
    assert.doesNotMatch(h.spoken[0], UNKNOWN_CAUSE,
      'the cause was on the payload; claiming ignorance of it is the bug: ' + h.spoken[0]);
    assert.match(h.spoken[0], /expired/i, 'the spoken line must carry the real cause');
    assert.equal(h.state.asked, 0,
      'needsOperator must short-circuit the remedy menu — every mechanical remedy is a wrong '
      + 'answer for a prompt nobody answered');
  });

  // -------------------------------------------------------------------------
  // Emitter 2 — a stalled Live turn.
  // -------------------------------------------------------------------------
  it('a stalled Live turn carries a cause built from the deadline it missed', async () => {
    class FakeSocket extends EventEmitter {
      constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
      send(json) { this.sent.push(JSON.parse(json)); }
      close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
      serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
      simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
    }
    const anomalies = [];
    const sockets = [];
    const session = createLiveSession({
      config: { LIVE_TURN_STALL_MS: 40 },
      bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
      logger: { warn() {}, info() {} },
      spend: { recordCall() {} },
      breakers: { allow: () => true, fail() {}, success() {} },
      systemInstruction: 'test instruction',
      functionDeclarations: [],
      onAudioOut: () => {}, onTranscript: () => {}, onState: () => {}, onTurnComplete: () => {},
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });

    process.env.GOOGLE_API_KEY = 'test-key-for-bug-324';
    const opening = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await opening;

    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'what is the weather' } } });
    await new Promise((r) => setTimeout(r, 140));

    const stalls = anomalies.filter((a) => a.kind === 'live-turn-stalled');
    assert.equal(stalls.length, 1, 'BUG-131 behaviour must be unchanged');
    assert.equal(stalls[0].waitedMs, 40, 'the measured wait must still be reported');
    assert.ok(stalls[0].reason, 'the emitter knows how long it waited and must say so');
    assert.match(String(stalls[0].reason), /40/,
      'the cause must be built from the measured wait, not a generic sentence: ' + stalls[0].reason);
    assert.notEqual(stalls[0].needsOperator, true,
      'AD-4: the operator cannot make a model reply. Claiming this needs them would be as '
      + 'dishonest as claiming it was healed');
  });

  // -------------------------------------------------------------------------
  // The two guards that stop this fix from becoming its own defect.
  // -------------------------------------------------------------------------
  it('an anomaly with genuinely no known cause still says the cause is unknown', async () => {
    // VACUITY GUARD. The cheap way to make the sentences above disappear is to
    // delete or weaken honestCauseClause(). That would trade a false "unknown"
    // for a false "known" on every other anomaly in the system, which is worse.
    const h = wire();
    await h.emit({ kind: 'some-condition-nobody-has-diagnosed', target: 'widget' });
    h.stop();

    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0], UNKNOWN_CAUSE,
      'with no reason on the payload the honest sentence is still the right one');
  });

  it('neither kind gains a playbook — nothing is healed, so nothing may be announced as healed', () => {
    // Q8, PIN THE DISPOSITION. This is a deliberate decision not to change
    // behaviour, so it gets a test rather than a comment nobody runs.
    // immune/announcer.js speaks every outcome 'applied' as "Self-healed: X".
    // An acknowledge playbook for either kind would therefore announce a heal
    // that did not occur (BUG-311/316's class) AND take the anomaly off the
    // no-match path, which is the only path that produces the cause sentence
    // this file is about.
    const kinds = SEED_PLAYBOOKS.map((p) => p.when && p.when.kind);
    assert.ok(!kinds.includes('confirm-expired-silently'),
      'a confirm nobody answered was not healed');
    assert.ok(!kinds.includes('live-turn-stalled'),
      'a turn that never arrived was not healed');
    assert.ok(!kinds.includes('gmail-reauth-required'),
      'a revoked OAuth grant is fixed by a human running google-auth.js; a playbook here would '
      + 'route it off the needsOperator path that already handles it correctly');
  });
});
