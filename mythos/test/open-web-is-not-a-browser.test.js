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

  // UPDATED 2026-09-03 (BUG-407) — the trailing slash. The route now hands over
  // WHATWG `new URL(...).href` so the http/https scheme is PROVEN before the
  // string can reach a browser process (the named-browser path spawns the
  // executable with it). electron/main.js already passed `parsed.href` to
  // shell.openExternal, so this is the value the browser always got; the parse
  // just moved one hop earlier, which is what makes res.result.url and the
  // opened url the same string.
  it('browser:true with a BARE DOMAIN in query normalizes to https and routes the same way', async () => {
    const res = await openWebTool().fn({ type: 'web', query: 'openai.com', browser: true });
    assert.equal(res.ok, true);
    assert.deepEqual(handedOff, ['https://openai.com/'], 'normalised BEFORE the hand-off');
    assert.equal(res.result.url, 'https://openai.com/');
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

// ---------------------------------------------------------------------------
// BUG-293 — the failure text has to name the right tool too, not just the
// description.
//
// MEASURED, 2026-08-20: open_web is the most-failing tool in the system. 34
// calls, 44 `live.tool-ack-deadline` breaches (more breaches than calls, i.e. it
// is being retried), and six distinct failure strings in one day:
//
//   No YouTube videos found for "Starboy The Weeknd".
//   No YouTube videos found for "Pink Floyd Comfortably Numb Live".
//   No results found for "daily news update cnn".
//   No location found for "Kullu Manali current weather".
//   Found results but could not extract a YouTube video ID. Try rephrasing.
//   the dashboard did not answer, so I cannot confirm it rendered
//
// open_web is a widget/location RESOLVER. The model was using it as the
// universal "show me X" verb — for music, for weather, for news — and each
// failure string is written from the resolver's point of view, so "No location
// found" reads to the model as THE WEATHER IS UNAVAILABLE rather than WRONG
// TOOL. The description fix above tells the model what open_web is before it
// chooses; this tells it what to do after it chose wrong.
//
// TWO OF THE SIX ARE DELIBERATELY NOT REDIRECTED, and this matters — the plan
// this came from proposed pointing the search failure at web_search. open_web's
// youtube and search branches ALREADY CALL web_search internally (from-dashboard
// .js:418, :575), so "use web_search instead" would send the model straight back
// into the code that just returned nothing. Those two say the search chain came
// back empty instead, which is the actionable truth.
// ---------------------------------------------------------------------------
describe('BUG-293: open_web failures name the tool that would have worked', () => {
  const realFetch = global.fetch;

  function openWeb() {
    const { TOOLS: tools } = buildTools({
      goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
      vault: {}, config: {}, bus: { emit() {} },
      probes: { getStatus: async () => ({}) },
      abtop: { getState: () => ({}), killSession: async () => {} },
    });
    return tools.find((t) => t.name === 'open_web').fn;
  }

  // Nothing here may reach the network: node --test collects everything under
  // test/, so a live call would block commits the day a host rate-limits.
  function stubNoResults() {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('geocoding-api.open-meteo.com')) {
        return { ok: true, status: 200, json: async () => ({ generationtime_ms: 0.4 }) };
      }
      throw new Error('fetch failed');
    };
  }

  it('a weather lookup that cannot geocode points at get_weather', async () => {
    stubNoResults();
    try {
      const res = await openWeb()({ type: 'weather', location: 'Kullu Manali current weather' }, { bus: { emit() {} } });
      assert.equal(res.ok, false);
      const msg = String(res.result || res.error || '');
      assert.match(msg, /Kullu Manali current weather/, 'the operator must still see what was looked up');
      assert.match(msg, /get_weather/,
        'open_web resolves PLACES, not weather — the failure has to name the tool that answers '
        + 'the question, or the model reads it as "the weather is unavailable" and invents one');
    } finally { global.fetch = realFetch; }
  });

  it('a youtube lookup with no hits points at spotify_play for music', async () => {
    stubNoResults();
    try {
      const res = await openWeb()({ type: 'youtube', query: 'Starboy The Weeknd' }, { bus: { emit() {} } });
      assert.equal(res.ok, false);
      const msg = String(res.result || res.error || '');
      assert.match(msg, /spotify_play/,
        'both logged youtube failures were music requests — the model wanted to LISTEN, and '
        + 'open_web resolves a video to embed');
    } finally { global.fetch = realFetch; }
  });

  it('the search branch does NOT redirect to web_search — it already called it', async () => {
    stubNoResults();
    try {
      const res = await openWeb()({ type: 'search', query: 'daily news update cnn' }, { bus: { emit() {} } });
      assert.equal(res.ok, false);
      const msg = String(res.result || res.error || '');
      assert.doesNotMatch(msg, /use web_search|try web_search/i,
        'open_web(search) IS web_search plus a card — a redirect there is a loop, not a fix');
      assert.match(msg, /search provider|search chain/i,
        'the actionable truth is that the search chain came back empty, not that the tool was wrong');
    } finally { global.fetch = realFetch; }
  });
});
