'use strict';

// test/browser-snapshot-refs.test.js — snapshot-and-refs (2026-08-06).
//
// A week of browser-interaction bugs (BUG-107, 119, 120, 121, 122 and their
// predecessors) all circled ONE root cause: the model drove the browser through
// GUESSED CSS selectors, and every fix — longer timeouts, fallback ladders,
// retries — treated a symptom of that guess. This is the mechanism that removes
// the guess: read the page as an accessibility tree in which every interactable
// element carries a ref, act on a ref, and verify against the page afterwards.
//
// Built entirely on playwright-core 1.61.1, already in package.json. No new
// dependency, no external daemon, no licence exposure — the three tools that
// inspired this (agent-browser, lightpanda, ego-lite) were all rejected as
// software for those reasons and only their design was taken.
//
// A real page is a runtime dependency, so browserAgent.withPage is stubbed the
// same way phase4-browser-control.test.js does it. What CANNOT be faked away is
// pinned separately: the pure helpers (size cap, ref parsing) are exported and
// tested directly, and the live behaviour is on the plan's live gate.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);
const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');

let originalWithPage, originalGetStatus, originalEnsureOnline;

function stubOnline() {
  originalWithPage = realBrowserAgent.withPage;
  originalGetStatus = realBrowserAgent.getStatus;
  originalEnsureOnline = realBrowserAgent.ensureOnline;
  realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
  realBrowserAgent.ensureOnline = async () => {};
}
function restore() {
  realBrowserAgent.withPage = originalWithPage;
  realBrowserAgent.getStatus = originalGetStatus;
  realBrowserAgent.ensureOnline = originalEnsureOnline;
  delete require.cache[FROM_BROWSER];
}

// A page stub in the shape Playwright's real one presents for these calls.
function fakePage(overrides) {
  const calls = [];
  const page = Object.assign({
    _calls: calls,
    url: () => 'https://example.test/',
    title: async () => 'Example',
    ariaSnapshot: async () => '- button "Play" [ref=e1]\n- link "About" [ref=e2]',
    locator: (sel) => {
      calls.push({ locator: sel });
      return {
        click: async () => { calls.push({ click: sel }); },
        fill: async (v) => { calls.push({ fill: sel, value: v }); },
        type: async (v) => { calls.push({ type: sel, value: v }); },
        count: async () => 1,
        first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
      };
    },
    evaluate: async () => ({ focused: null, video: null }),
    screenshot: async () => Buffer.from('png-bytes'),
  }, overrides || {});
  return page;
}

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  return require(FROM_BROWSER);
}

describe('browser_snapshot — the page as refs, not a guess', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('returns the accessibility tree, the refs in it, and a generation number', async () => {
    const fb = loadEffector(fakePage());
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_snapshot({});

    assert.equal(r.ok, true);
    assert.match(r.result.snapshot, /\[ref=e1\]/, 'the tree the model reads must carry the refs it will act on');
    assert.equal(r.result.refCount, 2);
    assert.equal(r.result.generation, 1);
    assert.equal(r.result.truncated, false);
    assert.equal(r.result.url, 'https://example.test/');
  });

  it('asks Playwright for the AI snapshot mode — that is what mints refs AND walks iframes', async () => {
    // mode:'ai' is not cosmetic. Per playwright-core's own types it is what adds
    // [ref=eN] markers and inlines <iframe> subtrees; the default mode has
    // neither, which would silently cost every job-application form (they live
    // in Greenhouse/Workday/Lever iframes).
    let mode = null;
    const fb = loadEffector(fakePage({
      ariaSnapshot: async (opts) => { mode = opts && opts.mode; return '- button "x" [ref=e1]'; },
    }));
    fb.__resetSnapshotStateForTest();

    await fb.browser_snapshot({});
    assert.equal(mode, 'ai');
  });

  it('the generation increments per snapshot, so a ref can be dated', async () => {
    const fb = loadEffector(fakePage());
    fb.__resetSnapshotStateForTest();

    assert.equal((await fb.browser_snapshot({})).result.generation, 1);
    assert.equal((await fb.browser_snapshot({})).result.generation, 2);
  });

  it('{screenshot:true} returns the picture alongside the tree', async () => {
    const fb = loadEffector(fakePage());
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_snapshot({ screenshot: true });
    assert.ok(r.result.screenshotBase64, 'the combined capture must include the image');
    assert.equal(r.result.screenshotBase64, Buffer.from('png-bytes').toString('base64'));

    const plain = await fb.browser_snapshot({});
    assert.ok(!('screenshotBase64' in plain.result), 'and must not pay for it when not asked');
  });

  it('reports honestly when this Playwright build cannot snapshot at all', async () => {
    const fb = loadEffector(fakePage({ ariaSnapshot: undefined }));
    const r = await fb.browser_snapshot({});
    assert.equal(r.ok, false);
    assert.match(String(r.result), /ariaSnapshot/, 'an absent API must be named, not silently worked around');
  });
});

describe('browser_snapshot — the size cap is stated, never silent', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('a page that fits is returned whole', () => {
    const fb = require(FROM_BROWSER);
    const small = '- button "a" [ref=e1]\n- text: hello';
    const capped = fb.capSnapshot(small);
    assert.equal(capped.truncated, false);
    assert.equal(capped.text, small);
  });

  it('an oversized page keeps the interactable elements and SAYS how many it dropped', () => {
    const fb = require(FROM_BROWSER);
    const noise = Array.from({ length: 400 }, (_, i) => `- text: filler ${i}`);
    const buttons = Array.from({ length: 5 }, (_, i) => `- button "b${i}" [ref=e${i}]`);
    const capped = fb.capSnapshot(noise.concat(buttons).join('\n'));

    assert.equal(capped.truncated, true);
    assert.ok(capped.omittedNodes > 0, 'the drop must be counted');
    assert.ok(capped.text.includes('[ref=e0]'), 'refs are what an action can target — they survive the cap');
    assert.ok(!capped.text.includes('filler 1'), 'inert text is what gets dropped first');
  });

  it('the result carries the truncation note, so the model is never told it saw the whole page', async () => {
    const noise = Array.from({ length: 400 }, (_, i) => `- text: filler ${i}`).join('\n');
    const fb = loadEffector(fakePage({ ariaSnapshot: async () => noise + '\n- button "go" [ref=e9]' }));
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_snapshot({});
    assert.equal(r.result.truncated, true);
    assert.match(r.result.truncationNote, /omitted/i);
    assert.ok(r.result.omittedNodes > 0);
  });

  it('a character-capped tree never ends mid-line — a half-written ref is unusable', () => {
    const fb = require(FROM_BROWSER);
    const long = Array.from({ length: 199 }, (_, i) =>
      `- button "${'x'.repeat(200)}" [ref=e${i}]`).join('\n');
    const capped = fb.capSnapshot(long);
    assert.ok(capped.text.length <= fb.SNAPSHOT_MAX_CHARS);
    assert.ok(!/\[ref=[^\]]*$/.test(capped.text), 'the last line must not be a truncated ref marker');
  });

  it('extractRefs reads both the main-frame and in-frame ref shapes', () => {
    const fb = require(FROM_BROWSER);
    const refs = fb.extractRefs('- button [ref=e1]\n- iframe [ref=f2e7]\n  - textbox "Name" [ref=f2e8]');
    assert.deepEqual(refs, ['e1', 'f2e7', 'f2e8']);
  });
});

describe('ref actions — acting on an element the model actually saw', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('browser_click resolves the ref through the aria-ref engine and clicks natively', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e12'], 4);

    const r = await fb.browser_click({ ref: 'e12' });

    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.locator === 'aria-ref=e12'), 'must target the ref, not a selector');
    assert.ok(page._calls.some((c) => c.click === 'aria-ref=e12'), 'must use the native click');
    assert.equal(r.result.result.via, 'ref-click');
  });

  it('a cross-frame ref is passed through untouched — Playwright jumps frames itself', async () => {
    // aria-ref=f3e12 is resolved by playwright-core's own
    // _jumpToAriaRefFrameIfNeeded, which parses the f<seq>e<n> form and switches
    // to the owning frame. Hand-walking page.frames() here would be a second,
    // divergent implementation of something the engine already does.
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['f3e12'], 1);

    await fb.browser_click({ ref: 'f3e12' });
    assert.ok(page._calls.some((c) => c.locator === 'aria-ref=f3e12'),
      'the frame-qualified ref must reach the selector engine intact');
  });

  it('a STALE ref is refused before dispatch, with the next move named', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e5'], 7);

    const r = await fb.browser_click({ ref: 'e99' });

    assert.equal(r.ok, false);
    assert.match(String(r.result), /browser_snapshot again/i, 'the failure must tell the model what to do next');
    assert.equal(page._calls.length, 0, 'nothing may be clicked on a ref we cannot vouch for');
  });

  it('a ref used before any snapshot says so plainly', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /no snapshot has been taken/i);
    assert.equal(page._calls.length, 0);
  });

  it('navigating invalidates every outstanding ref — they belong to the old page', async () => {
    const page = fakePage({ goto: async () => {}, waitForLoadState: async () => {} });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    await fb.browser_navigate({ url: 'https://example.test/other' });
    const r = await fb.browser_click({ ref: 'e1' });

    assert.equal(r.ok, false, 'a ref must never resolve against a page the model has not seen');
    assert.match(String(r.result), /snapshot/i);
  });

  it('browser_type fills through a ref, and clearFirst still means replace', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e3'], 1);

    await fb.browser_type({ ref: 'e3', text: 'Ada', clearFirst: true });
    assert.ok(page._calls.some((c) => c.fill === 'aria-ref=e3' && c.value === 'Ada'));

    await fb.browser_type({ ref: 'e3', text: 'more' });
    assert.ok(page._calls.some((c) => c.type === 'aria-ref=e3' && c.value === 'more'));
  });

  it('browser_fill_form accepts refs, and one bad ref costs only its own field', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1', 'e2'], 1);

    const r = await fb.browser_fill_form({ fields: [
      { ref: 'e1', value: 'Ada' },
      { ref: 'eGONE', value: 'nope' },
      { ref: 'e2', value: 'ada@example.test' },
    ] });

    assert.equal(r.ok, true);
    assert.equal(r.result.filled, 2, 'the per-field contract survives the ref path');
    assert.equal(r.result.fields[1].ok, false);
    assert.match(r.result.fields[1].error, /snapshot/i);
  });

  it('the selector path is untouched — this is additive, not a replacement', async () => {
    const page = fakePage({ waitForSelector: async () => {}, click: async () => { page._calls.push({ cssClick: true }); } });
    const fb = loadEffector(page);
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_click({ selector: '#play' });
    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.cssClick), 'a page nobody snapshotted must still be clickable');
  });

  it('neither ref nor selector is a clear error naming the better option', async () => {
    const fb = loadEffector(fakePage());
    const r = await fb.browser_click({});
    assert.equal(r.ok, false);
    assert.match(String(r.result), /ref/, 'the error should point at the mechanism that works');
  });
});

describe('the verify half — a ref action reports what the page says afterwards', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('a ref click carries oracle-backed evidence, not a bare ok', async () => {
    const page = fakePage({
      evaluate: async () => ({ focused: { tag: 'button', role: null, name: 'Play' }, video: null }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });

    assert.equal(r.result.ok, true);
    assert.equal(r.result.unverified, false);
    assert.equal(r.result.evidence.oracle, 'page-state');
    assert.match(r.result.evidence.observed, /example\.test/);
    assert.match(r.result.evidence.observed, /focus on <button>/);
  });

  it('a video element gives the playing/paused oracle the week-long YouTube case needs', async () => {
    const page = fakePage({
      evaluate: async () => ({ focused: null, video: { playing: true, currentTime: 3.2, duration: 210 } }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.match(r.result.evidence.observed, /video PLAYING/);
    assert.equal(r.result.result.state.video.playing, true);
  });

  it('a paused video is reported as paused — the oracle is not there to agree with us', async () => {
    const page = fakePage({
      evaluate: async () => ({ focused: null, video: { playing: false, currentTime: 0, duration: 210 } }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.match(r.result.evidence.observed, /video paused/);
  });

  it('a page that tells us nothing yields unverified:true, never a fabricated confirmation', async () => {
    const page = fakePage({
      url: () => '',
      title: async () => { throw new Error('detached'); },
      evaluate: async () => { throw new Error('no context'); },
      locator: (sel) => ({
        click: async () => {},
        count: async () => { throw new Error('gone'); },
        first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
      }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.result.ok, true, 'the click was dispatched — denying it would be its own kind of lying');
    assert.equal(r.result.unverified, true);
    assert.match(r.result.reason, /cannot confirm/i);
  });

  it('an evidence capsule that fails does not turn a good click into a failure', async () => {
    const page = fakePage({ evaluate: async () => { throw new Error('CSP'); } });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, true);
    assert.equal(r.result.evidence.oracle, 'page-state', 'url/title still answered, so it is still evidence');
  });

  it('a ref that stops resolving mid-action fails with the remedy, not a raw Playwright error', async () => {
    const page = fakePage({
      locator: () => ({
        click: async () => { throw new Error('Unable to resolve aria-ref=e1'); },
        count: async () => 0,
        first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
      }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /browser_snapshot again/i);
  });

  it('an element covered by something else points at the overlay remedy', async () => {
    const page = fakePage({
      locator: () => ({
        click: async () => { throw new Error('Timeout: element intercepts pointer events'); },
        count: async () => 1,
        first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
      }),
    });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /dismiss_overlays|covering/i,
      'a dead-end failure is the BUG-107 mistake; name the next move');
  });
});

describe('wiring — a tool nobody can reach does not exist', () => {
  it('browser_snapshot is registered, tiered read-only, and reachable from voice', () => {
    const { TOOLS } = require(FROM_BROWSER);
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

    const tool = TOOLS.find((t) => t.name === 'browser_snapshot');
    assert.ok(tool, 'the effector must be in the catalog');
    assert.equal(tool.needs_result, true, 'the model must see the tree it is meant to act on');

    assert.equal(TIER_TABLE['browser_snapshot'], 1, 'reading a page changes nothing');
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_snapshot'),
      'registering an effector does NOT reach voice — omitting the read tool next to the act tools ' +
      'is what makes the model invent their inputs');
  });

  it('the act tools advertise ref in their schema, or the model will never send one', () => {
    const { TOOLS } = require(FROM_BROWSER);
    for (const name of ['browser_click', 'browser_type']) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool.params.ref, name + ' must declare the ref parameter');
      assert.match(tool.description, /ref/i, name + ' must tell the model refs are preferred');
    }
    const fill = TOOLS.find((t) => t.name === 'browser_fill_form');
    assert.match(String(fill.params.fields), /ref/, 'fill_form fields must document the ref shape');
  });

  it('the prompt tells the model to snapshot before clicking', () => {
    const src = require('node:fs').readFileSync(
      require.resolve('../src/core/voice/voice-agent.js'), 'utf8');
    assert.match(src, /BROWSER INTERACTION RULE/, 'both the batch and Live prompts compose RULES');
    assert.match(src, /Do NOT guess CSS selectors/);
    assert.match(src, /CAPTCHA[\s\S]{0,200}ask the operator/i,
      'the prompt must draw the line at CAPTCHA rather than leaving it to improvisation');
  });
});
