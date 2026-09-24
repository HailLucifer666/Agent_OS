'use strict';

// BUG-462 — a browser action is verified by the effect it was FOR, not by the
// page answering a question.
//
// 2026-09-24, attended run: browser_click on ref f2e308 completed ok at 15:11:24,
// and at 15:11:33 MYTHOS said "I've also clicked the third video for you, the
// 'Café Ambience' mix. It should be starting up now." The debug browser's only
// page was still https://www.youtube.com/results?search_query=lofi+music. The
// click carried evidence (oracle page-state): the old capsule read url, title
// and focus AFTER the click and called any answer proof. Every ref click, type,
// key press and hover returned verified that way, whatever happened (class 14);
// the selector click, selector type, scroll and fill_form returned a plain ok.
//
// Reproduced before the fix, through the real browser_click with a page that
// does not change: {ok:true, unverified:false, evidence:{oracle:'page-state'}}.
//
// What this file pins: the pure judge over the action x before/after matrix
// (gate C); each tool through its real code path; the 15:11:24 shape; the
// settle wait and popup association the old code never had; that a typed value
// is never echoed; the tab pin; and gate F — the resulting unverified click,
// through the real Live adapter, gets the 15:11:33 sentence retracted.
//
// Mutation probes and their dated results are recorded in BUGS.md, BUG-462's
// Proof paragraph, and in the commit that added this file.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { judgeEffect, CLICK_SETTLE_MS } = require('../src/core/effectors/browser-effect');
const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);
const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');

const RESULTS = 'https://www.youtube.com/results?search_query=lofi+music';
const WATCH = 'https://www.youtube.com/watch?v=cafe123';

let saved;
function stubOnline() {
  saved = { withPage: realBrowserAgent.withPage, getStatus: realBrowserAgent.getStatus, ensureOnline: realBrowserAgent.ensureOnline };
  realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
  realBrowserAgent.ensureOnline = async () => {};
}
function restore() {
  Object.assign(realBrowserAgent, saved);
  delete require.cache[FROM_BROWSER];
}

// A page whose state the test mutates from inside the action, so "before" and
// "after" really differ the way a browser's would. `dom` is what page.evaluate
// reports; the fake ignores the function it is given, like the other fakes here.
function statefulPage(init) {
  const st = Object.assign({ url: RESULTS, title: 'lofi music - YouTube', dom: { focused: null, video: null } }, init || {});
  const calls = [];
  const listeners = {};
  const page = {
    st, calls,
    url: () => st.url,
    title: async () => st.title,
    ariaSnapshot: async () => '- link "Café Ambience" [ref=e1]\n- link "Rain" [ref=e2]',
    // A string is from-browser's focus probe (FOCUSED_IS_TEXT_ENTRY_JS); a function
    // is browser-effect's state probe. Answering both with the state object would
    // make every player key look like it was pressed into a text field.
    evaluate: async (fn) => (typeof fn === 'string' ? !!st.textFocus : JSON.parse(JSON.stringify(st.dom))),
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    off: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    emit: (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg)),
    keyboard: { press: async (k) => { calls.push({ keyboardPress: k }); if (st.onKey) st.onKey(k); } },
    reload: async () => { calls.push({ reload: true }); if (st.onReload) st.onReload(); },
    goBack: async () => { calls.push({ goBack: true }); if (st.onBack) st.onBack(); return null; },
    locator: (sel) => ({
      click: async () => { calls.push({ click: sel }); if (st.onClick) st.onClick(sel); },
      hover: async () => { calls.push({ hover: sel }); },
      press: async (k) => { calls.push({ press: sel, key: k }); if (st.onKey) st.onKey(k); },
      type: async (v) => { calls.push({ type: sel }); if (st.onType) st.onType(v); },
      fill: async (v) => { calls.push({ fill: sel }); if (st.onType) st.onType(v, true); },
      inputValue: async () => (st.field ? st.field.value : ''),
      evaluate: async () => (st.field ? JSON.parse(JSON.stringify(st.field)) : null),
      count: async () => 1,
      first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    }),
  };
  return page;
}

function load(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  const fb = require(FROM_BROWSER);
  fb.__setSnapshotStateForTest(['e1', 'e2'], 1);
  return fb;
}

describe('BUG-462 — the judge, over the action x before/after matrix', () => {
  const base = { url: RESULTS, title: 'lofi music - YouTube', focused: { tag: 'a', role: null, name: 'Café Ambience' } };
  const cases = [
    // [label, intent, before, after, extra, verdict]
    ['click, nothing changed (15:11:24)', { kind: 'click' }, base, base, {}, 'unverified'],
    ['click, only the title changed', { kind: 'click' }, base, Object.assign({}, base, { title: '(1) lofi music - YouTube' }), {}, 'unverified'],
    ['click, only focus moved', { kind: 'click' }, base, Object.assign({}, base, { focused: { tag: 'body' } }), {}, 'unverified'],
    ['click, the element vanished', { kind: 'click' }, Object.assign({}, base, { refStillPresent: true }), Object.assign({}, base, { refStillPresent: false }), {}, 'unverified'],
    ['click, the url moved', { kind: 'click' }, base, Object.assign({}, base, { url: WATCH }), {}, 'verified'],
    ['click, an associated tab opened', { kind: 'click' }, base, base, { popups: [WATCH] }, 'verified'],
    // ATTACK 2026-09-24: a hover preview is a <video> too. Appearing proves nothing;
    // only the MAIN player changing state does (browser-effect MAIN_PLAYER_MIN_SHARE).
    ['click, a video appeared (a preview, no navigation)', { kind: 'click' }, base, Object.assign({}, base, { video: { playing: true, src: 'blob:p', share: 0.03 } }), {}, 'unverified'],
    ['click, a hover preview started playing', { kind: 'click' }, Object.assign({}, base, { video: { playing: false, src: 'blob:p', share: 0.03 } }), Object.assign({}, base, { video: { playing: true, src: 'blob:p', share: 0.03 } }), {}, 'unverified'],
    ['click, the main player started', { kind: 'click' }, Object.assign({}, base, { video: { playing: false, src: 'blob:1', share: 0.4 } }), Object.assign({}, base, { video: { playing: true, src: 'blob:1', share: 0.4 } }), {}, 'verified'],
    ['click, a video appeared AND the url moved', { kind: 'click' }, base, Object.assign({}, base, { url: WATCH, video: { playing: true, src: 'blob:1', share: 0.4 } }), {}, 'verified'],
    ['click, a new document at the same url', { kind: 'click' }, Object.assign({}, base, { docId: 1 }), Object.assign({}, base, { docId: 2 }), {}, 'verified'],
    ['scroll down, moved down', { kind: 'scroll', direction: 'down' }, { scroll: { top: 0, height: 5000, client: 800 } }, { scroll: { top: 600, height: 5000, client: 800 } }, {}, 'verified'],
    ['scroll down, moved UP', { kind: 'scroll', direction: 'down' }, { scroll: { top: 600, height: 5000, client: 800 } }, { scroll: { top: 0, height: 5000, client: 800 } }, {}, 'unverified'],
    ['scroll down, at the bottom', { kind: 'scroll', direction: 'down' }, { scroll: { top: 4200, height: 5000, client: 800 } }, { scroll: { top: 4200, height: 5000, client: 800 } }, {}, 'unverified'],
    ['scroll down, an inner panel moved', { kind: 'scroll', direction: 'down' }, { scroll: { top: 0, height: 800, client: 800 }, inner: { key: 'div#list', top: 0, height: 4000, client: 600 } }, { scroll: { top: 0, height: 800, client: 800 }, inner: { key: 'div#list', top: 500, height: 4000, client: 600 } }, {}, 'verified'],
    ['scroll, no metrics', { kind: 'scroll', direction: 'down' }, {}, {}, {}, 'unverified'],
    ['PageDown on the page, moved', { kind: 'key', key: 'PageDown' }, { focused: { tag: 'body' }, scroll: { top: 0, height: 5000, client: 800 } }, { focused: { tag: 'body' }, scroll: { top: 700, height: 5000, client: 800 } }, {}, 'verified'],
    ['PageDown on the page, nothing moved (09:41:01Z shape)', { kind: 'key', key: 'PageDown' }, { focused: { tag: 'body' }, scroll: { top: 0, height: 5000, client: 800 } }, { focused: { tag: 'body' }, scroll: { top: 0, height: 5000, client: 800 } }, {}, 'unverified'],
    ['Space on a focused player toggles it', { kind: 'key', key: 'Space' }, { video: { playing: false, src: 'b' } }, { video: { playing: true, src: 'b' } }, {}, 'verified'],
    ['k flips playback', { kind: 'key', key: 'k' }, { video: { playing: true, src: 'b' } }, { video: { playing: false, src: 'b' } }, {}, 'verified'],
    ['k, no flip', { kind: 'key', key: 'k' }, { video: { playing: true, src: 'b' } }, { video: { playing: true, src: 'b' } }, {}, 'unverified'],
    ['k, no video at all', { kind: 'key', key: 'k' }, {}, {}, {}, 'unverified'],
    ['l seeks forward 10s', { kind: 'key', key: 'l' }, { video: { playing: true, currentTime: 20, src: 'b' } }, { video: { playing: true, currentTime: 30, src: 'b' } }, {}, 'verified'],
    ['m flips mute', { kind: 'key', key: 'm' }, { video: { playing: true, muted: false, src: 'b' } }, { video: { playing: true, muted: true, src: 'b' } }, {}, 'verified'],
    ['c, nothing observable', { kind: 'key', key: 'c' }, { video: { playing: true, src: 'b' } }, { video: { playing: true, src: 'b' } }, {}, 'unverified'],
    ['Tab moves focus', { kind: 'key', key: 'Tab' }, { focused: { tag: 'input' } }, { focused: { tag: 'button' } }, {}, 'verified'],
    ['Enter submits (url moved)', { kind: 'key', key: 'Enter' }, { url: RESULTS }, { url: WATCH }, {}, 'verified'],
    ['Escape, nothing readable changed', { kind: 'key', key: 'Escape' }, { url: RESULTS }, { url: RESULTS }, {}, 'unverified'],
    ['reload, new document', { kind: 'reload' }, { docId: 10 }, { docId: 11 }, {}, 'verified'],
    ['reload, same document', { kind: 'reload' }, { docId: 10 }, { docId: 10 }, {}, 'unverified'],
    ['back, moved', { kind: 'back' }, { url: WATCH }, { url: RESULTS }, {}, 'verified'],
    ['back, first page', { kind: 'back' }, { url: RESULTS }, { url: RESULTS }, {}, 'unverified'],
    ['hover', { kind: 'hover' }, base, Object.assign({}, base, { title: 'x' }), {}, 'unverified'],
    ['type, field holds it', { kind: 'type', text: 'lofi' }, { field: { value: '' } }, { field: { value: 'lofi' } }, {}, 'verified'],
    ['type, field unchanged', { kind: 'type', text: 'lofi' }, { field: { value: '' } }, { field: { value: '' } }, {}, 'failed'],
    ['type, field reformatted', { kind: 'type', text: '5551234' }, { field: { value: '' } }, { field: { value: '555-1234' } }, {}, 'unverified'],
    ['type, unreadable field', { kind: 'type', text: 'x' }, {}, {}, {}, 'unverified'],
    ['type clearFirst, exact', { kind: 'type', text: 'b', clearFirst: true }, { field: { value: 'a' } }, { field: { value: 'b' } }, {}, 'verified'],
    ['type clearFirst, appended instead', { kind: 'type', text: 'b', clearFirst: true }, { field: { value: 'a' } }, { field: { value: 'ab' } }, {}, 'unverified'],
    ['select, reads back', { kind: 'select', expected: ['in'] }, { field: { value: 'us' } }, { field: { value: 'in' } }, {}, 'verified'],
    ['select, does not', { kind: 'select', expected: ['in'] }, { field: { value: 'us' } }, { field: { value: 'us' } }, {}, 'unverified'],
    ['upload, holds the file', { kind: 'upload', expected: 'cv.pdf' }, { field: { files: [] } }, { field: { files: ['cv.pdf'] } }, {}, 'verified'],
    ['upload, does not', { kind: 'upload', expected: 'cv.pdf' }, { field: { files: [] } }, { field: { files: [] } }, {}, 'unverified'],
  ];
  for (const [label, intent, before, after, extra, want] of cases) {
    it(label + ' -> ' + want, () => {
      const j = judgeEffect(intent, before, after, extra);
      assert.equal(j.verdict, want, JSON.stringify(j));
      if (want === 'unverified') assert.ok(j.reason && j.confirmedStep, 'an unverified result names what WAS done and why the rest is unknown');
    });
  }

  it('incidental changes are reported, never promoted to proof', () => {
    const j = judgeEffect({ kind: 'click' }, base, Object.assign({}, base, { title: 'changed', focused: { tag: 'body' } }), {});
    assert.equal(j.verdict, 'unverified');
    assert.deepEqual(j.incidental, ['the title changed', 'focus moved']);
    assert.match(j.reason, /does not show it worked/);
  });

  it('a preview is named as incidental, so the model can see why it was not proof', () => {
    const j = judgeEffect({ kind: 'click' }, base, Object.assign({}, base, { video: { playing: true, src: 'blob:p', share: 0.03 } }), {});
    assert.ok(j.incidental.some((s) => /hover preview/.test(s)), JSON.stringify(j));
  });

  it('an intent nobody named fails loudly instead of guessing', () => {
    assert.throws(() => judgeEffect({ kind: 'teleport' }, {}, {}, {}), /unknown intent kind/);
  });
});

describe('BUG-462 — each tool, through its real code path', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('THE 15:11:24 SHAPE: a ref click on the results page that opens nothing is unverified, not verified', async () => {
    const page = statefulPage();
    const fb = load(page);
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, true, 'the click was delivered');
    assert.equal(r.unverified, true, 'before BUG-462 this was unverified:false with oracle page-state');
    assert.equal(r.evidence, undefined, 'no evidence may be claimed for it');
    assert.equal(r.confirmedStep, 'the click was delivered to the element');
    assert.match(r.reason, /did not navigate/);
    assert.deepEqual(r.remedy && r.remedy.tool, 'browser_snapshot', 'the next step is structured, not only prose');
    assert.doesNotMatch(r.reason, /\b(again|retry|re-?click)\b/i, 'an action whose effect is unknown is never suggested again');
    assert.equal(page.calls.filter((c) => c.click).length, 1, 'and it is not repeated automatically');
  });

  it('CONTROL: the same click, when the page moves to the video, is verified', async () => {
    const page = statefulPage({ onClick: () => { page.st.url = WATCH; page.st.title = 'Café Ambience - YouTube'; } });
    const fb = load(page);
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.unverified, false);
    assert.match(r.evidence.observed, /cafe123/);
  });

  it('a navigation that commits DURING the settle wait is still caught', async () => {
    const page = statefulPage();
    let waited = 0;
    page.waitForURL = async (pred, opts) => {
      waited = opts.timeout;
      await new Promise((r) => setTimeout(r, 20));
      page.st.url = WATCH; // the SPA pushes its url a moment after the click resolves
      if (!pred(new URL(page.st.url))) throw new Error('timeout');
    };
    const fb = load(page);
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(waited, CLICK_SETTLE_MS, 'the wait is bounded by the named constant');
    assert.equal(r.unverified, false, 'read immediately after click() it would have looked unchanged');
  });

  it('a tab the click OPENED is proof; the page emits it as a popup', async () => {
    const page = statefulPage({ onClick: () => page.emit('popup', { url: () => WATCH }) });
    const fb = load(page);
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.unverified, false);
    assert.match(r.evidence.observed, /opened a new tab/);
  });

  it('selector clicks, scroll, go_back and the keyboard go through the same judge', async () => {
    const page = statefulPage({ dom: { focused: { tag: 'body' }, video: null, scroll: { top: 0, height: 5000, client: 800 } } });
    page.click = async () => {};
    page.waitForSelector = async () => {};
    const fb = load(page);
    assert.equal((await fb.browser_click({ selector: '#thumb' })).unverified, true, 'selector click: was a bare ok');
    assert.equal((await fb.browser_scroll({ direction: 'down' })).unverified, true, 'scroll that did not move: was a bare ok');
    assert.equal((await fb.browser_go_back()).unverified, true, 'go_back from the first page: was a bare ok');
    const pd = await fb.browser_press_key({ key: 'PageDown' });
    assert.equal(pd.unverified, true, 'PageDown that moved nothing (09:41:01Z): was verified');
    page.st.onKey = () => { page.st.dom.scroll = { top: 700, height: 5000, client: 800 }; };
    assert.equal((await fb.browser_press_key({ key: 'PageDown' })).unverified, false, 'and one that moved is verified');
  });

  it('player key k is verified only when playback actually flips', async () => {
    const page = statefulPage({ dom: { focused: { tag: 'body' }, video: { playing: false, currentTime: 1, src: 'b' } } });
    const fb = load(page);
    assert.equal((await fb.browser_press_key({ key: 'k' })).unverified, true);
    page.st.onKey = () => { page.st.dom.video.playing = true; };
    const r = await fb.browser_press_key({ key: 'k' });
    assert.equal(r.unverified, false);
    assert.match(r.evidence.observed, /video is now PLAYING/);
  });

  it('reload is verified by a new document, not by the url answering', async () => {
    const page = statefulPage({ dom: { focused: null, video: null, docId: 100 } });
    const fb = load(page);
    assert.equal((await fb.browser_press_key({ key: 'F5' })).unverified, true, 'same document');
    page.st.onReload = () => { page.st.dom.docId = 101; };
    assert.equal((await fb.browser_press_key({ key: 'F5' })).unverified, false);
  });

  it('hover reports the dispatch and claims nothing more', async () => {
    const fb = load(statefulPage());
    const r = await fb.browser_hover({ ref: 'e1' });
    assert.equal(r.ok, true);
    assert.equal(r.unverified, true);
    assert.equal(r.confirmedStep, 'the pointer was moved over the element');
    assert.match(r.result.hint, /browser_snapshot/);
  });

  it('typing is checked by reading the field back — and the typed text is never echoed', async () => {
    const SECRET = 'hunter2-correct-horse';
    const page = statefulPage({ field: { tag: 'input', value: '', files: null } });
    page.st.onType = (v, replace) => { page.st.field.value = replace ? v : page.st.field.value + v; };
    const fb = load(page);
    const r = await fb.browser_type({ ref: 'e1', text: SECRET });
    assert.equal(r.unverified, false);
    assert.match(r.evidence.observed, new RegExp(SECRET.length + ' chars'));
    assert.ok(!JSON.stringify(r).includes(SECRET), 'the value must not reach the model, the audit log or the vault');

    page.st.field.value = ''; // a fresh field: the one above already holds the text
    page.st.onType = () => {}; // the page swallowed it
    const miss = await fb.browser_type({ ref: 'e1', text: SECRET, clearFirst: true });
    assert.equal(miss.ok, false, 'a field that did not change is a real failure');
    assert.match(miss.error, /did not change/);
    assert.ok(!JSON.stringify(miss).includes(SECRET));
  });

  it('fill_form reads each field back and says how many did not hold, without the values', async () => {
    const page = statefulPage({ field: { value: '' } });
    const values = {};
    page.waitForSelector = async () => {};
    page.fill = async (sel, v) => { values[sel] = v; };
    page.locator = (sel) => ({ inputValue: async () => (sel === '#pass' ? 'mangled' : values[sel]) });
    const fb = load(page);
    const r = await fb.browser_fill_form({ fields: [{ selector: '#user', value: 'alice' }, { selector: '#pass', value: 's3cret!' }] });
    assert.equal(r.ok, true);
    assert.equal(r.unverified, true);
    assert.match(r.reason, /1 of the 2 filled fields/);
    assert.ok(!JSON.stringify(r).includes('s3cret!') && !JSON.stringify(r).includes('mangled'));
    page.locator = (sel) => ({ inputValue: async () => values[sel] });
    assert.equal((await fb.browser_fill_form({ fields: [{ selector: '#user', value: 'alice' }] })).unverified, false);
  });
});

describe('BUG-462 — a ref belongs to the tab it was read from', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('a snapshot on tab A does not license a click on tab B, even at the same url', async () => {
    const tabA = statefulPage();
    const tabB = statefulPage(); // a neighbour at the SAME url — the url check alone lets it through
    const fb = load(tabA);
    await fb.browser_snapshot({});
    realBrowserAgent.withPage = async (fn) => fn(tabB); // tab A closed; withPage now hands back tab B
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /did not act on the neighbouring tab/);
    assert.equal(r.remedy.tool, 'browser_snapshot');
    assert.equal(tabB.calls.filter((c) => c.click).length, 0, 'nothing was clicked on the neighbour');
  });

  it('ADJACENT: the same tab keeps working after its own snapshot', async () => {
    const tab = statefulPage();
    const fb = load(tab);
    await fb.browser_snapshot({});
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, true);
    assert.equal(tab.calls.filter((c) => c.click).length, 1);
  });
});

// Gate F. Before BUG-462 this path was unreachable for a native ref click: it
// never returned unverified, so BUG-441's retraction could not fire for it.
describe('BUG-462 — the unverified click reaches the retraction BUG-441 built', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
  const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

  function adapterReturning(outcome) {
    const injected = []; const anomalies = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }), confirm: { create: () => 'c' } },
      dispatchAction: async () => outcome,
      bus: { emit: (type, p) => { if (type === 'health.anomaly') anomalies.push(p); } },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-462',
      memory: { working: { tick: 1 }, episodic: { write() {} } },
      historyAppend: () => {}, reflection: null, summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => injected.push(t) }),
      toolAckDeadlineMs: 500,
    });
    return { adapter, injected, anomalies };
  }
  // The 15:11:33 sentence verbatim, and the same sentence without its "also".
  // The claim detector matches "I've clicked" but not "I've also clicked" — see
  // the KNOWN GAP test below for why that is not changed here.
  const VERBATIM = "Noted, Sir, I've logged the background noise as an incident. I've also clicked the third video for you, the 'Café Ambience' mix. It should be starting up now.";
  const SAID = VERBATIM.replace("I've also clicked", "I've clicked");

  it('the real 15:11:24 outcome, through the real adapter, retracts the 15:11:33 sentence', async () => {
    const outcome = await load(statefulPage()).browser_click({ ref: 'e1' });
    const { adapter, anomalies, injected } = adapterReturning(outcome);
    await adapter.handleLiveToolCalls([{ id: 'x1', name: 'browser_click', args: { ref: 'e1' } }], { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({ userText: 'play the third video', assistantText: SAID, turnId: 61 });
    // Filtered to the click: the same sentence also says "I've logged", and this
    // turn has no log_incident, which is a separate (correct) claim.
    const flagged = anomalies.filter((a) => a.kind === 'claimed-action-not-taken' && a.claimedTool === 'browser_click');
    assert.equal(flagged.length, 1, JSON.stringify(anomalies));
    assert.equal(flagged[0].claimedTool, 'browser_click');
    assert.ok(injected.some((t) => /CORRECTION/.test(t)), 'the retraction notice is sent');
  });

  // KNOWN GAP, pinned on purpose 2026-09-24 and owned by the BUG-448 residual /
  // BUG-460 claim-to-effect work (plan Wave 1, next): claim-check's categories
  // match "I've clicked" and "I clicked" but not an adverb in between, so the
  // VERBATIM 15:11:33 sentence is not caught even now that the click is honestly
  // unverified. Not widened here: the plan's rule for that module is to replay
  // every spoken line in Episodic 09-23/24 before changing a detector, and a
  // widened verb pattern retracts true sentences too. When that work lands, this
  // assertion is the one to flip (0 -> 1).
  it("KNOWN GAP: \"I've also clicked\" is not matched by the claim detector yet", async () => {
    const outcome = await load(statefulPage()).browser_click({ ref: 'e1' });
    const { adapter, anomalies } = adapterReturning(outcome);
    await adapter.handleLiveToolCalls([{ id: 'x3', name: 'browser_click', args: { ref: 'e1' } }], { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({ userText: 'play the third video', assistantText: VERBATIM, turnId: 63 });
    assert.equal(anomalies.filter((a) => a.kind === 'claimed-action-not-taken' && a.claimedTool === 'browser_click').length, 0,
      'if this now fails with 1, the claim module has closed the gap: flip it and record it in BUGS.md');
  });

  it('ADJACENT: a click that really opened the video backs the same sentence', async () => {
    const page = statefulPage({ onClick: () => { page.st.url = WATCH; } });
    const outcome = await load(page).browser_click({ ref: 'e1' });
    const { adapter, anomalies } = adapterReturning(outcome);
    await adapter.handleLiveToolCalls([{ id: 'x2', name: 'browser_click', args: { ref: 'e1' } }], { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({ userText: 'play the third video', assistantText: SAID, turnId: 62 });
    assert.equal(anomalies.filter((a) => a.kind === 'claimed-action-not-taken' && a.claimedTool === 'browser_click').length, 0);
  });
});
