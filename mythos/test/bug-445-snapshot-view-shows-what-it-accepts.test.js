'use strict';

// test/bug-445-snapshot-view-shows-what-it-accepts.test.js
//
// BUG-445 (CRITICAL): "play the third video" was structurally impossible. The
// mechanism is written up in src/core/effectors/snapshot-view.js and
// src/core/voice/model-result.js; this file proves it end to end, through the
// SAME two doors the attended run went through — from-browser's browser_snapshot
// and the Live adapter's tool response — because each door alone looked fine.
//
// FIXTURE. The grammar measured against playwright-core 1.62.1 on 2026-09-23
// (quoted names, /url children, an unnamed thumbnail link, heading-wrapped title
// links, named metadata generics), shaped into a YouTube home page with
// placeholder titles of realistic length. The real snapshot from the attended
// run is NOT committed: it carries the operator's own recommendations, and the
// stored copy had already lost its /url lines to the old cap.
//
// RED FIRST, 2026-09-23, against ec2efd93's from-browser.js + live-tool-adapter.js
// (the snapshot-view/model-result modules present but not yet wired):
//   (A1) 'the model must receive a structure, not a string cut mid-token'
//   (A2) 'f5e1069 was accepted although the model was never shown it'
//   (A3) 'the model received a base64 run'
//   (D)  'a ref from the old page was clicked on the new one'
//   (E)  failed on its fixture check — the old result had no `pages` at all
//   (E-stale) 'a continuation of a superseded capture must not be served'
// Each failed for the reason named, not on a load error. (H) was written after
// the wiring, when measuring showed a long page address could make the adapter
// trim registered rows; M9 below is its proof.
//
// MUTATIONS, 2026-09-23. Each applied (diffed), run, restored by sha256-checked
// copy. Results are recorded in the table at the bottom of this file.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realBrowserAgent = require('../adapters/browser-agent');
const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const view = () => require('../src/core/effectors/snapshot-view');
const bounded = () => require('../src/core/voice/model-result');

// ---------------------------------------------------------------- fixture --

const vid = (i) => 'VID' + String(i).padStart(8, '0');
const TITLE = (i) => `Video ${i}: placeholder title of a realistic length for this fixture #${i}`;

// One card in the shape measured on YouTube, with the /url children the old cap
// discarded. 14 ref-bearing lines per card, as on the real page.
function card(i, r) {
  return [
    `          - generic [ref=f5e${r}] [cursor=pointer]:`,
    `            - link [ref=f5e${r + 1}]:`,
    `              - /url: /watch?v=${vid(i)}`,
    `              - img [ref=f5e${r + 2}]:`,
    `                - generic [ref=f5e${r + 3}]: 12:34`,
    `            - generic [ref=f5e${r + 4}]:`,
    `              - button "Go to channel Channel ${i}" [ref=f5e${r + 5}]`,
    `              - generic [ref=f5e${r + 6}]:`,
    `                - 'heading "${TITLE(i)}" [level=3] [ref=f5e${r + 7}]':`,
    `                  - 'link "${TITLE(i)} 12 minutes" [ref=f5e${r + 8}]':`,
    `                    - /url: /watch?v=${vid(i)}`,
    `                - group [ref=f5e${r + 9}]:`,
    `                  - link "Channel ${i}" [ref=f5e${r + 10}]:`,
    `                    - /url: /@channel${i}`,
    `                  - generic "47 million views" [ref=f5e${r + 11}]: 47M`,
    `                  - generic "4 days ago" [ref=f5e${r + 12}]: 4d ago`,
    `              - button "More actions" [ref=f5e${r + 13}]`,
  ];
}
const cardBase = (i) => 1000 + i * 20;
const titleRef = (i) => 'f5e' + (cardBase(i) + 8);

function youtubeHome(videos, { withMain = true } = {}) {
  const lines = [
    '- generic [ref=f5e1]:',
    '  - banner [ref=f5e2]:',
    '    - button "Guide" [ref=f5e9] [cursor=pointer]',
    '    - link "YouTube Home" [ref=f5e14] [cursor=pointer]:',
    '      - /url: /',
    '    - search [ref=f5e29]:',
    '      - combobox "Search" [expanded] [ref=f5e34]',
    '      - button "Search" [ref=f5e35] [cursor=pointer]',
    '    - button "Settings" [ref=f5e52]',
    '  - navigation [ref=f5e62]:',
    '    - link "Home" [ref=f5e65] [cursor=pointer]:',
    '      - /url: /',
    '    - link "Shorts" [ref=f5e71] [cursor=pointer]:',
    '      - /url: /shorts',
    withMain ? '  - main [ref=f5e89]:' : '  - generic [ref=f5e89]:',
    '    - tablist [ref=f5e98]:',
  ];
  for (let t = 0; t < 21; t++) lines.push(`      - tab "Chip ${t}" [ref=f5e${100 + t}] [cursor=pointer]`);
  lines.push('    - generic [ref=f5e233]:');
  for (let i = 1; i <= videos; i++) lines.push(...card(i, cardBase(i)));
  return lines.join('\n');
}

// ---------------------------------------------------------------- harness --

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

function fakePage({ yaml, screenshotBytes = 9 } = {}) {
  const calls = [];
  const page = {
    _calls: calls,
    _url: 'https://www.youtube.com/',
    url() { return page._url; },
    title: async () => 'YouTube',
    ariaSnapshot: async () => page._yaml,
    _yaml: yaml,
    locator: (sel) => {
      calls.push({ locator: sel });
      return { click: async () => { calls.push({ click: sel }); }, fill: async () => {}, type: async () => {}, count: async () => 1,
        first: () => ({ scrollIntoViewIfNeeded: async () => {} }) };
    },
    evaluate: async () => ({ focused: null, video: null }),
    screenshot: async () => Buffer.alloc(screenshotBytes, 7),
  };
  return page;
}

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  const fb = require(FROM_BROWSER);
  fb.__resetSnapshotStateForTest();
  return fb;
}

function adapterDeps(outcome) {
  return {
    leash: { check: () => ({ allow: true, requireConfirm: false, tier: 1, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'c-445', reject: () => {} } },
    dispatchAction: async () => outcome,
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-445',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  };
}

// What the Live model is actually handed for one browser_snapshot call.
async function throughTheModelDoor(fb, args) {
  const outcome = await fb.browser_snapshot(args || {});
  const adapter = createLiveToolAdapter(adapterDeps(outcome));
  const sent = [];
  await adapter.handleLiveToolCalls([{ id: 's-445', name: 'browser_snapshot', args: args || {} }],
    { sendToolResponse: (r) => sent.push(...r) });
  const response = sent[0].response;
  return { outcome, response, text: JSON.stringify(response) };
}

// Every ref token the model could read, in either the old or the new format.
const refsIn = (text) => new Set((text.match(/\b(?:f\d+)?e\d+\b/g) || []));

// ------------------------------------------------ end to end, both doors --

describe('BUG-445 — end to end: what the model is shown is what the tools accept', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  test('(A1) videos 1-8 reach the model, each identified by its canonical watch id, in page order', async () => {
    const fb = loadEffector(fakePage({ yaml: youtubeHome(20) }));
    const { response, text } = await throughTheModelDoor(fb);
    assert.equal(typeof response.result, 'object', 'the model must receive a structure, not a string cut mid-token');
    let last = -1;
    for (let i = 1; i <= 8; i++) {
      const at = text.indexOf('/watch?v=' + vid(i));
      assert.ok(at > last, `video ${i} is not in what the model received, or is out of page order`);
      last = at;
    }
    assert.ok(text.length <= 4200, `the whole tool response must stay within the model budget (was ${text.length})`);
  });

  test('(A2) TWO ROUTES: a ref the model was never shown is refused; one it was shown is accepted', async () => {
    const page = fakePage({ yaml: youtubeHome(20) });
    const fb = loadEffector(page);
    const { text } = await throughTheModelDoor(fb);
    const shown = refsIn(text);
    const everyRef = [...youtubeHome(20).matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]);
    const unseen = everyRef.filter((r) => !shown.has(r));
    assert.ok(unseen.length > 50, 'fixture check: most of this page is NOT on the first view');
    for (const ref of unseen) {
      const r = await fb.browser_click({ ref });
      assert.equal(r.ok, false, `${ref} was accepted although the model was never shown it`);
    }
    assert.equal(page._calls.filter((c) => c.click).length, 0, 'nothing unseen may be clicked');
    const r1 = await fb.browser_click({ ref: titleRef(1) });
    assert.equal(r1.ok, true, 'ADJACENT: the ref printed for video 1 must still work');
  });

  test('(A3) a screenshot never reaches the model as text; the effector result (HUD path) still carries it', async () => {
    // A SMALL page on purpose: under the old cut a big tree came first in the JSON
    // and hid the image behind it, which made the leak depend on page size.
    const fb = loadEffector(fakePage({ yaml: '- main [ref=e1]:\n  - button "Play" [ref=e2]', screenshotBytes: 3000 }));
    const { outcome, text } = await throughTheModelDoor(fb, { screenshot: true });
    assert.doesNotMatch(text, /[A-Za-z0-9+/]{200,}/, 'the model received a base64 run');
    assert.equal(outcome.result.screenshotBase64, Buffer.alloc(3000, 7).toString('base64'),
      'the image itself must be untouched for the consumers that render it');
    assert.match(text, /screenshotBase64/, 'the omission must be named, not silent');
  });

  test('(H) a hostile header (huge url, huge title, a CAPTCHA, a screenshot) never makes the adapter trim a registered row', async () => {
    const page = fakePage({ yaml: youtubeHome(40), screenshotBytes: 5000 });
    page._url = 'https://www.youtube.com/?q=' + 'x'.repeat(3000);
    page.title = async () => 'T'.repeat(1000) + ' recaptcha';
    page._yaml = youtubeHome(40) + '\n  - iframe "reCAPTCHA" [ref=e9999]';
    const fb = loadEffector(page);
    const { outcome, response, text } = await throughTheModelDoor(fb, { screenshot: true });
    assert.equal(outcome.result.captchaDetected, true, 'fixture check: the CAPTCHA branch is the one exercised');
    assert.deepEqual(response.result.items, outcome.result.items,
      'every row the effector registered must reach the model — a trimmed row is a registered ref nobody saw');
    assert.ok(text.length <= 4200, `within the model budget (was ${text.length})`);
  });

  test('(D) a ref from the old page is refused on the new one — YouTube changes page without a navigate call', async () => {
    const page = fakePage({ yaml: youtubeHome(8) });
    const fb = loadEffector(page);
    await fb.browser_snapshot({});
    page._url = 'https://www.youtube.com/watch?v=' + vid(3);
    const r = await fb.browser_click({ ref: titleRef(1) });
    assert.equal(r.ok, false, 'a ref from the old page was clicked on the new one');
    assert.match(JSON.stringify(r), /browser_snapshot/, 'the refusal must name the next step');
    assert.equal(page._calls.filter((c) => c.click).length, 0);
  });

  test('(D-adjacent) a change of #fragment alone is the same page — the ref still works', async () => {
    const page = fakePage({ yaml: youtubeHome(8) });
    const fb = loadEffector(page);
    await fb.browser_snapshot({});
    page._url = 'https://www.youtube.com/#top';
    assert.equal((await fb.browser_click({ ref: titleRef(1) })).ok, true);
  });

  test('(E) page 2 continues the SAME capture: new rows, same generation, both pages usable', async () => {
    const page = fakePage({ yaml: youtubeHome(40) });
    const fb = loadEffector(page);
    const p1 = await fb.browser_snapshot({});
    assert.ok(p1.result.pages > 1, 'fixture check: 40 videos do not fit one view');
    page._yaml = youtubeHome(3); // a re-capture would now differ; page 2 must not re-capture
    const p2 = await fb.browser_snapshot({ page: 2, generation: p1.result.generation });
    assert.equal(p2.ok, true, 'page 2 of the same capture must be served');
    assert.equal(p2.result.generation, p1.result.generation);
    assert.equal(p2.result.page, 2);
    assert.ok(p2.result.items[0].n > p1.result.items[p1.result.items.length - 1].n, 'page 2 starts after page 1');
    const onP2 = p2.result.items.find((r) => r.url && r.url.startsWith('/watch'));
    assert.equal((await fb.browser_click({ ref: onP2.ref })).ok, true, 'a ref issued on page 2 is usable');
    const onP1 = p1.result.items.find((r) => r.url && r.url.startsWith('/watch'));
    assert.equal((await fb.browser_click({ ref: onP1.ref })).ok, true, 'and page 1 is still usable');
  });

  test('(E-stale) a page of an OLD capture is refused, and the refusal names a fresh snapshot', async () => {
    const page = fakePage({ yaml: youtubeHome(40) });
    const fb = loadEffector(page);
    const first = await fb.browser_snapshot({});
    await fb.browser_snapshot({});
    const stale = await fb.browser_snapshot({ page: 2, generation: first.result.generation });
    assert.equal(stale.ok, false, 'a continuation of a superseded capture must not be served');
    assert.equal(stale.remedy && stale.remedy.tool, 'browser_snapshot');
  });
});

// ------------------------------------------------------ the view itself --

describe('BUG-445 — the bounded view (snapshot-view.js)', () => {
  const watchRows = (rows) => rows.filter((r) => r.url && r.url.startsWith('/watch?v='));

  test('(a) "the third video" is the third distinct watch target, offered by its NAMED link', () => {
    const v = view().buildSnapshotView(youtubeHome(8));
    const third = watchRows(v.rows)[2];
    assert.equal(third.url, '/watch?v=' + vid(3));
    assert.equal(third.ref, titleRef(3), 'the thumbnail and the title collapse into the named ref');
    assert.equal(watchRows(v.rows).filter((r) => r.url === third.url).length, 1, 'one item per target');
  });

  test('(b) the refs registered are EXACTLY the refs printed on the rows', () => {
    const v = view().buildSnapshotView(youtubeHome(40));
    assert.deepEqual(v.refs, v.rows.filter((r) => r.ref).map((r) => r.ref));
  });

  test('(c) a ref from a row that did not fit is not registered', () => {
    const v = view().buildSnapshotView(youtubeHome(40));
    assert.ok(v.pages > 1);
    assert.ok(!v.refs.includes(titleRef(40)), 'an unseen ref must be refused, not accepted on trust');
  });

  test('(e) a hostile name containing "[ref=" mints nothing, quoted or not', () => {
    const e = view()._parseEntry('link "Click [ref=f5e14] now" [ref=e8]');
    assert.equal(e.ref, 'e8');
    assert.equal(e.name, 'Click [ref=f5e14] now');
    const v = view().buildSnapshotView('- main [ref=e1]:\n  - \'link "Click [ref=f5e14]: now" [ref=e8]\':\n    - /url: /x');
    assert.deepEqual(v.refs, ['e8']);
  });

  test('(e2) an unterminated name refuses the line and is counted, never guessed at', () => {
    const v = view().buildSnapshotView('- main [ref=e1]:\n  - link "broken [ref=e9]\n  - button "ok" [ref=e2]');
    assert.deepEqual(v.refs, ['e2']);
    assert.equal(v.unparsed, 1);
  });

  test('(f) paging covers every row exactly once, and page 2 does not re-issue page 1', () => {
    const yaml = youtubeHome(40);
    const p1 = view().buildSnapshotView(yaml, { page: 1 });
    const seen = new Set();
    for (let p = 1; p <= p1.pages; p++) {
      for (const r of view().buildSnapshotView(yaml, { page: p }).rows) {
        assert.ok(!seen.has(r.n), `row ${r.n} on two pages`);
        seen.add(r.n);
      }
    }
    assert.equal(seen.size, p1.totalRows);
  });

  test('(g) every page fits its budget, Unicode and escaping included; one huge name cannot own a page', () => {
    const uni = youtubeHome(30).replace(/Video (\d+):/g, 'বাংলা \\"উদ্ধৃতি\\" ভিডিও $1 ⚠️:');
    for (const budget of [1200, 3200]) {
      const v = view().buildSnapshotView(uni, { maxChars: budget });
      assert.ok(JSON.stringify(v.rows).length <= budget, `page 1 within ${budget}`);
    }
    const huge = view().buildSnapshotView(`- main [ref=e1]:\n  - button "${'x'.repeat(10000)}" [ref=e2]\n  - button "b" [ref=e3]`);
    assert.ok(huge.rows[0].name.length <= 161);
    assert.deepEqual(huge.refs, ['e2', 'e3'], 'both rows still fit one page');
  });

  test('main comes first; chrome and the category chips come after the items', () => {
    const v = view().buildSnapshotView(youtubeHome(3), { maxChars: 8000 });
    const lastVideo = v.rows.map((r) => !!(r.url && r.url.startsWith('/watch'))).lastIndexOf(true);
    assert.ok(lastVideo < v.rows.findIndex((r) => r.role === 'tab'), 'chips are controls for the list, not items in it');
    assert.ok(lastVideo < v.rows.findIndex((r) => r.region === 'banner'));
    assert.ok(lastVideo < v.rows.findIndex((r) => r.region === 'navigation'));
  });

  test('the search box leads the list — "search for X" must not need paging on a video site', () => {
    const v = view().buildSnapshotView(youtubeHome(40));
    assert.equal(v.rows[0].role, 'combobox');
    assert.equal(v.rows[0].region, 'search');
  });

  test('a modal dialog comes before the page it is blocking', () => {
    const yaml = youtubeHome(40) + '\n  - dialog "Before you continue" [ref=e9000]:\n    - button "Accept all" [ref=e9001]';
    const v = view().buildSnapshotView(yaml);
    assert.equal(v.rows[0].name, 'Accept all');
  });

  test('a heading that only wraps a link is dropped; an alert with words is kept; a field shows its value', () => {
    const v = view().buildSnapshotView([
      '- main [ref=e1]:',
      '  - heading "Apply" [level=1] [ref=e2]',
      '  - textbox "Email" [ref=e3]: ada@example.test',
      '  - alert [ref=e4]: Please enter a valid phone number',
      '  - heading "Title" [level=3] [ref=e5]:',
      '    - link "Title" [ref=e6]:',
      '      - /url: /t',
    ].join('\n'));
    assert.deepEqual(v.rows.map((r) => r.role), ['heading', 'textbox', 'alert', 'link']);
    assert.equal(v.rows[1].value, 'ada@example.test');
    assert.equal(v.rows[2].name, 'Please enter a valid phone number');
  });

  test('FIXTURE MUTATION: with no main landmark nothing is lost, and the videos keep page order', () => {
    const withMain = view().buildSnapshotView(youtubeHome(8), { maxChars: 20000 });
    const without = view().buildSnapshotView(youtubeHome(8, { withMain: false }), { maxChars: 20000 });
    assert.equal(without.totalRows, withMain.totalRows);
    assert.deepEqual(watchRows(without.rows).map((r) => r.url), watchRows(withMain.rows).map((r) => r.url));
  });

  test('ADJACENT: a small page is shown whole, one page, nothing omitted', () => {
    const v = view().buildSnapshotView('- main [ref=e1]:\n  - button "Play" [ref=e2]');
    assert.equal(v.pages, 1);
    assert.equal(v.totalRows, 1);
    assert.deepEqual(v.refs, ['e2']);
  });

  test('cross-frame refs are parsed as refs, not as names', () => {
    const v = view().buildSnapshotView('- main [ref=e1]:\n  - iframe [ref=e2]:\n    - textbox "Name" [ref=f2e8]');
    assert.deepEqual(v.refs, ['f2e8']);
  });
});

// -------------------------------------------- the model bound (model-result) --

describe('BUG-445 — results are bounded as a structure, never cut as text (model-result.js)', () => {
  test('a result that fits and carries no binary is the SAME object — unchanged bytes', () => {
    const r = { ok: 1, title: 'x' };
    assert.equal(bounded().boundForModel(r), r);
  });

  test('(d) binary leaves by FIELD IDENTITY even when small; the caller keeps its copy', () => {
    const r = { title: 'Page', screenshotBase64: 'AAAA', nested: { base64: 'BBBB' } };
    const out = bounded().boundForModel(r);
    assert.equal(out.screenshotBase64, undefined);
    assert.equal(out.nested.base64, undefined);
    assert.match(out._bounded, /screenshotBase64/);
    assert.equal(r.screenshotBase64, 'AAAA', 'the original result is never modified');
  });

  test('arrays lose items from the END; every item still shown keeps its index (no renumbering)', () => {
    const elements = Array.from({ length: 200 }, (_, index) => ({ index, name: 'element number ' + index }));
    const out = bounded().boundForModel({ window: 'App', elements });
    assert.ok(JSON.stringify(out).length <= 4000);
    assert.ok(out.elements.length > 20 && out.elements.length < 200);
    out.elements.forEach((e, k) => assert.equal(e.index, k));
    assert.match(out._bounded, /trailing item\(s\) of elements not shown/);
  });

  test('a long string is shortened with a marker; a long plain string result is bounded', () => {
    const out = bounded().boundForModel({ text: 'y'.repeat(9000) });
    assert.ok(JSON.stringify(out).length <= 4000);
    assert.match(out.text, /…$/);
    const s = bounded().boundForModel('z'.repeat(9000));
    assert.ok(s.length <= 4000);
    assert.match(s, /more characters not shown/);
  });

  test('an unserializable result is named, never thrown and never sent raw', () => {
    const cyc = { a: 1 };
    cyc.self = cyc;
    assert.match(bounded().boundForModel(cyc)._bounded, /could not be serialized/);
  });

  test('Unicode is counted as serialized, so a bounded result really fits', () => {
    const out = bounded().boundForModel({ rows: Array.from({ length: 300 }, () => 'বাংলা "উদ্ধৃতি" ⚠️') });
    assert.ok(JSON.stringify(out).length <= 4000);
  });
});

// MUTATION TABLE, 2026-09-23. Twelve probes, each applied (sha256 changed), run
// against this file and browser-snapshot-refs.test.js, and restored (sha256 equal):
//   M1  adapter cuts serialized text again (the old .slice(0, 4000))  -> (A3) (H)
//   M2  chrome first: banner/navigation before main                    -> (A1), main-first, search-first
//   M3  registry filled from the FULL tree, not the emitted rows       -> (A2)
//   M4  binary fields kept in the model text                           -> (A3) (H) (d)
//   M5  a ref parsed from anywhere in the line, inside the name too    -> (e)
//   M6  page-moved check removed                                       -> (D)
//   M7  a page of a superseded capture is served                       -> (E-stale)
//   M8  page 2 REPLACES page 1 in the registry                         -> (E)
//   M9  row budget ignores the header (fixed 3200)                     -> (H)
//   M10 links to one target not collapsed                              -> (A1) (a)
//   M11 a heading that only wraps a link is kept                       -> (A1), heading test
//   M12 page 2 re-captures instead of cutting the same capture         -> (E) (E-stale)
// M3 and M5 first ran with their regexes written through a shell heredoc, which
// ate the backslashes: M3 then SURVIVED and M5 reddened 19 tests for the wrong
// reason. Neither result was counted. Both were rewritten without the shell,
// the loaded probe text was printed and checked, and the rerun is what is above.
// Fixture mutation: `main` replaced by `generic` -> no row lost, video order kept
// (the FIXTURE MUTATION test pins it).
