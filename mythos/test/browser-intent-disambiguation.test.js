'use strict';

// browser-intent-disambiguation.test.js — cluster A1 of the 2026-08-14
// "everything fails" session.
//
// MEASURED, not theorised. From %APPDATA%\MYTHOS\vault\Audit\2026-08-14.jsonl:
//   17:35:20, 17:37:19, 17:38:05, 17:38:47 x2 — five identical failures,
//   open_web({type:'web', query:'openai.com'}), answered "A URL is required for
//   web embedding." with no remedy, so the model repeated it verbatim.
//   17:33:32 — navigate accepted the same browsing intent, returned ok, and
//   MYTHOS announced "I've launched the browser and am navigating to the OpenAI
//   homepage" for a HUD route change nobody could see.
//
// open_web's description ALREADY warned about this in capitals (see
// open-web-is-not-a-browser.test.js, which pins that wording). ~1,100 characters
// of correct prose lost five times in four minutes, because a description is read
// once per session while a failure arrives at the moment of the mistake. So the
// mechanism under test here is the code guard, and the descriptions are a
// second line of defence.
//
// The two directions matter equally. A guard broad enough to catch a bare domain
// must NOT catch the five open_web types that legitimately take a plain query,
// nor a real dashboard route — those are working features, and this session's
// whole failure mode was a tool succeeding at the wrong thing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/core/effectors/from-dashboard');

function tools() {
  const { TOOLS } = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
  });
  return TOOLS;
}

function toolFn(name) {
  const t = tools().find((x) => x.name === name);
  assert.ok(t, name + ' must still be registered in from-dashboard.js');
  return t.fn;
}

function description(name) {
  const t = tools().find((x) => x.name === name);
  assert.ok(t, name + ' must still be registered in from-dashboard.js');
  return String(t.description);
}

describe('A1 open_web: a URL-shaped query on type:"web" is refused WITH the remedy', () => {
  it('refuses the exact call that failed five times on 2026-08-14', async () => {
    const res = await toolFn('open_web')({ type: 'web', query: 'openai.com' });
    assert.equal(res.ok, false, 'a domain in query: must not be coerced into url: — satisfying the '
      + 'wrong surface would hand the operator a HUD card while telling them Chrome opened, which is '
      + 'the fabricated success this whole session was about');
    const reason = String(res.result);
    assert.match(reason, /browser_navigate/,
      'the remedy must NAME the right tool — the proven-effective shape from checkBrowserTarget '
      + '(from-browser.js, BUG-099/107). A refusal with no remedy is what got repeated five times.');
    assert.match(reason, /https:\/\/openai\.com/,
      'and must name the exact url: value to use, so the next call needs no invention');
  });

  it('handles a full https URL and a www. host too, not just a bare domain', async () => {
    const withScheme = await toolFn('open_web')({ type: 'web', query: 'https://news.ycombinator.com' });
    assert.equal(withScheme.ok, false);
    assert.match(String(withScheme.result), /url:"https:\/\/news\.ycombinator\.com"/);

    const withWww = await toolFn('open_web')({ type: 'web', query: 'www.openai.com' });
    assert.equal(withWww.ok, false);
    assert.match(String(withWww.result), /url:"https:\/\/www\.openai\.com"/,
      'a www. host is already a URL missing only its scheme — do not prepend https:// twice');
  });

  it('a non-URL query on type:"web" must NOT get the browser remedy — but must get A remedy', async () => {
    // BUG-273 D2 — this test used to require the ORIGINAL bare "A URL is required
    // for web embedding." here, and its reasoning was half right. The half that
    // was right, and is kept below: nothing about "weather in Delhi" says the
    // model meant a browser, so browser_navigate would be misleading advice
    // rather than a fix.
    //
    // The half that was wrong: it read "the browser remedy does not apply" as
    // "no remedy applies", and pinned the bare string this file's own header
    // condemns — a refusal carrying no remedy, repeated five times in four
    // minutes. On 2026-08-18 the unguarded branch fired again on
    // open_web({type:'web', query:'distance Kolkata to Bangalore'}) and the
    // operator logged the fallout as an incident.
    //
    // A prose query on type:"web" is not a missing url, it is the wrong type, so
    // the remedy is type:"search". Both halves are now asserted.
    const res = await toolFn('open_web')({ type: 'web', query: 'weather in Delhi' });
    assert.equal(res.ok, false);
    assert.doesNotMatch(String(res.result), /browser_navigate/,
      'unchanged and still load-bearing: a search phrase is not browsing intent');
    assert.match(String(res.result), /type:"search"/,
      'but the refusal must name the remedy that DOES apply, per this file\'s own premise');
  });

  it('a real url: on type:"web" is untouched by the guard', async () => {
    const res = await toolFn('open_web')({ type: 'web', url: 'https://example.com' });
    assert.equal(res.ok, true, 'the guard fires only when url is ABSENT');
    assert.equal(res.result.widgetType, 'web');
    assert.equal(res.result.embedUrl, 'https://example.com');
  });
});

describe('A1 open_web: the other five types still take a bare query', () => {
  // These are the working features the guard must not disturb. Each is driven
  // only as far as its own argument validation — a search/geocode would need
  // network access, so the assertion is that the BROWSER remedy did not fire.
  const cases = [
    { type: 'youtube', query: 'Tera Mera Rishta' },
    { type: 'search', query: 'best coffee grinder' },
    { type: 'image', query: 'red panda' },
    { type: 'flights', query: 'NYC to Tokyo' },
  ];
  for (const c of cases) {
    it('type:"' + c.type + '" does not trip the browser-intent guard', async () => {
      const res = await toolFn('open_web')(c);
      // Success or a network/no-results failure — either is fine. What must never
      // appear is the browser remedy, which would mean the guard had widened into
      // a working feature.
      if (res.ok === false) {
        assert.doesNotMatch(String(res.result), /browser_navigate with url/,
          'type:"' + c.type + '" legitimately takes a bare query; the guard must be scoped to type:"web"');
      }
    });
  }

  it('a domain-shaped youtube query is still a search, not a refusal', async () => {
    // The worst plausible false positive: someone asks for a video whose title
    // happens to look like a host. type:'youtube' must not be hijacked.
    const res = await toolFn('open_web')({ type: 'youtube', query: 'openai.com' });
    if (res.ok === false) {
      assert.doesNotMatch(String(res.result), /browser_navigate with url/);
    }
  });
});

describe('A1 navigate: a HUD router refuses a URL instead of "succeeding"', () => {
  it('refuses a URL-shaped route with the same remedy', () => {
    const res = toolFn('navigate')({ route: 'https://openai.com' });
    assert.equal(res.ok, false, 'at 17:33:32 this returned ok for a route change and MYTHOS reported '
      + 'having launched a browser — a success for doing something unrelated');
    assert.match(String(res.result), /browser_navigate/);
  });

  it('refuses a bare domain too', () => {
    const res = toolFn('navigate')({ route: 'openai.com' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /browser_navigate/);
  });

  it('says what navigate actually is, so the refusal teaches something', () => {
    const res = toolFn('navigate')({ route: 'openai.com' });
    assert.match(String(res.result), /dashboard view/i,
      'naming only the remedy leaves the model still believing navigate could have worked');
  });

  it('real dashboard routes are unaffected', () => {
    for (const route of ['kanban', 'goals', 'pipeline', 'audit']) {
      const res = toolFn('navigate')({ route });
      assert.equal(res.ok, true, 'the guard must not break the tool it is protecting: ' + route);
      assert.equal(res.result.route, route);
    }
    // And a multi-word synonym, which contains a space and so can never be
    // URL-shaped — pinned so the guard is not later "simplified" into something
    // that inspects the resolved route instead of the raw argument.
    const syn = toolFn('navigate')({ route: 'the kanban board' });
    assert.equal(syn.ok, true);
    assert.equal(syn.result.route, 'kanban');
  });

  it('an unknown non-URL route keeps its own original message', () => {
    const res = toolFn('navigate')({ route: 'nonsense' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /is not a known dashboard view/);
    assert.doesNotMatch(String(res.result), /browser_navigate/);
  });
});

describe('A1 descriptions: both tools lead with what they are NOT', () => {
  // Cheap, and costs nothing if the model ignores it — the code guards above are
  // the real mechanism. This only makes the FIRST attempt likelier to be right.
  it('navigate no longer describes itself as merely "change the dashboard view/route"', () => {
    const d = description('navigate');
    assert.match(d, /NOT a browser/i,
      'a model reading "Change the dashboard view/route." has no reason to think a URL is wrong — '
      + 'and on 2026-08-14 it passed one');
    assert.match(d, /browser_navigate/,
      'name the right tool, same rule as BUG-099/107');
  });

  it('open_web says type:"web" requires url and refuses a query', () => {
    assert.match(description('open_web'), /requires url:/i,
      'the failing call passed query: to type:"web" five times');
  });
});
