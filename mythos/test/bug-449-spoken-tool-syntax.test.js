'use strict';

// test/bug-449-spoken-tool-syntax.test.js — BUG-449, the detector half.
//
// THE INCIDENT, 2026-09-23 14:13:16 (attended run, turn 50). What the operator
// heard began, verbatim from the output transcription:
//   call:web_search{maxResults:5,query:Nothing Phone (4a) Pro 256I completely
//   understand your frustration, Sir.
// and no web_search ran that turn. Nothing recorded it: a textual "call" is not a
// tool call, and the claim checker has no shape for a spoken call string.
//
// WHAT IS PINNED HERE. The syntax is detected and reported as a SILENT
// `spoken-tool-syntax` anomaly naming the tool and whether a real call of it ran;
// the parsed text is never executed; nothing about it is spoken, either by the
// adapter or by the immune explainer (the healer acknowledges the kind).
//
// NOT COVERED, AND WHY BUG-449 STAYS OPEN: prevention. The words have already been
// heard when their transcript arrives; stopping them before playback needs the
// validated text lane (plan decision D7, deferred).
//
// RED FIRST, 2026-09-23, against 469858b1 (HEAD's files restored in place, then
// the working ones put back and re-hashed identical): all 12 failed. Eleven
// because the module, the playbook or the wiring did not exist; (k), through the
// real adapter, for the stated reason — "the recorded turn produced no anomaly".
// The adjacent case (b) could not load there either, so its bound is proven by
// probe P3 below rather than by the red run.
//
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RECORDED = 'call:web_search{maxResults:5,query:Nothing Phone (4a) Pro 256I completely understand your frustration, Sir.';
const det = () => require('../src/core/voice/spoken-tool-syntax');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-449 — tool-call syntax spoken aloud is detected', () => {
  test('(a) THE RECORDED TRANSCRIPT: web_search named, and no web_search ran', () => {
    const hits = det().detectSpokenToolSyntax(RECORDED, []);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].tool, 'web_search');
    assert.equal(hits[0].toolCallHappened, false);
    assert.match(det().reasonFor(hits[0]), /web_search call aloud as text.*no web_search call ran/);
  });

  test('(b) ADJACENT: prose that merely names a tool, or says what it will do, is not syntax', () => {
    for (const text of [
      "I'll search the web for the current price.",
      'The web_search tool is what I would use here.',
      'Call me when you are ready: I will open YouTube.',
      'I used web search earlier (it found three results).',
      'The web_search (the fast one) is what I would reach for.',
    ]) assert.deepEqual(det().detectSpokenToolSyntax(text, []), [], text);
  });

  test('(c) the other call shapes: code-style default_api, and name(key=…) / name{key:…}', () => {
    assert.deepEqual(det().detectSpokenToolSyntax('print(default_api.open_web(url="https://youtube.com"))', []).map((h) => h.tool), ['open_web']);
    assert.deepEqual(det().detectSpokenToolSyntax('web_search(query="nothing phone price")', []).map((h) => h.tool), ['web_search']);
    assert.deepEqual(det().detectSpokenToolSyntax('launch_app{name: notepad}', []).map((h) => h.tool), ['launch_app']);
  });

  test('(d) an unknown name is not reported — the bound is the real tool set', () => {
    assert.deepEqual(det().detectSpokenToolSyntax('call:mom{now:1} and call:foo_bar{x:1}', []), []);
  });

  test('(e) when the real call DID run, the row says so', () => {
    const hits = det().detectSpokenToolSyntax(RECORDED, [{ tool: 'web_search', ok: true }]);
    assert.equal(hits[0].toolCallHappened, true);
  });

  test('(f) one row per tool per turn; two tools are two rows; the fragment is bounded', () => {
    const long = RECORDED + ' ' + 'x'.repeat(500) + ' call:web_search{query:again} call:open_web{url:y}';
    const hits = det().detectSpokenToolSyntax(long, []);
    assert.deepEqual(hits.map((h) => h.tool).sort(), ['open_web', 'web_search']);
    assert.ok(hits.every((h) => h.fragment.length <= det().FRAGMENT_CHARS));
  });

  test('(g) DERIVED: every tool the leash knows is recognised — a new tool is covered the day it is registered', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    const missed = Object.keys(TIER_TABLE).filter((tool) =>
      !det().detectSpokenToolSyntax('call:' + tool + '{x:1}', []).some((h) => h.tool === tool));
    assert.deepEqual(missed, []);
  });
});

describe('BUG-449 — the parsed text is never executed, and nothing is spoken', () => {
  test('(h) the module requires only the tier table, and never names a way to run anything', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'voice', 'spoken-tool-syntax.js'), 'utf8');
    const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.deepEqual([...code.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['../leash/tiers']);
    assert.doesNotMatch(code, /\b(?:dispatch\w*|invoke|execute|sendText|sendToolResponse|speak\w*)\s*\(/,
      'a spoken call string must stay a label; running it would be an action nobody authorised');
  });

  test('(i) the reporter\'s ONLY effect is one health.anomaly per hit, carrying a reason', () => {
    const events = [];
    const n = det().reportSpokenToolSyntax({ bus: { emit: (type, payload) => events.push({ type, payload }) }, assistantText: RECORDED, actionsThisTurn: [] });
    assert.equal(n, 1);
    assert.deepEqual(events.map((e) => e.type), ['health.anomaly']);
    const p = events[0].payload;
    assert.equal(p.kind, 'spoken-tool-syntax');
    assert.equal(p.spokenTool, 'web_search');
    assert.equal(p.toolCallHappened, false);
    assert.ok(p.reason && p.reason.length > 20, 'an anomaly without a reason is narrated as an unexplained fault');
  });

  test('(j) BUS-LEVEL: through the real diagnostician, healer and explainer, it is acknowledged and NOTHING is spoken', async () => {
    const { createBus } = require('../src/core/bus');
    const { createDiagnostician } = require('../src/core/immune/diagnostician');
    const { createHealer } = require('../src/core/immune/healer');
    const { createExplainer } = require('../src/core/immune/explainer');
    const bus = createBus({ historySize: 200 });
    const spoken = []; const healed = []; let brainCalls = 0;
    bus.subscribe('action.speak-requested', (e) => spoken.push(e.payload));
    bus.subscribe('health.healed', (e) => healed.push(e.payload));
    const diagnostician = createDiagnostician({ bus });
    const healer = createHealer({ bus, config: {}, effectors: null, brain: null });
    const explainer = createExplainer({ bus, brain: { think: async () => { brainCalls += 1; return { text: 'x' }; } },
      memory: null, config: {}, logger: { info() {}, warn() {} } });
    diagnostician.start(); if (healer.start) healer.start(); explainer.start();
    det().reportSpokenToolSyntax({ bus, assistantText: RECORDED, actionsThisTurn: [] });
    await sleep(300);
    explainer.stop(); if (healer.stop) healer.stop(); diagnostician.stop();
    assert.equal(healed.length, 1, 'fixture check: the anomaly reached the healer');
    assert.equal(healed[0].playbookId, 'spoken-tool-syntax-known');
    assert.equal(healed[0].outcome, 'acknowledged');
    assert.deepEqual(spoken, [], 'nothing about a spoken tool call may itself be spoken — Live or not');
    assert.equal(brainCalls, 0, 'and the explainer\'s brain call (the measured cost F8 avoids) never runs');
  });

  test('(k) THROUGH THE REAL ADAPTER: the recorded turn yields the anomaly and no [SYSTEM] notice', () => {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
    const anomalies = []; const notices = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }), confirm: { create: () => 'c', reject() {} } },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit: (t, p) => { if (t === 'health.anomaly') anomalies.push(p); } }, logger: { info() {}, warn() {} },
      connectionId: 'conn-449', memory: { working: { tick: 1 }, episodic: { write: async () => {} } }, historyAppend: () => {},
      reflection: null, summarizeActionsForResult, config: {},
      getLiveSession: () => ({ isOpen: () => true, sendText: (text, meta) => { notices.push(meta && meta.site); return true; } }),
    });
    adapter.onLiveTurnComplete({ userText: 'what is the price in india', assistantText: RECORDED });
    const row = anomalies.find((a) => a.kind === 'spoken-tool-syntax');
    assert.ok(row, 'the recorded turn produced no anomaly: ' + JSON.stringify(anomalies.map((a) => a.kind)));
    assert.equal(row.spokenTool, 'web_search');
    assert.deepEqual(notices, [], 'the detector is silent: no [SYSTEM] notice may be injected for it');
  });
});

describe('BUG-449 — the known-condition playbooks moved without changing', () => {
  test('(l) the healer still holds the four F8 playbooks, in order, right after aether-proxy-rebind, then the new one', () => {
    const ids = require('../src/core/immune/healer').SEED_PLAYBOOKS.map((p) => p.id);
    const at = ids.indexOf('aether-proxy-rebind');
    assert.deepEqual(ids.slice(at, at + 6), ['aether-proxy-rebind', 'live-turn-no-transcript-known', 'live-turn-silent-known',
      'claimed-action-not-taken-known', 'live-tool-outcome-late-known', 'spoken-tool-syntax-known']);
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug449/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All 12 tests were
// GREEN before each one.
//
//   P1  any name counts, not only real tools              -> (d)
//   P2  the call: shape is dropped                        -> (g) only — see below
//   P3  name(…) no longer needs key: / key= after it      -> (b)
//   P4  toolCallHappened always false                     -> (e)
//   P5  no one-row-per-tool dedupe                        -> (a)(c)(f)
//   P6  the fragment is not bounded                       -> (f)
//   P7  the reporter speaks the finding                   -> (i)(j)
//   P8  the healer playbook stops matching the kind       -> (j)
//   P9  the adapter no longer runs the detector           -> (k)
//       [2026-09-23, later the same day: the call moved into silent-turn-anomalies.js
//       with BUG-275's detector. Re-run there as P9b — removing it from that module —
//       and (k) still reddens.]
//   P10 the tool set is hand-typed instead of derived     -> (g)
//   P11 the module takes a door to run things             -> (h)
//
// P2 IS WORTH READING. Dropping the call: shape did NOT redden (a), because the
// recorded transcript is also matched by the name{key: shape (web_search{maxResults:).
// Two patterns catch the incident; (g), which drives every tool through the call:
// shape alone, is the test that pins that shape. Found by the probe, not by reading.
