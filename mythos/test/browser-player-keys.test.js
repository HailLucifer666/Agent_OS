'use strict';

// test/browser-player-keys.test.js — media keys for video players.
//
// 2026-08-06: asked to pause a YouTube video, the model reached for `k` (the
// shortcut every HTML5 player shares) and browser_press_key refused it — the
// allowlist held navigation keys only. It worked around this by hunting the
// .ytp-play-button ref, which works and is one more failure point than needed.
//
// The reason single characters were excluded is real and has not gone away:
// pressed while a text field has focus they are TYPED, and stray text in a form
// is exactly what the allowlist exists to prevent. So they are allowed with a
// focus guard, and this file pins both halves — the key reaches the page when a
// player has focus, and never does when a text field does.

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

// `focusIsTextEntry` drives only the focus probe; every other page.evaluate
// (the state capsule's) keeps its normal shape.
function fakePage({ focusIsTextEntry = false, focusProbeThrows = false } = {}) {
  const calls = [];
  return {
    _calls: calls,
    url: () => 'https://www.youtube.com/watch?v=abc',
    title: async () => 'A video - YouTube',
    evaluate: async (fn) => {
      if (typeof fn === 'string' && fn.includes('activeElement')) {
        if (focusProbeThrows) throw new Error('Execution context was destroyed');
        return focusIsTextEntry;
      }
      return { focused: null, video: null };
    },
    keyboard: { press: async (k) => { calls.push({ keyboardPress: k }); } },
    waitForSelector: async () => {},
    locator: (sel) => ({
      click: async () => { calls.push({ click: sel }); },
      press: async (k) => { calls.push({ press: sel, key: k }); },
      count: async () => 1,
      first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    }),
  };
}

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  return require(FROM_BROWSER);
}

describe('browser_press_key — video player keys', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('presses k when no text field has focus — the YouTube play/pause case', async () => {
    const page = fakePage({ focusIsTextEntry: false });
    const fb = loadEffector(page);

    const r = await fb.browser_press_key({ key: 'k' });
    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.keyboardPress === 'k'), 'the key must actually reach the page');
  });

  it('accepts the whole player set: k m f j l c', async () => {
    for (const key of ['k', 'm', 'f', 'j', 'l', 'c']) {
      const page = fakePage({ focusIsTextEntry: false });
      const fb = loadEffector(page);
      const r = await fb.browser_press_key({ key });
      assert.equal(r.ok, true, key + ' must be pressable');
      assert.ok(page._calls.some((c) => c.keyboardPress === key));
    }
  });

  it('refuses a player key while a text field has focus, and says why', async () => {
    const page = fakePage({ focusIsTextEntry: true });
    const fb = loadEffector(page);

    const r = await fb.browser_press_key({ key: 'k' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /text field/i);
    assert.match(String(r.result), /click the video/i, 'and name the way out');
    assert.equal(page._calls.length, 0, 'nothing may be typed into the field');
  });

  it('refuses rather than guesses when focus cannot be read at all', async () => {
    const page = fakePage({ focusProbeThrows: true });
    const fb = loadEffector(page);

    const r = await fb.browser_press_key({ key: 'm' });
    assert.equal(r.ok, false);
    assert.equal(page._calls.length, 0);
  });

  it('the guard also covers the ref path — focus, not the target, decides where a character lands', async () => {
    const page = fakePage({ focusIsTextEntry: true });
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e9'], 1);

    const r = await fb.browser_press_key({ key: 'f', ref: 'e9' });
    assert.equal(r.ok, false);
    assert.equal(page._calls.length, 0);
  });

  it('navigation keys are unaffected — no focus probe, same behaviour as before', async () => {
    const page = fakePage({ focusProbeThrows: true }); // would fail the guard if it ran
    const fb = loadEffector(page);

    const r = await fb.browser_press_key({ key: 'Enter' });
    assert.equal(r.ok, true, 'Enter in a text field is the normal submit case and must keep working');
    assert.ok(page._calls.some((c) => c.keyboardPress === 'Enter'));
  });

  it('still refuses everything outside both lists', async () => {
    const page = fakePage({ focusIsTextEntry: false });
    const fb = loadEffector(page);

    for (const bad of ['a', 'Control+A', 'F4', 'z']) {
      const r = await fb.browser_press_key({ key: bad });
      assert.equal(r.ok, false, bad + ' must still be refused');
    }
    assert.equal(page._calls.length, 0);
  });
});
