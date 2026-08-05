'use strict';

// test/browser-obstacles.test.js — snapshot-and-refs Phase 6.
//
// Cookie walls, newsletter modals and "Skip Ad" buttons are not a special class
// of thing: they appear in the accessibility snapshot like every other control,
// so the primary mechanism is the model seeing one and clicking its ref. That
// keeps every dismissal in the audit trail, which a hidden auto-clicker firing
// on page load would not. browser_dismiss_overlays exists only for the boring
// 90%, and the tests below are mostly about what it must REFUSE to click.
//
// The other half is the line this system does not cross. A CAPTCHA is detected
// and handed back to the operator — never solved, never worked around. This is
// the operator's own logged-in browser, and bypassing anti-bot checks is how
// real accounts get banned. That boundary is pinned here so a later "just make
// it work" change has to delete an explicit test to remove it.

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

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  return require(FROM_BROWSER);
}

// The sweep runs as one page.evaluate over the real DOM, so the honest way to
// test its RULES without a browser is to run that same callback against a
// hand-built DOM double. This mirrors the parts of the DOM the callback uses —
// nothing more, so a rule that reaches for anything else fails loudly here.
function domPage(elements) {
  const clicked = [];
  const mk = (spec) => {
    const el = {
      _spec: spec,
      nodeType: 1,
      getAttribute: (k) => (spec.attrs && spec.attrs[k]) || null,
      textContent: spec.text || '',
      getBoundingClientRect: () => spec.rect || { width: 100, height: 30 },
      click: () => clicked.push(spec.name || spec.text),
      parentElement: null,
    };
    return el;
  };
  const els = elements.map(mk);
  // Link each element to a synthetic ancestor chain carrying its container role.
  els.forEach((el) => {
    const spec = el._spec;
    if (spec.container) {
      el.parentElement = {
        nodeType: 1,
        getAttribute: (k) => (k === 'role' ? spec.container : null),
        getBoundingClientRect: () => ({ width: 800 }),
        parentElement: null,
      };
    } else if (spec.fixedWidth) {
      el.parentElement = {
        nodeType: 1,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ width: spec.fixedWidth }),
        parentElement: null,
      };
      el.parentElement._fixed = true;
    }
  });

  const page = {
    _clicked: clicked,
    url: () => 'https://news.example.test/article',
    title: async () => 'Article',
    ariaSnapshot: async () => '- button "Accept all" [ref=e1]',
    evaluate: async (fn, arg) => {
      // Provide the globals the callback closes over.
      const g = global;
      const prevDoc = g.document, prevWin = g.window;
      g.document = {
        body: { name: 'body' },
        querySelectorAll: () => els,
      };
      g.window = {
        innerWidth: 1000,
        getComputedStyle: (node) => {
          if (node && node._fixed) return { position: 'fixed', visibility: 'visible', display: 'block', opacity: '1' };
          const spec = (node && node._spec) || {};
          return {
            position: 'static',
            visibility: spec.hidden ? 'hidden' : 'visible',
            display: spec.hidden ? 'none' : 'block',
            opacity: '1',
          };
        },
      };
      try { return await fn(arg); } finally { g.document = prevDoc; g.window = prevWin; }
    },
  };
  return page;
}

describe('browser_dismiss_overlays — narrow on purpose', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('clicks a consent-accept button inside a dialog, and names what it clicked', async () => {
    const page = domPage([
      { text: 'Accept all', container: 'dialog' },
    ]);
    const fb = loadEffector(page);

    const r = await fb.browser_dismiss_overlays();

    assert.equal(r.result.count, 1);
    assert.deepEqual(page._clicked, ['Accept all']);
    assert.equal(r.evidence.oracle, 'page-state');
    // The name is reported as the sweep matched it — normalized lower-case,
    // which is also what the operator needs to see to know WHY it matched.
    assert.match(r.evidence.observed, /accept all/i,
      '"cleared the banner" with no list would be the un-auditable version');
  });

  it('clicks a Skip Ad button — the YouTube pre-roll case', async () => {
    const page = domPage([{ text: 'Skip Ad', container: 'complementary' }]);
    const fb = loadEffector(page);

    await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, ['Skip Ad']);
  });

  it('clicks a consent bar that never bothered with role=dialog (fixed full-width)', async () => {
    const page = domPage([{ text: 'I agree', fixedWidth: 900 }]);
    const fb = loadEffector(page);

    await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, ['I agree']);
  });

  it('does NOT click a matching label that is ordinary page content', async () => {
    // "Continue" in the middle of an article, or a "Close" in a footer, is the
    // operator's content — clicking it is exactly the over-reach this sweep
    // must not commit.
    const page = domPage([
      { text: 'Continue' },
      { text: 'Close' },
    ]);
    const fb = loadEffector(page);

    const r = await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, []);
    assert.equal(r.unverified, true, 'nothing dismissed is a real answer, not a failure');
  });

  it('does NOT click an unrelated control inside a dialog', async () => {
    const page = domPage([
      { text: 'Delete my account', container: 'dialog' },
      { text: 'Subscribe now', container: 'dialog' },
    ]);
    const fb = loadEffector(page);

    await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, [], 'being in a dialog is not enough — the label must be on the list');
  });

  it('does NOT click an invisible element', async () => {
    const page = domPage([{ text: 'Accept all', container: 'dialog', hidden: true }]);
    const fb = loadEffector(page);

    await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, []);
  });

  it('does NOT click a zero-sized element', async () => {
    const page = domPage([{ text: 'Accept all', container: 'dialog', rect: { width: 0, height: 0 } }]);
    const fb = loadEffector(page);

    await fb.browser_dismiss_overlays();
    assert.deepEqual(page._clicked, []);
  });

  it('stops after five dismissals — a page needing six needs a human', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: 'Dismiss', name: 'd' + i, container: 'dialog' }));
    const page = domPage(many);
    const fb = loadEffector(page);

    const r = await fb.browser_dismiss_overlays();
    assert.equal(page._clicked.length, 5);
    assert.equal(r.result.count, 5);
  });

  it('nothing to dismiss says so plainly and points at the manual route', async () => {
    const page = domPage([]);
    const fb = loadEffector(page);

    const r = await fb.browser_dismiss_overlays();
    assert.equal(r.ok, true, 'a clean page is not a broken tool');
    assert.equal(r.unverified, true, 'and it is not evidence of anything either');
    assert.match(r.reason, /browser_snapshot/);
  });

  it('dismissing invalidates outstanding refs — the page just lost elements', async () => {
    const page = domPage([{ text: 'Accept all', container: 'dialog' }]);
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e1'], 1);

    await fb.browser_dismiss_overlays();
    const r = await fb.browser_click({ ref: 'e1' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /snapshot/i);
  });

  it('the dismissal list stays a bounded constant, not an open-ended pattern', () => {
    const fb = require(FROM_BROWSER);
    assert.ok(Array.isArray(fb.DISMISSAL_NAMES));
    assert.ok(fb.DISMISSAL_NAMES.length < 40, 'if this list is growing without bound, the design is wrong');
    assert.deepEqual(fb.DISMISSAL_CONTAINERS, ['dialog', 'alertdialog', 'banner', 'complementary']);
  });
});

describe('CAPTCHA — the line MYTHOS does not cross', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('recognises the common challenge providers', () => {
    const fb = require(FROM_BROWSER);
    for (const text of [
      '- iframe "reCAPTCHA challenge"',
      '- text: Verify you are human',
      '- iframe "Widget containing checkbox for hCaptcha"',
      '- text: Checking your browser — Cloudflare',
      '- button "I am not a robot"',
    ]) {
      assert.ok(fb.looksLikeCaptcha(text).length > 0, 'must recognise: ' + text);
    }
  });

  it('does not cry captcha at ordinary pages', () => {
    const fb = require(FROM_BROWSER);
    assert.deepEqual(fb.looksLikeCaptcha('- heading "Security settings"\n- link "Human Resources"'), []);
  });

  it('browser_check_captcha reports blocked and hands the page back to the operator', async () => {
    const page = domPage([]);
    page.ariaSnapshot = async () => '- iframe "reCAPTCHA v2"';
    const fb = loadEffector(page);

    const r = await fb.browser_check_captcha();
    assert.equal(r.ok, true, 'detecting a challenge is not a tool failure');
    assert.equal(r.result.captcha, true);
    assert.equal(r.result.blocked, 'captcha');
    assert.match(r.result.message, /will not try to work around it/i);
    assert.match(r.result.message, /Solve it yourself/i,
      'the answer must be a handover to the operator, never an attempt');
  });

  it('a clean page reports no challenge', async () => {
    const page = domPage([]);
    const fb = loadEffector(page);

    const r = await fb.browser_check_captcha();
    assert.equal(r.result.captcha, false);
  });

  it('browser_snapshot flags a challenge inline, so it cannot be missed', async () => {
    const page = domPage([]);
    page.ariaSnapshot = async () => '- iframe "hCaptcha" [ref=e1]\n- button "Verify" [ref=e2]';
    const fb = loadEffector(page);
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_snapshot({});
    assert.equal(r.result.captchaDetected, true);
    assert.match(r.result.captchaNote, /Do NOT try to solve or bypass/i,
      'a model that needs a second call to notice will sometimes not make it');
  });

  it('an ordinary snapshot carries no captcha fields', async () => {
    const page = domPage([]);
    const fb = loadEffector(page);
    fb.__resetSnapshotStateForTest();

    const r = await fb.browser_snapshot({});
    assert.ok(!('captchaDetected' in r.result));
  });

  it('there is no solve/bypass path anywhere in the browser effector', () => {
    // The boundary as a source assertion. If someone later adds a solver, this
    // fails and they have to argue with it in review rather than slipping it in.
    const src = require('node:fs').readFileSync(FROM_BROWSER, 'utf8');
    assert.ok(!/2captcha|anticaptcha|capsolver|solveCaptcha|bypassCaptcha/i.test(src),
      'MYTHOS must never acquire a CAPTCHA-solving path — it is the operator\'s own logged-in browser');
  });

  it('the prompt tells the model to stop at a challenge', () => {
    const src = require('node:fs').readFileSync(
      require.resolve('../src/core/voice/voice-agent.js'), 'utf8');
    assert.match(src, /CAPTCHA[\s\S]{0,200}ask the operator to solve it by hand/i);
  });
});

describe('Phase 6 wiring', () => {
  it('both tools are registered, tiered and reachable from voice', () => {
    const { TOOLS } = require(FROM_BROWSER);
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

    for (const [name, tier] of Object.entries({ browser_dismiss_overlays: 2, browser_check_captcha: 0 })) {
      assert.ok(TOOLS.find((t) => t.name === name), name + ' must be registered');
      assert.equal(TIER_TABLE[name], tier, name + ' must be tier ' + tier);
      assert.ok(DEFAULT_ALLOWLIST.includes(name),
        name + ' must be reachable from voice — the model can only stop at a challenge it can detect');
    }
  });
});
