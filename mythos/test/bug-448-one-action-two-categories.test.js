'use strict';

// test/bug-448-one-action-two-categories.test.js — BUG-448.
//
// THE INCIDENT, 2026-09-23 13:59:43–14:00:22 (attended run). `launch_app
// {"name":"notepad"}` completed ok at 13:59:46. MYTHOS said "Opening a new
// Notepad window right now." At 13:59:49.734 the claim checker logged
// `claimed-action-not-taken target=window-control` and queued
// ad4-correction-retract, and MYTHOS then told the operator the window "didn't
// actually open after all". It had.
//
// MECHANISM (src/core/voice/claim-check.js). Two categories matched the same
// words. `opening`'s progressive tier matched "Opening … right now" and was
// backed by the successful launch_app. `window-control`'s progressive tier
// matched "Opening a new Notepad window" — "window" means an application window
// AND a HUD panel, and the table cannot tell them apart — and its tools
// (close_panel, close_window, manage_widget, spawn_widget) had not run. Each
// category was judged alone, so one unbacked match was enough to retract.
//
// WHY NOT A FIFTH TABLE PATCH. The file records the same gap four times, each
// closed by adding a tool to one category (F1b, BUG-398 row 7, BUG-434,
// BUG-441). Adding launch_app to window-control would make "any launch backs
// any panel" true, which is the blanket exception the plan rules out: a
// successful launch_app would then back "Closing the news widget".
//
// THE RULE NOW. Within one sentence, matches whose TEXT OVERLAPS describe one
// action and are judged together: if any of them is backed by a successful
// tool, the others are excused — unless their own category's tool actually
// FAILED this turn, which is direct counter-evidence about the very action
// claimed. Matches that do not overlap are independent claims and stay
// independent. Overlap is transitive (A overlaps B, B overlaps C: one group).
//
// RED FIRST, 2026-09-23, against e1f9f998 (the BUG-432 commit): (a), (a2), (g),
// (h) and (i) failed — window-control flagged, and no grouping existed. The
// adjacent cases (b)–(f) passed on the old code, as they must.
//
// THE FIRST CUT WAS INCOMPLETE, AND (i) SAID SO. Grouping alone turned (a)–(h)
// green and left (i) — the real adapter — red: see the slow-tool block below.
// (a3), (a4), (j) were written from that finding and fail on e1f9f998 too.
// (k) is their adjacent case and passes there. (l) bounds the new returned-call
// rule — only the SAME call ends a started row — and fails on e1f9f998 only
// because window-control retracted the sentence there.
//
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { detectUnbackedClaims, _internal } = require('../src/core/voice/claim-check');

const ok = (tool) => ({ tool, ok: true, dispatchOk: true });
const failed = (tool) => ({ tool, ok: false, dispatchOk: false });
const categories = (claims) => claims.map((c) => c.category).sort();

describe('BUG-448 — one action described by two categories is judged once', () => {
  test('(a) THE RECORDED SENTENCE: "Opening a new Notepad window right now." over a successful launch_app is not retracted', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.', [ok('launch_app')], []);
    assert.deepEqual(categories(claims), [],
      'window-control matched the same words as opening, and opening was backed — the 13:59:49 false retraction');
  });

  test('(a2) the same without "now" (the incident tier): still one action, still backed', () => {
    const claims = detectUnbackedClaims('Opening the Notepad window for you.', [ok('launch_app')], [], { voiceHonesty: true });
    assert.deepEqual(categories(claims), []);
  });

  test('(b) ADJACENT — widget-only and unbacked: "Closing the news widget now." with only a launch_app behind it IS flagged', () => {
    const claims = detectUnbackedClaims('Closing the news widget on the HUD now.', [ok('launch_app')], []);
    assert.deepEqual(categories(claims), ['window-control'],
      'an unrelated successful tool must not back a claim no overlapping category made — no "any launch backs any panel"');
  });

  test('(c) ADJACENT — compound: two actions in one sentence are two claims', () => {
    const claims = detectUnbackedClaims('I launched Notepad, and I closed the news widget.', [ok('launch_app')], []);
    assert.deepEqual(categories(claims), ['window-control'],
      'the launch is backed; the widget closing is a separate claim with nothing behind it');
  });

  test('(d) ADJACENT — counter-evidence still retracts: the overlapping category\'s OWN tool failed this turn', () => {
    const claims = detectUnbackedClaims('Opening the music widget panel now.', [ok('launch_app'), failed('spawn_widget')], []);
    assert.deepEqual(categories(claims), ['window-control'],
      'spawn_widget failed: that is evidence about the very action claimed, and a sibling\'s success cannot overrule it');
  });

  test('(e) ADJACENT — nothing ran at all: both overlapping categories stay unbacked, and both are reported', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.', [], []);
    assert.deepEqual(categories(claims), ['opening', 'window-control']);
  });

  test('(f) ADJACENT — repeated categories: one flag per category per reply is unchanged', () => {
    const claims = detectUnbackedClaims('Closing the news widget now. Closing the weather panel now.', [], []);
    assert.deepEqual(categories(claims), ['window-control']);
  });
});

// The SLOW_TOOLS path — launch_app is on it — records a 'started' row and, later,
// a result row with the SAME traceId, and both stay in the turn. That is the shape
// the incident actually had, and the one the first cut of this fix missed: (a)
// went green on rows the adapter never produces, and (i) below, through the real
// adapter, stayed red. The stale 'started' row made launch_app look pending, which
// silenced opening's progressive tier, so window-control was judged alone anyway.
const started = (tool, traceId) => ({ tool, ok: null, started: true, status: 'pending', traceId });
const returned = (tool, traceId, isOk) => ({ tool, ok: isOk, dispatchOk: isOk, traceId });

describe('BUG-448 — the slow-tool shape: a started row whose call has returned is not pending', () => {
  test('(a3) THE INCIDENT\'S REAL ROWS: started + returned-ok for one call, the recorded sentence is not retracted', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.',
      [started('launch_app', 'c1'), returned('launch_app', 'c1', true)], []);
    assert.deepEqual(categories(claims), []);
  });

  test('(a4) started + returned-FAILED: the claim is flagged — the stale row no longer excuses a failed launch', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.',
      [started('launch_app', 'c1'), returned('launch_app', 'c1', false)], []);
    assert.deepEqual(categories(claims), ['opening', 'window-control'],
      'with the stale row counted as pending, opening was skipped entirely and a FAILED launch went unchallenged');
  });

  test('(j) GENUINELY in flight: "opening … right now" is true, and the overlapping "window" is judged with it', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.', [started('launch_app', 'c1')], []);
    assert.deepEqual(categories(claims), [],
      'the launch is under way, so the sentence is true; window-control alone used to retract it');
  });

  test('(k) ADJACENT: an in-flight launch does not excuse a widget claim it does not overlap', () => {
    const claims = detectUnbackedClaims('Closing the news widget now.', [started('launch_app', 'c1')], []);
    assert.deepEqual(categories(claims), ['window-control']);
  });

  test('(l) ADJACENT: a started row of ANOTHER call is still pending', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.',
      [returned('launch_app', 'c0', false), started('launch_app', 'c1')], []);
    assert.deepEqual(categories(claims), [], 'c1 has not returned; an earlier failed call c0 does not end it');
  });
});

describe('BUG-448 — what counts as counter-evidence', () => {
  test('(m) a failure turns AGO of the overlapping category\'s tool is about another act: it does not block the excuse', () => {
    const claims = detectUnbackedClaims('Opening a new Notepad window right now.',
      [ok('launch_app')], [failed('close_panel')]);
    assert.deepEqual(categories(claims), [],
      'counter-evidence is THIS turn\'s failure of the claimed act, not any failure in the evidence window');
  });

  test('(n) the evidence-gated (elliptical) tier IS counter-evidence, even when its failure is from an earlier turn', () => {
    const claims = detectUnbackedClaims("Opening WhatsApp now, 'hi' has been sent.",
      [ok('launch_app')], [failed('whatsapp_send')]);
    assert.ok(categories(claims).includes('sending'),
      'a send that was attempted and failed is direct evidence against "has been sent"; a sibling launch must not excuse it: '
      + JSON.stringify(claims));
  });
});

describe('BUG-448 — overlap is transitive and exact', () => {
  test('(g) a chain A~B, B~C with A and C disjoint is ONE group', () => {
    const groups = _internal.groupOverlapping([
      { id: 'A', start: 0, end: 10 }, { id: 'B', start: 8, end: 20 }, { id: 'C', start: 18, end: 30 }, { id: 'D', start: 31, end: 40 },
    ]);
    assert.deepEqual(groups.map((g) => g.map((h) => h.id).sort()), [['A', 'B', 'C'], ['D']]);
  });

  test('(h) touching is not overlapping: [0,10) and [10,20) are two claims', () => {
    const groups = _internal.groupOverlapping([{ id: 'A', start: 0, end: 10 }, { id: 'B', start: 10, end: 20 }]);
    assert.equal(groups.length, 2);
  });
});

describe('BUG-448 — through the real adapter: the true launch is not retracted aloud', () => {
  test('(i) launch_app ok, then the recorded sentence: no ad4-correction-retract is sent', async () => {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
    const sent = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'confirm-448', reject: () => {} } },
      dispatchAction: async () => ({ ok: true, result: { launched: true, pid: 4242 } }),
      bus: { emit() {} }, logger: { info() {}, warn() {} }, connectionId: 'conn-448', toolResultHoldMaxMs: 0, // BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins
      memory: { working: { tick: 1 }, episodic: { write: async () => {} } }, historyAppend: () => {},
      reflection: null, summarizeActionsForResult, config: {},
      getLiveSession: () => ({ isOpen: () => true, sendText: (text, meta) => { sent.push(meta && meta.site); return true; } }),
    });
    await adapter.handleLiveToolCalls([{ id: 'c448', name: 'launch_app', args: { name: 'notepad' } }], { sendToolResponse: () => {} });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(sent.includes('late-outcome'), 'fixture check: the launch completed and was reported, as at 13:59:46');
    adapter.onLiveTurnComplete({ userText: 'open notepad', assistantText: 'Opening a new Notepad window right now.' });
    assert.deepEqual(sent.filter((s) => /^ad4-correction/.test(s)), [],
      'MYTHOS told the operator a window that had opened "didn\'t actually open after all"');
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug448/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All 17 tests were
// GREEN before each one.
//
//   N1  no grouping excuse (every category judged alone)  -> (a)(a2)(a3)(j)(i)…
//   N2  counter-evidence ignored                          -> (d)(n)
//   N3  a started row stays pending after its call returned -> (a4)
//   N4  ANY returned call ends every started row          -> (l)
//   N5  an in-flight match is not recorded (old skip)     -> (j)(l)
//   N6  touching spans count as overlapping               -> (h)
//   N7  grouping not transitive                           -> (g)
//   N8  counter-evidence from the whole window, not this turn -> (m)
//   N9  the elliptical tier is not counter-evidence       -> (n)
//   N10 FIXTURE: the started and returned rows in REVERSE order -> stays green,
//       as it must: the rule keys on the call id, not on row position.
//
// NOT COVERED, AND SAID SO:
//   * Overlap is judged on the matched TEXT. Two categories that describe one
//     action in words that do not overlap ("Opening Notepad. The window is up.")
//     are still judged apart; nothing measured says that shape occurs.
//   * The category table still cannot tell a HUD panel from an application
//     window. This fix stops the two descriptions contradicting each other; it
//     does not teach window-control what a window is.
//   * A progressive claim about a call still in flight is taken as true. If that
//     call later fails, the late-outcome report carries the failure; this
//     detector does not re-judge the earlier sentence.
