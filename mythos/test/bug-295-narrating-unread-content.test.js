'use strict';

// test/bug-295-narrating-unread-content.test.js — BUG-295.
//
// THE INCIDENT. 2026-08-20 live voice session. browser_navigate succeeded and
// returned, verbatim from the conversation log:
//
//   {"url":"https://www.google.com/search?q=weather+in+Kolkata+current",
//    "title":"weather in Kolkata current - Google Search","newTab":true,"browser":"chrome"}
//
// No page content. No temperature. No conditions. MYTHOS then told the operator
// it was 28 degrees with thunderstorms and high humidity. Every number and every
// condition was fabricated. get_weather returned ok TEN times the same day — the
// working tool existed and was not used.
//
// ROOT CAUSE, and it is NOT a fourth instance of BUG-273. live-tool-adapter.js
// already carries prohibitions and they are both correct as far as they go:
//   * NO_SUCCESS_CLAIM                                     — outcome FAILED
//   * UNVERIFIED_NO_PROOF_CLAIM / UNVERIFIED_PARTIAL_CLAIM — outcome `unverified`
// There was no guard for the THIRD case: a tool that SUCCEEDS and returns no
// readable body. browser_navigate's payload is a truthful report of a
// NAVIGATION. Nothing in it says "you have not read this page", so the model
// treated a successful navigate as having seen the page and supplied the rest
// from its weights. Nothing lied; nothing hedged either.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The fourth occurrence of "only some
// narration paths carry the honesty sentence" (BUG-068, BUG-116, BUG-273 B1).
// Three is past a pattern, so this file does two things rather than one: it
// asserts the new branch on every narration path (the behavioural matrix), and
// it PINS THE POPULATION of claim constants, so a fifth constant added to one
// branch only fails here rather than in a voice session.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

const ADAPTER_SRC = path.join(__dirname, '..', 'src', 'core', 'voice', 'live-tool-adapter.js');
// BUG-398 R5a: every file a `*_CLAIM` may be declared in. The fifth-constant
// guard below reads all of them.
const SOURCES = [
  ADAPTER_SRC,
  path.join(__dirname, '..', 'src', 'core', 'voice', 'narration-claims.js'),
];

// The prohibition has three jobs, and a test that checks one of them passes on a
// sentence that does not work. It must (a) say no content came back, (b) say the
// page was not read, and (c) forbid the claim LATER — BUG-116 was a 49-second-late
// success claim, and instance A's fabrication came a whole turn after the navigate.
function assertForbidsContentClaim(text, label) {
  assert.ok(text, `${label}: there must be instruction text at all`);
  const s = String(text);
  assert.match(s, /NO page content/i, `${label}: must say no content came back`);
  assert.match(s, /have NOT read/i, `${label}: must say the page was not read`);
  assert.match(s, /later in this conversation/i,
    `${label}: must forbid the claim later too — the fabrication came a turn afterwards`);
}

function baseDeps(overrides) {
  return Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-291', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-291',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  }, overrides || {});
}

// CAPTURED FROM THE WIRE, not hand-built. This is from-browser.js:434's real
// return shape — ok({ url: page.url(), title, newTab, browser }) — carrying the
// exact values from the 2026-08-20 conversation log. A hand-built fixture is how
// BUG-273 C2 passed its tests while being inert.
const NAVIGATE_NO_BODY = {
  ok: true,
  result: {
    url: 'https://www.google.com/search?q=weather+in+Kolkata+current',
    title: 'weather in Kolkata current - Google Search',
    newTab: true,
    browser: 'chrome',
  },
};

// ---------------------------------------------------------------------------
// Path 1 — the awaited branch. browser_navigate is deliberately NOT in
// SLOW_TOOLS (one CDP round-trip), so this is the path instance A came through.
// ---------------------------------------------------------------------------
describe('BUG-295 — path 1: the awaited success branch', () => {
  async function runAwaited(outcome, call, extraDeps) {
    const adapter = createLiveToolAdapter(baseDeps(Object.assign(
      { dispatchAction: async () => outcome }, extraDeps || {})));
    const responses = [];
    await adapter.handleLiveToolCalls([call], { sendToolResponse: (r) => responses.push(...r) });
    return responses[0].response;
  }

  test('a successful browser_navigate is told, in words, that it has not read the page', async () => {
    const response = await runAwaited(NAVIGATE_NO_BODY, {
      id: 'c1',
      name: 'browser_navigate',
      args: { url: 'https://www.google.com/search?q=weather+in+Kolkata+current' },
    });
    assert.equal(response.status, 'ok', 'a successful navigation is still a success — do not fake a failure');
    assertForbidsContentClaim(response.message, 'awaited branch (browser_navigate)');
  });

  test('the URL and title still reach the model — the guard adds, it does not redact', async () => {
    const response = await runAwaited(NAVIGATE_NO_BODY,
      { id: 'c2', name: 'browser_navigate', args: { url: 'https://example.com' } });
    assert.equal(response.result.title, 'weather in Kolkata current - Google Search');
    assert.equal(response.result.browser, 'chrome',
      'Q2: the guard must not hide what came back, or it destroys the evidence trail');
  });

  test('open_web gets it too — the second proven instance', async () => {
    const response = await runAwaited({ ok: true, result: { type: 'web', url: 'https://cnn.com' } },
      { id: 'c3', name: 'open_web', args: { url: 'https://cnn.com' } });
    assertForbidsContentClaim(response.message, 'awaited branch (open_web)');
  });

  // NEGATIVE CONTROL. Without this the fix teaches the model to distrust every
  // result it is ever handed, which is a worse failure than the one being fixed.
  test('a tool that DOES return content is left alone: browser_snapshot', async () => {
    const response = await runAwaited(
      { ok: true, result: { snapshot: 'heading: Weather in Kolkata / text: 31C, haze' } },
      { id: 'c4', name: 'browser_snapshot', args: {} });
    assert.equal(response.status, 'ok');
    assert.equal(response.message, undefined,
      'browser_snapshot IS the read tool — hedging it would gag the model about content it really has');
  });

  test('a tool that DOES return content is left alone: read_file', async () => {
    const response = await runAwaited({ ok: true, result: { content: 'hello' } },
      { id: 'c5', name: 'read_file', args: { path: 'x.txt' } });
    assert.equal(response.message, undefined);
  });

  // Q2 — failure must WIN over no-content. Both could apply to browser_navigate
  // and the stronger claim has to be the one that lands.
  test('a FAILED browser_navigate keeps the failure prohibition, not the no-content one', async () => {
    const response = await runAwaited({ ok: false, result: { error: 'browser-agent connect failed' } },
      { id: 'c6', name: 'browser_navigate', args: { url: 'https://example.com' } });
    assert.match(response.message, /did NOT succeed/i, 'a failure must still read as a failure');
    assert.doesNotMatch(response.message, /have NOT read/i,
      'the no-content wording must not displace the stronger failure prohibition');
  });

  test('an UNVERIFIED browser_navigate keeps the unverified prohibition', async () => {
    const response = await runAwaited({
      ok: true,
      unverified: true,
      reason: 'the page never fired a load event',
      result: { url: 'https://example.com' },
    }, { id: 'c7', name: 'browser_navigate', args: { url: 'https://example.com' } });
    assert.equal(response.status, 'unverified');
    assert.match(response.message, /NO proof either way/i);
    assert.doesNotMatch(response.message, /have NOT read/i,
      'unverified already forbids every claim about the outcome; two prohibitions would disagree');
  });
});

// ---------------------------------------------------------------------------
// Path 2 — reportLateOutcome. browser_navigate is not a SLOW_TOOL, but the
// BUG-128 ack-deadline net puts ANY tool on this path once it outruns the
// deadline, and open_web breached it 44 times in the 2026-08-20 session — more
// breaches than calls. This path is not hypothetical for these two tools.
// ---------------------------------------------------------------------------
describe('BUG-295 — path 2: the late/ack-deadline outcome', () => {
  function makeLateAdapter(outcome) {
    const sentText = [];
    const adapter = createLiveToolAdapter(baseDeps({
      toolAckDeadlineMs: 5,
      dispatchAction: async () => { await new Promise((r) => setTimeout(r, 40)); return outcome; },
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    return { adapter, sentText };
  }

  async function settle() { await new Promise((r) => setTimeout(r, 150)); }

  test('a late successful browser_navigate carries the prohibition, not the neutral default', async () => {
    const { adapter, sentText } = makeLateAdapter(NAVIGATE_NO_BODY);
    await adapter.handleLiveToolCalls(
      [{ id: 'c8', name: 'browser_navigate', args: { url: 'https://example.com' } }],
      { sendToolResponse: () => {} },
    );
    await settle();
    const notice = sentText.at(-1);
    assertForbidsContentClaim(notice, 'reportLateOutcome (browser_navigate)');
    assert.doesNotMatch(notice, /Report this to the operator accurately/,
      'the neutral default is exactly what let the model narrate a page it never read');
  });

  test('a late content-returning tool keeps the neutral default', async () => {
    const { adapter, sentText } = makeLateAdapter({ ok: true, result: { snapshot: 'text: 31C' } });
    await adapter.handleLiveToolCalls(
      [{ id: 'c9', name: 'browser_snapshot', args: {} }],
      { sendToolResponse: () => {} },
    );
    await settle();
    assert.doesNotMatch(sentText.at(-1), /have NOT read/i);
  });

  test('Q2 — the audit record stays a record: no prompt text in the summary', async () => {
    const { adapter } = makeLateAdapter(NAVIGATE_NO_BODY);
    await adapter.handleLiveToolCalls(
      [{ id: 'c10', name: 'browser_navigate', args: { url: 'https://example.com' } }],
      { sendToolResponse: () => {} },
    );
    await settle();
    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.doesNotMatch(String(entry.summary), /have NOT read/i,
      'the prohibition belongs in `instruction`; the record must read as a record');
  });
});

// ---------------------------------------------------------------------------
// Path 3 — resolveLiveConfirm. A confirmation gates INTENT, never content, and
// this is the path that said "It succeeded" over an unprovable ui_type on
// 2026-07-31.
// ---------------------------------------------------------------------------
describe('BUG-295 — path 3: the confirm path', () => {
  function makeConfirmAdapter() {
    const sentText = [];
    let confirmId = null;
    const adapter = createLiveToolAdapter(baseDeps({
      leash: {
        check: () => ({ allow: true, requireConfirm: true, tier: 3, reason: 'above-autonomous-max' }),
        confirm: { create: () => { confirmId = 'confirm-291'; return confirmId; }, reject: () => {} },
      },
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    return { adapter, sentText, id: () => confirmId };
  }

  test('an approved browser_navigate is still told it has not read the page', async () => {
    const { adapter, sentText, id } = makeConfirmAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c11', name: 'browser_navigate', args: { url: 'https://example.com' } }],
      { sendToolResponse: () => {} },
    );
    await adapter.resolveLiveConfirm(id(), NAVIGATE_NO_BODY, true);
    assertForbidsContentClaim(sentText.at(-1), 'resolveLiveConfirm (browser_navigate)');
  });

  test('an approved content-returning tool keeps the neutral default', async () => {
    const { adapter, sentText, id } = makeConfirmAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c12', name: 'browser_snapshot', args: {} }],
      { sendToolResponse: () => {} },
    );
    await adapter.resolveLiveConfirm(id(), { ok: true, result: { snapshot: 'text: 31C' } }, true);
    assert.doesNotMatch(sentText.at(-1), /have NOT read/i);
  });
});

// ---------------------------------------------------------------------------
// Q6, the part BUG-068/BUG-116/BUG-273 each failed to write down. The
// behavioural matrix above covers the constants that exist TODAY. This pins the
// POPULATION, so a fifth constant cannot be added to one branch and left off the
// matrix — the failure names the missing constant instead of waiting for a voice
// session to find it.
// ---------------------------------------------------------------------------
describe('BUG-295 — Q6: the claim-constant population is pinned', () => {
  // Every claim constant that exists, and where its path-matrix proof lives.
  const COVERED = {
    NO_SUCCESS_CLAIM: 'bug-273-unverified-payload.test.js + this file, failure assertions on all paths',
    UNVERIFIED_NO_PROOF_CLAIM: 'bug-273-unverified-payload.test.js, all three paths',
    UNVERIFIED_PARTIAL_CLAIM: 'bug-273-b2-handoff-wording.test.js',
    NO_CONTENT_CLAIM: 'this file, all three paths',
    // BUG-398 R5a (2026-09-02). This guard fired on exactly the case it was
    // written for: a fifth constant added to four narration branches with no
    // matrix entry. Its matrix is all four paths plus the two record sites.
    ABORTED_IN_FLIGHT_CLAIM: 'bug-398-aborted-in-flight-is-not-a-failure.test.js, '
      + 'all four narration paths + actionStatus + the action-outcomes note, with 7 mutation probes',
  };

  test('no claim constant exists without a path-matrix test naming it', () => {
    // BUG-398 R5a: the constants now live in voice/narration-claims.js (the size
    // ratchet forced them out of the adapter). Both files are scanned, so this
    // guard covers a constant declared in EITHER — moving a declaration can no
    // longer make it invisible, which reading only ADAPTER_SRC would have allowed.
    const src = SOURCES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const found = new Set();
    const re = /const ([A-Z][A-Z0-9_]*_CLAIM)\s*=/g;
    let m = re.exec(src);
    while (m) { found.add(m[1]); m = re.exec(src); }
    assert.ok(found.size >= 4,
      `expected at least the four known claim constants, found ${found.size}: ${[...found].join(', ')}`);
    for (const name of found) {
      assert.ok(COVERED[name],
        `claim constant ${name} has no entry in COVERED — add it, and add the path-matrix `
        + 'assertions it needs, in the SAME commit. This is the fifth-constant guard.');
    }
    for (const name of Object.keys(COVERED)) {
      assert.ok(found.has(name), `COVERED names ${name} but it is no longer declared — the matrix is stale`);
    }
  });
});
