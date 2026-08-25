'use strict';

// bug-273-b2-handoff-wording.test.js — BUG-273 B2.
//
// THE INCIDENT (MYTHOS's own words, logged 2026-08-18): *"Open_web: browser:true
// action reports 'unverified' even when successfully handed to default browser,
// causing operator confusion about actual state."* Four hand-offs succeeded that
// session, against 7/7 silent failure before BUG-272 T2 — the mechanism works, and
// the operator still filed an incident about what they were told.
//
// WHY "CHANGE THE REASON STRING" CANNOT FIX IT, which is what B2 was filed as. The
// reason already leads with the positive fact: "handed to your default browser — I
// cannot confirm the page rendered". The alarm is not in the reason, it is in the
// wrapper that BUG-273 B1 put around every unverified outcome the day before. What
// the model actually receives for a working hand-off is:
//
//   "open_web ran but could NOT be confirmed: handed to your default browser — I
//    cannot confirm the page rendered. Do not tell the operator it worked. There is
//    NO proof either way about this action. ... Do NOT say it worked, is done, is
//    open, or is ready, ..."
//
// So B1 made this specific tool WORSE: the model is now explicitly forbidden from
// saying the one thing that is true and useful — that the browser is opening it.
//
// THE REAL DEFECT: `unverified` is carrying two different epistemic states.
//   (a) NOTHING is known. ui_type sent keystrokes and no control reads back; the
//       text may or may not be there. B1's prohibition is exactly right here.
//   (b) A STEP is confirmed and the end state is not. shell.openExternal resolved,
//       which means the OS accepted the URL and dispatched it to the default
//       browser. That is a fact about the world, established by something other
//       than the call's own optimism. Only the render is unknown.
// The evidence contract has verifiedOk (an oracle proved the outcome) and
// unverified (nothing proved anything) and no shape for (b), so (b) was narrated
// as (a).
//
// Q8 — WHAT DELIBERATELY DOES NOT CHANGE. `unverified: true` stays true. The
// hand-off genuinely cannot confirm a render, isVerified() must keep returning
// false, the breaker must keep declining to count it as success, and the HUD must
// keep showing the middle glyph. This adds a clause saying what IS known; it does
// not promote the outcome. Asserted below, because "just make it ok:true" is the
// obvious wrong fix and it is one line away.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const evidence = require('../src/core/effectors/evidence');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// The browser hand-off arrives through an injected SETTER, not the dep bag — see
// setExternalOpener's comment in from-dashboard.js for why it is deliberately null
// outside the Electron shell. Passing it as a dep silently does nothing and the
// call falls to the "desktop shell is not running" refusal, which is a test that
// passes while exercising the wrong branch.
function toolFn(name, opener) {
  const built = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
  });
  if (opener) built.setExternalOpener(opener);
  const t = built.TOOLS.find((x) => x.name === name);
  assert.ok(t, name + ' must still be registered');
  return t.fn;
}

describe('BUG-273 B2 — evidence.unverified can carry the step that IS confirmed', () => {
  it('records confirmedStep without touching the unverified verdict', () => {
    const r = evidence.unverified({ ok: true, result: { url: 'https://x' } },
      'whether the page rendered', { confirmedStep: 'your default browser was handed the URL' });
    assert.equal(r.unverified, true, 'Q8: this is still not a proven outcome');
    assert.equal(r.ok, true, 'and still not a failure — unverified is neither');
    assert.equal(r.confirmedStep, 'your default browser was handed the URL');
    assert.equal(evidence.isVerified(r), false,
      'isVerified gates the HUD tick and the breaker; a confirmed STEP is not a confirmed outcome');
  });

  it('omits the field entirely when there is nothing confirmed to report', () => {
    const r = evidence.unverified({ ok: true }, 'no readable text pattern');
    assert.equal('confirmedStep' in r, false,
      'absent, not empty — a blank confirmedStep would read as "a step was confirmed" downstream');
    assert.equal(r.unverified, true);
  });

  it('ignores a non-string or blank confirmedStep rather than emitting a hollow claim', () => {
    for (const bad of [{ confirmedStep: '' }, { confirmedStep: '   ' }, { confirmedStep: 42 }, { confirmedStep: null }]) {
      const r = evidence.unverified({ ok: true }, 'reason', bad);
      assert.equal('confirmedStep' in r, false, `confirmedStep ${JSON.stringify(bad)} must not survive`);
    }
  });
});

describe('BUG-273 B2 — the browser hand-off says what it knows', () => {
  const opener = async () => ({ opened: true });

  it('reports the hand-off as confirmed and the render as not', async () => {
    const res = await toolFn('open_web', opener)(
      { type: 'web', browser: true, url: 'https://www.google.com/maps' });
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true, 'Q8: the render is still unproven and must stay unproven');
    assert.match(String(res.confirmedStep || ''), /browser/i,
      'the operator-facing fact is that their browser was handed the URL');
    assert.match(String(res.reason || ''), /render/i,
      'and the reason narrows to the ONLY thing that is actually unknown');
    assert.doesNotMatch(String(res.reason || ''), /handed to your default browser/,
      'the positive half moves out of `reason` so it is not repeated on both sides');
  });

  it('a FAILED hand-off is untouched and still fails', async () => {
    const res = await toolFn('open_web', async () => ({ opened: false, reason: 'no handler' }))(
      { type: 'web', browser: true, url: 'https://example.com' });
    assert.equal(res.ok, false, 'a refused hand-off is a real failure, not a partial success');
    assert.doesNotMatch(String(res.result || ''), /confirmed/i);
  });
});

describe('BUG-273 B2 — the Live narration leads with the confirmed part', () => {
  function baseDeps(overrides) {
    return Object.assign({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'c', reject: () => {} },
      },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit() {} },
      logger: { warn() {}, info() {}, error() {} },
      connectionId: 'conn-b2',
      memory: { working: {}, episodic: { write: async () => {} } },
      historyAppend: () => {},
      reflection: { noteTurn() {} },
      summarizeActionsForResult: () => null,
      getLiveSession: () => null,
      sanitizeErrorForClient: (e) => String((e && e.message) || e),
    }, overrides || {});
  }

  // open_web is deliberately NOT in SLOW_TOOLS (see the note on that list), so it
  // takes the awaited branch and answers inside the turn.
  async function narrate(outcome) {
    const adapter = createLiveToolAdapter(baseDeps({ dispatchAction: async () => outcome }));
    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'b2', name: 'open_web', args: { type: 'web', browser: true, url: 'https://maps.google.com' } }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    return { response: responses[0].response, adapter };
  }

  const HANDOFF = {
    ok: true,
    unverified: true,
    confirmedStep: 'your default browser was handed the URL',
    reason: 'whether the page rendered',
    result: { widgetType: 'newtab', url: 'https://maps.google.com', handedToBrowser: true },
  };

  it('states the confirmed step and does NOT forbid saying it', async () => {
    const { response } = await narrate(HANDOFF);
    assert.equal(response.status, 'unverified', 'Q8: the wire status is unchanged');
    const m = String(response.message);
    assert.match(m, /your default browser was handed the URL/, 'the true, useful fact must be present');
    assert.match(m, /IS confirmed/i, 'and marked as confirmed, not buried in a list of doubts');
    // The regression this test exists for: B1's shared claim forbids "is open" /
    // "is ready" / "worked", which for a working hand-off gags the model about the
    // only thing it actually knows.
    assert.doesNotMatch(m, /Do NOT say it worked, is done, is open/,
      "the all-or-nothing prohibition must not apply when a step IS confirmed");
    assert.match(m, /do not claim the rest|not confirmed/i, 'the unknown half must still be fenced off');
    assert.match(m, /render/i, 'and named specifically');
  });

  it('an outcome with NOTHING confirmed keeps B1 prohibition verbatim', async () => {
    // The ui_type case. B1 exists because this was narrated as success, and B2 must
    // not weaken it while fixing its sibling.
    const { response } = await narrate({
      ok: true, unverified: true,
      reason: 'the focused control exposes neither ValuePattern nor TextPattern',
      result: { typed: true },
    });
    const m = String(response.message);
    assert.match(m, /could NOT be confirmed/, 'unchanged for the nothing-is-known case');
    assert.match(m, /Do NOT say it worked, is done, is open/, "B1's prohibition stays intact");
    assert.doesNotMatch(m, /IS confirmed/i, 'nothing was, so nothing may be claimed');
  });

  it('Q2 — the audit record keeps both halves and no prompt text', async () => {
    const { adapter } = await narrate(HANDOFF);
    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.equal(entry.unverified, true);
    assert.equal(entry.ok, false, 'AD-4: an unproven outcome is not an ok one, hand-off or not');
    assert.match(entry.summary, /browser/i, 'the record says what happened');
    assert.doesNotMatch(entry.summary, /Do NOT|do not claim/i,
      'prompt text still does not belong in the audit/episodic record');
  });

  it('Q4 — the payload stays hedged: handedToBrowser is not left bare at the top level', async () => {
    const { response } = await narrate(HANDOFF);
    assert.equal(response.result.handedToBrowser, undefined,
      'B1 nested the raw payload for exactly this reason; a confirmed STEP does not un-nest it');
    assert.equal(response.result.confirmed, false);
    assert.equal(response.result.unconfirmedDetails.handedToBrowser, true, 'and the data survives');
  });
});
