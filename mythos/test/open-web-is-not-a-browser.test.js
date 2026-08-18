'use strict';

// 2026-08-09, incident inc-1786236365947-3: "Multitasking task failed:
// open_web(search) did not open a browser window as user expected (widget open
// instead)."
//
// Nothing is broken. open_web is a dashboard-widget renderer BY DESIGN, and its
// own failure strings have said so for a while. The defect is the NAME: to a
// model choosing a tool from a list, "open_web" reads as "open the web", so it
// wins any request phrased as searching or browsing. The remedy is text — the
// description has to lead with what the tool is NOT, because a disclaimer in the
// last sentence of a long description loses to a name in the first word.
//
// A prompt/description regression is invisible at runtime and cannot be caught
// by any behavioural test, since the behaviour is correct and always was. This
// gate is the only thing standing between a future tidy-up of that wording and a
// repeat of the same incident.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/core/effectors/from-dashboard');
const { RULES } = require('../src/core/voice/voice-agent');

function openWebDescription() {
  const { TOOLS: tools } = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
  });
  const tool = tools.find((t) => t.name === 'open_web');
  assert.ok(tool, 'open_web must still be registered in from-dashboard.js');
  return String(tool.description);
}

describe('open_web tells the model, up front, that it is not a browser', () => {
  it('the description leads with the negative, not with "open web content"', () => {
    const d = openWebDescription();
    // "leads with" is the whole point: the correction has to arrive before the
    // model has finished reading the name and moved on.
    const opening = d.slice(0, 160);
    assert.match(opening, /does NOT open a browser/i,
      'open_web\'s description must say it does NOT open a browser within its first sentence — '
      + 'a caveat at the end loses to the tool\'s own name. Got: ' + opening);
    assert.match(opening, /inside the mythos dashboard/i,
      'the description must name where the content actually goes (the MYTHOS dashboard)');
  });

  it('the description names browser_navigate as the tool for real browsing', () => {
    assert.match(openWebDescription(), /browser_navigate/,
      'a rule that says "not this tool" without naming the right one is a dead end — '
      + 'this repo has fixed that exact shape twice (BUG-099, BUG-107)');
  });

  it('the voice system prompt carries a BROWSER RULE separating browse from render', () => {
    assert.match(RULES, /BROWSER RULE/,
      'RULES must carry a standalone BROWSER RULE. The guidance existed only as the last '
      + 'clause of BROWSER CONTROL RULE, a paragraph otherwise about tab handling — and the '
      + 'model still chose open_web for "search the web".');
    const rule = RULES.slice(RULES.indexOf('BROWSER RULE'));
    const firstPara = rule.slice(0, rule.indexOf('\n\n') === -1 ? rule.length : rule.indexOf('\n\n'));
    assert.match(firstPara, /search the web/i,
      'the rule must name the phrasing that actually misfired ("search the web for X")');
    assert.match(firstPara, /browser_navigate/,
      'the rule must name browser_navigate as the answer');
  });
});

// FIX-PLAN 3.3 (2026-08-17) — the in-tool route to the real browser. The
// 2026-08-09 incidents were a widget-vs-browser ambiguity the model had to
// guess at, and the only honest answer was a refusal pointing at
// browser_navigate (a different surface needing an attached debug browser).
// browser:true routes through the SAME newtab mechanism the frame-blocking
// domains use, and the catalog names it — so the model gets an actionable
// in-tool path instead of a dead end that repeats.
describe('open_web browser:true — the explicit real-browser route', () => {
  const ctx = {
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
  };

  // BUG-272 T2: browser:true now needs an external opener wired, because the
  // route it used to claim did not exist. `handedOff` records what reached the
  // shell so these tests can assert the URL normalisation they always cared
  // about, on the path that now actually carries it.
  let handedOff = [];
  function openWebTool(opener) {
    const built = buildTools(ctx);
    handedOff = [];
    if (opener !== null) {
      built.setExternalOpener(opener || (async (u) => { handedOff.push(u); return { opened: true }; }));
    }
    return built.TOOLS.find((t) => t.name === 'open_web');
  }

  // REWRITTEN 2026-08-18 (BUG-272 T2). This test used to assert ok:true +
  // widgetType:'newtab' and explained it as "the client newtab branch opens the
  // real browser window". That explanation was FALSE, and the test was pinning the
  // bug: under the Electron shell newtab had no working surface at all — the media
  // window refuses it by design and the HUD's window.open is denied outright by
  // setWindowOpenHandler. So open_web(browser:true) failed 7/7 in the 2026-08-17
  // session while returning exactly the shape this test demanded. It now asserts
  // the hand-off actually happens.
  it('browser:true + url is handed to the real browser via the shell', async () => {
    const res = await openWebTool().fn({ type: 'web', url: 'https://example.com/page', browser: true });
    assert.equal(res.ok, true);
    assert.deepEqual(handedOff, ['https://example.com/page'],
      'the url must reach shell.openExternal, not a widgetType nothing renders');
    assert.equal(res.result.widgetType, 'newtab', 'the payload shape is unchanged for the HUD');
    assert.equal(res.result.url, 'https://example.com/page');
    assert.equal(res.unverified, true,
      'still honestly unverified: openExternal resolves on OS acceptance, not on render');
  });

  it('browser:true fails honestly when the desktop shell is not running', async () => {
    // The case that produced seven silent successes. No opener wired = no browser
    // to hand it to, and that must be a failure that names the alternative.
    const res = await openWebTool(null).fn({ type: 'web', url: 'https://example.com/page', browser: true });
    assert.equal(res.ok, false);
    assert.match(String(res.result || res.error), /browser_navigate/);
  });

  it('browser:true with a BARE DOMAIN in query normalizes to https and routes the same way', async () => {
    const res = await openWebTool().fn({ type: 'web', query: 'openai.com', browser: true });
    assert.equal(res.ok, true);
    assert.deepEqual(handedOff, ['https://openai.com'], 'normalised BEFORE the hand-off');
    assert.equal(res.result.url, 'https://openai.com');
  });

  it('browser:true with a non-URL query fails with guidance, not a silent search', async () => {
    const res = await openWebTool().fn({ type: 'search', query: 'weather in tokyo', browser: true });
    assert.equal(res.ok, false, 'a search result list cannot open in the real browser');
    assert.match(String(res.result), /url/i, 'the failure must say what browser:true needs');
  });

  it('DEFAULT UNCHANGED: without the flag, type:web still renders the in-dashboard embed for a frameable site', async () => {
    const res = await openWebTool().fn({ type: 'web', url: 'https://example.com/frameable' });
    assert.equal(res.ok, true);
    assert.equal(res.result.widgetType, 'web', 'no browser flag → the embed widget, exactly as before');
  });

  it('the catalog names browser:true as the in-tool route', () => {
    const tool = openWebTool();
    assert.match(String(tool.description), /browser:true/, 'the description must name the flag');
    assert.ok(tool.params.browser, 'and the params table must document it');
  });
});
