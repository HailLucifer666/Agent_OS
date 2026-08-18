'use strict';

// bug-273-c2-remedy-must-fit-the-fault.test.js — BUG-273 C2, second half.
//
// LIVE-CAUGHT, 2026-08-18T18:15:48Z, three seconds after boot, in the operator's own
// session — and reported by the operator as "Gmail is still failing":
//
//   {"msg":"immune-explain","kind":"gmail-reauth-required","target":"gmail",
//    "remedy":"probe_provider"}
//
// C2 worked: the sensor found the revoked refresh token on its first poll and
// announced it instead of discarding it. Then the immune explainer handed the
// anomaly to the brain to pick a remedy, and the brain chose **probe_provider** —
// so MYTHOS ran `registry.refresh(true)` against the AI PROVIDER registry and told
// the operator "I'm re-probing the AI providers now."
//
// Two separate faults, and the second is the one that matters:
//
//   1. It is a lie by implication. Nothing about re-probing Gemini or Mistral can
//      re-mint a Google OAuth refresh token. The operator hears remediation in
//      progress, waits, and Gmail keeps failing — which is exactly the report.
//      This is the same class as B1: an action narrated as more resolved than it is.
//   2. It fires a real side effect on an UNRELATED subsystem. A Gmail credential
//      expiring now perturbs the brain provider registry.
//
// Q1 — WHAT ELSE MATCHES THIS? Every anomaly, from every sensor, goes through this
// same call. The prose said "Choose probe_provider ONLY if an AI provider seems
// down" and the model picked it for a mail account, so the instruction is not the
// control — a model's answer is untrusted input and has to be REJECTED AT THE EDGE,
// not requested politely. Hence the second fix here: probe_provider is refused
// unless the target actually is an AI provider, in code.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? A remedy chosen for a fault it cannot
// address. The narrow fix (this one kind) would leave every future terminal
// credential fault free to trigger the same thing, so both halves are here: the
// anomaly declares that it needs a human, and the remedy allowlist is enforced.
//
// Q8 — PIN THE DISPOSITION: no retry is added, here or anywhere. A revoked token is
// terminal by construction and hub.js's isTerminalResult already keeps the breaker
// from treating it as retryable. The correct outcome is "this one needs your
// attention", which is what remedy 'none' already says.
//
// Run: cd mythos && node --test test/bug-273-c2-remedy-must-fit-the-fault.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createExplainer } = require('../src/core/immune/explainer');

// The brain that produced the live failure: it answers probe_provider for anything.
const EAGER_BRAIN = {
  think: async () => ({ parsed: { remedy: 'probe_provider' }, content: '{"remedy":"probe_provider"}' }),
};

// Driven through _onHealed, the way the bus drives it — explain() is internal and
// reaching past the seam would test a path production does not take.
function harness(opts = {}) {
  const logs = [];
  const spoken = [];
  const explainer = createExplainer({
    bus: {
      emit: (type, payload) => { if (type === 'action.speak-requested') spoken.push(payload.text); },
      subscribe: () => () => {},
    },
    brain: opts.brain || EAGER_BRAIN,
    config: {},
    logger: { info: (msg, f) => logs.push({ msg, fields: f }), warn: () => {} },
    memory: null,
  });
  const fire = (payload) => explainer._onHealed({
    payload: Object.assign({ outcome: 'no-match' }, payload),
  });
  const remedy = () => (logs.filter((l) => l.msg === 'immune-explain').pop() || { fields: {} }).fields.remedy;
  return { fire, logs, spoken, remedy };
}

const GMAIL_ANOMALY = {
  kind: 'gmail-reauth-required',
  target: 'gmail',
  needsOperator: true,
  reason: 'Gmail has stopped working and it will not recover on its own: the Google refresh '
    + 'token is expired or revoked. Re-authorise by running `node scripts/google-auth.js`.',
};

describe('BUG-273 C2 — a remedy must be able to fix the fault it is chosen for', () => {
  it('an anomaly that declares needsOperator never asks the brain for a remedy at all', async () => {
    let asked = false;
    const h = harness({ brain: { think: async () => { asked = true; return { parsed: { remedy: 'probe_provider' } }; } } });
    await h.fire(GMAIL_ANOMALY);

    assert.equal(asked, false,
      'the anomaly already names the only thing that fixes it — asking a model to guess '
      + 'between three mechanical remedies can only ever produce a wrong one');
    assert.equal(h.remedy(), 'none');
  });

  it('and says plainly that it needs the operator, rather than implying it is being handled', async () => {
    const h = harness();
    await h.fire(GMAIL_ANOMALY);
    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0], /needs your attention/,
      'the live session said "I am re-probing the AI providers now" for a dead Google token');
    assert.doesNotMatch(h.spoken[0], /re-probing/);
    // The reason survives — it carries the actual command, and it is the whole point
    // of the sensor half of C2.
    assert.match(h.spoken[0], /google-auth.js/);
  });

  it('probe_provider is REFUSED for a target that is not an AI provider', async () => {
    // Rejected at the edge. The prose instruction "ONLY if an AI provider seems down"
    // was already there and the model ignored it for a mail account; a model's answer
    // is untrusted input, so the guard belongs in code.
    const h = harness();
    await h.fire({ kind: 'some-future-anomaly', target: 'whatsapp', reason: 'the window vanished' });
    assert.notEqual(h.remedy(), 'probe_provider',
      'a WhatsApp window disappearing must not perturb the brain provider registry');
    assert.match(h.spoken[0], /needs your attention/);
  });

  it('probe_provider still works where it belongs', async () => {
    // Q8: the mechanism is not removed, only aimed. An AI provider actually being down
    // is what it was built for and must still reach it.
    const h = harness();
    await h.fire({ kind: 'provider-unreachable', target: 'brain', reason: 'every lane timed out' });
    assert.equal(h.remedy(), 'probe_provider');
    assert.match(h.spoken[0], /re-probing/);
  });

  it('the refusal is logged, so a silently-downgraded remedy is visible', async () => {
    // Q2: a guard that quietly swallows the model's answer would make the next
    // "why did nothing happen?" investigation start from zero.
    const h = harness();
    await h.fire({ kind: 'x', target: 'whatsapp', reason: 'y' });
    const refused = h.logs.filter((l) => l.msg === 'immune-explain.remedy-refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].fields.remedy, 'probe_provider');
    assert.equal(refused[0].fields.target, 'whatsapp');
  });
});
