'use strict';

// bug-278-remedy-fit-must-survive-the-wire.test.js — BUG-278.
//
// BUG-273 C2 shipped two controls on 2026-08-18 to stop the immune system proposing
// `probe_provider` for a revoked Google OAuth token: a `needsOperator` flag on the
// anomaly ("terminal, human-only, do not guess a remedy") and a `reason` carrying the
// complete operator instruction. The 2026-08-20 session audit then found MYTHOS
// proposing `probe_provider` against Gmail again, and against an empty target twice.
//
// C2 was not wrong. It was INERT. Measured on the wired production chain
// (bus -> diagnostician -> healer -> explainer) on 2026-08-20:
//
//   needsOperator present? false     reason present? false     detail: null
//   brain asked for a remedy? 1 (C2 intended 0)
//   prompt offered probe_provider? true
//   spoken: "...gmail-reauth-required in gmail. I do not yet know the cause."
//
// diagnostician.js:57 preserves the whole anomaly under `evidence`, but healer.js's
// health.healed emit forwarded only kind/target/outcome/detail — so both C2 fields were
// dropped one hop before the only module that reads them. The operator heard "I do not
// yet know the cause" for an anomaly that had shipped a full sentence naming the fix.
//
// WHY EVERY C2 TEST PASSED ANYWAY (Stage 4 #5 — a fixture more generous than the wire):
// they all call `explainer._onHealed({payload: {...needsOperator: true, reason: '...'}})`,
// injecting fields the bus never delivers. This file drives the real bus instead. That
// is the only fixture shape that can catch a field lost in transit, and it is why the
// tests here wire four modules together rather than reaching for the seam.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? Two known repo classes at once:
//   1. "a gate that passes on a metric it cannot read" — a control keyed on a field its
//      own transport discards. Third sighting (verify-voice-session.js:205-232 documents
//      the first two).
//   2. "inert mechanisms look like coverage" — documented, tested, and never applied.
// The assertion that stops a fourth is here: the fields are asserted ON THE WIRE, not on
// a hand-built payload.
//
// Run: cd mythos && node --test test/bug-278-remedy-fit-must-survive-the-wire.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createBus } = require('../src/core/bus/index');
const { createDiagnostician } = require('../src/core/immune/diagnostician');
const { createHealer } = require('../src/core/immune/healer');
const { createExplainer } = require('../src/core/immune/explainer');

// The brain that produced the live failure: it answers probe_provider for anything.
// Kept deliberately eager so a remedy reaching the apply path is the test's doing and
// not the model's restraint.
function eagerBrain(state) {
  return {
    async think(req) {
      state.asked++;
      state.prompt = req.messages[0].content;
      return { parsed: { remedy: 'probe_provider' }, content: '{"remedy":"probe_provider"}', offline: false };
    }
  };
}

function quietBrain(state) {
  return {
    async think(req) {
      state.asked++;
      state.prompt = req.messages[0].content;
      return { parsed: { remedy: 'none' }, content: '{"remedy":"none"}', offline: false };
    }
  };
}

// Wires the PRODUCTION chain. Nothing here reaches past a seam: the anomaly is emitted
// on the bus exactly as a sensor emits it, and every hop in between is the real module.
function wire(opts = {}) {
  const state = { asked: 0, prompt: null };
  const logs = [];
  const spoken = [];
  const healedPayloads = [];

  const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
  const origEmit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    if (type === 'action.speak-requested') spoken.push(payload.text);
    return origEmit(type, payload);
  };

  const diag = createDiagnostician({ bus });
  const healer = createHealer({ bus, config: {}, memory: null });
  const explainer = createExplainer({
    bus,
    brain: (opts.brain || eagerBrain)(state),
    config: {},
    memory: null,
    logger: { info: (msg, fields) => logs.push({ msg, fields }), warn: () => {} },
  });

  bus.subscribe('health.healed', (e) => {
    if (e.payload && e.payload.outcome === 'no-match') healedPayloads.push(e.payload);
  });

  diag.start(); healer.start(); explainer.start();

  // The bus is asynchronous and explain() is async on top of it, so a settle window is
  // unavoidable here. Kept small; every assertion below is on captured state, never on
  // a race.
  const emit = async (anomaly) => {
    bus.emit('health.anomaly', anomaly);
    await new Promise((r) => setTimeout(r, 300));
  };

  const remedy = () => (logs.filter((l) => l.msg === 'immune-explain').pop() || { fields: {} }).fields.remedy;
  const refusals = () => logs.filter((l) => l.msg === 'immune-explain.remedy-refused');
  const stop = () => { diag.stop(); healer.stop(); explainer.stop(); };

  return { emit, state, logs, spoken, healedPayloads, remedy, refusals, stop };
}

// The exact payload gmail-sensor.js:84-101 puts on the bus. Built from the emitter, not
// from what the explainer wishes it received.
const GMAIL_ANOMALY = {
  kind: 'gmail-reauth-required',
  target: 'gmail',
  needsOperator: true,
  reason: 'Gmail has stopped working and it will not recover on its own: the Google refresh '
    + 'token is expired or revoked. Nothing was read. Re-authorise by running '
    + '`node scripts/google-auth.js` and putting the new GOOGLE_REFRESH_TOKEN in mythos/.env.',
  detail: 'invalid_grant',
};

describe('BUG-278 — the fields that decide whether a remedy fits must survive the wire', () => {
  it('the healer forwards needsOperator and reason on the no-match path', async () => {
    // The transport assertion. Everything C2 does depends on these two fields arriving,
    // and nothing before this test checked that they do.
    const h = wire();
    await h.emit(GMAIL_ANOMALY);
    h.stop();

    assert.equal(h.healedPayloads.length, 1, 'a playbook-less anomaly must reach the no-match path');
    const p = h.healedPayloads[0];
    assert.equal(p.needsOperator, true,
      'dropped here, BUG-273 C2 cannot fire at all — the flag exists to stop a remedy being guessed');
    assert.match(String(p.reason), /google-auth\.js/,
      'the sensor shipped the complete instruction; losing it is how the operator heard "I do not yet know the cause"');
  });

  it('a terminal credential fault never reaches the brain on the real bus path', async () => {
    // Asserts the MECHANISM (the model was never consulted), not the returned remedy.
    // A 'none' produced by refusing the model's answer afterwards is the bug wearing a
    // fix's clothes: the round trip still happened and the prompt still offered a
    // remedy that cannot work.
    const h = wire();
    await h.emit(GMAIL_ANOMALY);
    h.stop();

    assert.equal(h.state.asked, 0,
      'the anomaly already names the only thing that fixes it — asking a model to pick between '
      + 'mechanical remedies can only produce a wrong one');
    assert.equal(h.remedy(), 'none');
    assert.equal(h.refusals().length, 0, 'nothing was proposed, so there is nothing to refuse');
  });

  it('and the operator hears the sensor instruction rather than "I do not yet know the cause"', async () => {
    const h = wire();
    await h.emit(GMAIL_ANOMALY);
    h.stop();

    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0], /google-auth\.js/, 'the reason carries the fix; it must be spoken');
    assert.doesNotMatch(h.spoken[0], /I do not yet know the cause/,
      'the cause was supplied by the emitter — claiming ignorance of it is the field loss talking');
    assert.doesNotMatch(h.spoken[0], /re-probing/,
      'a dead Google token must never be answered with an AI-provider re-probe');
  });

  it('an anomaly with no target does not reach the brain at all', async () => {
    // Not an edge case: 91 of this tree's 104 health.anomaly emit sites carry no target
    // (only 13 do). With no target, suppress_tool cannot act and probe_provider is not
    // applicable to the kind, so the menu is empty and there is nothing to ask.
    // cortex/index.js:285 emits this shape, and no playbook matches 'tick-error'.
    const h = wire();
    await h.emit({ kind: 'tick-error', error: 'boom', tick: 12, consecutive: 1 });
    h.stop();

    assert.equal(h.state.asked, 0, 'a remedy menu with nothing on it is not a question worth a round trip');
    assert.equal(h.remedy(), 'none');
    assert.equal(h.refusals().length, 0,
      'the audit saw probe_provider proposed against an empty target twice — it must not be offered');
    assert.equal(h.spoken.length, 1, 'the condition is still announced; only the remedy guess is gone');
    assert.match(h.spoken[0], /tick-error/);
  });

  it('probe_provider IS offered for the provider anomaly that actually reaches this path', async () => {
    // THE CASE THE OLD GUARD REFUSED. quota-low carries `q.provider` (probes.js:58) and
    // its playbook only matches target eq 'groq' (healer.js:86) — so a quota-low for
    // mistral/nim/gemini lands here with a real AI provider as its target. The previous
    // allowlist held lane names ('brain','voice','simple'...), which no emitter in this
    // tree produces, so it logged "not an AI provider" about an actual AI provider.
    const h = wire({ brain: quietBrain });
    await h.emit({ kind: 'quota-low', target: 'mistral', evidence: { provider: 'mistral', remaining: 2 } });
    h.stop();

    assert.equal(h.state.asked, 1, 'this one has an applicable mechanical remedy, so the brain is asked');
    assert.match(String(h.state.prompt), /probe_provider/,
      'a provider running out of quota is exactly what a registry re-probe is for');
    assert.equal(h.refusals().length, 0);
  });

  it('and it is NOT offered for a fault a re-probe cannot touch', async () => {
    // The negative control for the test above: same harness, same brain, a target-bearing
    // anomaly whose subject is not a provider. Proves the menu discriminates rather than
    // always containing everything (or always being empty).
    const h = wire({ brain: quietBrain });
    await h.emit({ kind: 'effector-throw', target: 'spotify_play', error: 'window not found' });
    h.stop();

    assert.equal(h.state.asked, 1);
    assert.doesNotMatch(String(h.state.prompt), /probe_provider/,
      'an effector throwing must not put the AI provider registry on the menu');
    assert.match(String(h.state.prompt), /suppress_tool/,
      'a tool-shaped target is the one thing suppress_tool can legitimately act on');
  });
});
