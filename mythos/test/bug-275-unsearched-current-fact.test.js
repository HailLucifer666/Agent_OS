'use strict';

// test/bug-275-unsearched-current-fact.test.js — BUG-275, the 2026-09-23 shapes.
//
// Two defects from the attended run, both measured from the 09-23 Episodic file:
//
// 1. STALE KNOWLEDGE STATED AS CURRENT, NO SEARCH (14:08:59). "there hasn't been
//    an official announcement for a Nothing Phone (4a) Pro yet — they're on the
//    Phone (2a) right now", answered from the model's memory with no web_search.
//    The plan allowed a detector only after a corpus replay with every hit read;
//    that replay (two whole days, 773 sentences) and its verdict are recorded in
//    src/core/voice/unsearched-current-fact.js, and are re-runnable with
//    `node scripts/replay-ranked-detectors.js <day> --verbose`. Test (j) proves the
//    replay reader actually parses rows, because this repo has a replay that once
//    reported "0 replies, 0 hits" from a reader that had parsed nothing.
//
// 2. HALF A SENTENCE, IN THE MODEL AND IN THE VAULT (screen_look). The premise as
//    filed — "reached the model at 1,351 characters but was stored at 600" — is
//    REFUTED by the row itself: the vault holds the whole result the model saw
//    (description, 12 OCR lines, counts); 1,351 was that whole result. The real
//    defect is one step earlier: from-pc.js cut the vision description with a
//    plain slice(0, 600), so the model read "…verifying that the Brave browser and
//    expected side effects" and was left to finish the sentence itself.
//
// RED FIRST, 2026-09-23, against 23de0491 (HEAD's files restored in place, then
// the working ones put back and re-hashed identical): all 15 failed. The screen
// test (l) for its stated reason — "cut mid-sentence: … The Brave browser shows a
// conv". The rest because the detector, the replay pass and the cut helper did
// not exist; that includes the adjacent cases (b)–(d) and (m), so their bounds are
// carried by the probes below rather than by the red run.
//
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const ucf = () => require('../src/core/voice/unsearched-current-fact');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INCIDENT = "Although there hasn't been an official announcement for a Nothing Phone (4a) Pro yet — they're on the Phone (2a) right now — based on their track record, I'd expect them to lean into that distinctive transparent design.";
const INCIDENT_WINDOW = [{ tool: 'screen_read_text', ok: true }, { tool: 'clipboard_read', ok: true }, { tool: 'propose_goal', ok: true }];

describe('BUG-275 — a changeable fact stated as current, with no web lookup, is reported', () => {
  test('(a) THE 14:08:59 ANSWER, with the tools really in its window, is reported — an unrelated screen read is not a lookup', () => {
    const hits = ucf().detectUnsearchedCurrentFacts(INCIDENT, [], INCIDENT_WINDOW);
    assert.equal(hits.length, 1, 'the first replay draft missed exactly this, because screen_read_text counted as "looked it up"');
    assert.deepEqual(hits[0].sawTools.sort(), ['clipboard_read', 'propose_goal', 'screen_read_text']);
  });

  test('(a2) the 08-19 08:35 answer: "Latest version is ChatGLM 5.2" over think_deeply + open_web is reported', () => {
    const hits = ucf().detectUnsearchedCurrentFacts('Latest version is ChatGLM 5.2, launched in May.', [], [{ tool: 'think_deeply' }, { tool: 'open_web' }]);
    assert.equal(hits.length, 1, 'think_deeply is a model call and open_web opens a page the model cannot read');
  });

  test('(b) ADJACENT: the same kind of sentence AFTER a web lookup is silent — the 09-23 grounded answer', () => {
    assert.deepEqual(ucf().detectUnsearchedCurrentFacts(
      "I've just searched and can confirm that not only does the Nothing Phone (4a) Pro exist, but it was released in March of 2026.",
      [{ tool: 'web_search', ok: true }], []), []);
    for (const tool of ucf().WEB_LOOKUP_TOOLS) {
      assert.deepEqual(ucf().detectUnsearchedCurrentFacts(INCIDENT, [], [{ tool, ok: false }]), [],
        tool + ': an attempted lookup counts; a fact over a FAILED search is claim-check\'s external-fact category');
    }
  });

  test('(c) ADJACENT: questions and "checking … now" promises are not assertions', () => {
    for (const s of ['Should I pull up the latest build, or perhaps check the current news on YouTube?',
      'Checking latest headlines now, Sir.', "I'm checking the current price for the 256GB variant."]) {
      assert.deepEqual(ucf().detectUnsearchedCurrentFacts(s, [], []), [], s);
    }
  });

  test('(d) ADJACENT: stable knowledge has none of the shapes', () => {
    for (const s of ['Paris is the capital of France.', 'Python was created by Guido van Rossum.',
      'A kilobyte is a thousand bytes.', 'Your meeting is at four.']) {
      assert.deepEqual(ucf().detectUnsearchedCurrentFacts(s, [], []), [], s);
    }
  });

  test('(e) one row per reply, and the stored sentence is bounded', () => {
    const longSentence = 'The latest model ' + 'is quite something and '.repeat(20) + 'is out.';
    assert.ok(longSentence.length > ucf().CLAIM_CHARS, 'fixture check: the MATCHED sentence itself is over the bound');
    const hits = ucf().detectUnsearchedCurrentFacts(longSentence + ' It costs forty thousand rupees.', [], []);
    assert.equal(hits.length, 1);
    assert.ok(hits[0].sentence.length <= ucf().CLAIM_CHARS);
  });

  test('(f) THE KNOWN FALSE POSITIVE is pinned, not fitted away: MYTHOS describing its own launch', () => {
    // 08-19 20:08:32, the one false positive the replay found. Excluding it would
    // take a rule about MYTHOS's own actions that one sentence cannot justify; for
    // a SILENT anomaly a stray row costs nothing but a line in the vault. If this
    // ever needs to change, change it here, on purpose.
    const hits = ucf().detectUnsearchedCurrentFacts('I also have open browser windows (brave was mentioned as running, chrome was launched but visibility is unverified).',
      [], [{ tool: 'open_web' }, { tool: 'close_panel' }]);
    assert.equal(hits.length, 1);
  });
});

describe('BUG-275 — silent by construction, and acknowledged', () => {
  test('(g) the reporter\'s only effect is one health.anomaly with a reason', () => {
    const events = [];
    ucf().reportUnsearchedCurrentFacts({ bus: { emit: (type, payload) => events.push({ type, payload }) }, assistantText: INCIDENT, actionsThisTurn: [], recentActions: INCIDENT_WINDOW });
    assert.deepEqual(events.map((e) => e.type), ['health.anomaly']);
    assert.equal(events[0].payload.kind, 'unsearched-current-fact');
    assert.ok(events[0].payload.reason.length > 20);
  });

  test('(h) nothing the silent-detector module reaches can speak or dispatch', () => {
    const dir = path.join(__dirname, '..', 'src', 'core', 'voice');
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const agg = read('silent-turn-anomalies.js');
    const reached = [...agg.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1] + '.js');
    assert.deepEqual(reached.sort(), ['promoted-rank-anomaly.js', 'spoken-tool-syntax.js', 'unsearched-current-fact.js']);
    for (const f of ['silent-turn-anomalies.js', ...reached]) {
      assert.doesNotMatch(read(f), /\b(?:sendSystemNotice|reportTurnAudit|sendText|speak\w*|dispatch\w*|invoke)\s*\(|action\.speak-requested/,
        f + ' is on the silent path; a spoken retraction of a content judgement needs its own review');
    }
  });

  test('(i) BUS-LEVEL: through the real diagnostician, healer and explainer, it is acknowledged and nothing is spoken', async () => {
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
    const explainer = createExplainer({ bus, brain: { think: async () => { brainCalls += 1; return { text: 'x' }; } }, memory: null, config: {}, logger: { info() {}, warn() {} } });
    diagnostician.start(); if (healer.start) healer.start(); explainer.start();
    ucf().reportUnsearchedCurrentFacts({ bus, assistantText: INCIDENT, actionsThisTurn: [], recentActions: [] });
    await sleep(300);
    explainer.stop(); if (healer.stop) healer.stop(); diagnostician.stop();
    assert.equal(healed.length, 1, 'fixture check: it reached the healer');
    assert.equal(healed[0].playbookId, 'unsearched-current-fact-known');
    assert.equal(healed[0].outcome, 'acknowledged');
    assert.deepEqual(spoken, []);
    assert.equal(brainCalls, 0);
  });

  test('(k) THROUGH THE REAL ADAPTER: the recorded turn yields the anomaly and no [SYSTEM] notice', () => {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
    const anomalies = []; const notices = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }), confirm: { create: () => 'c', reject() {} } },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit: (t, p) => { if (t === 'health.anomaly') anomalies.push(p); } }, logger: { info() {}, warn() {} },
      connectionId: 'conn-275', memory: { working: { tick: 1 }, episodic: { write: async () => {} } }, historyAppend: () => {},
      reflection: null, summarizeActionsForResult, config: {},
      getLiveSession: () => ({ isOpen: () => true, sendText: (text, meta) => { notices.push(meta && meta.site); return true; } }),
    });
    adapter.onLiveTurnComplete({ userText: 'What do you think about the phone called Nothing Phone (4a) Pro?', assistantText: INCIDENT });
    assert.ok(anomalies.some((a) => a.kind === 'unsearched-current-fact'), JSON.stringify(anomalies.map((a) => a.kind)));
    assert.deepEqual(notices, [], 'silent: no [SYSTEM] notice for it');
  });
});

describe('BUG-275 — the replay is reproducible', () => {
  test('(j) the replay script parses a day file and counts the unsearched hit — a zero from a blind reader is not a result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug275-replay-'));
    const day = path.join(dir, 'day.jsonl');
    const t0 = Date.UTC(2026, 8, 23, 8, 38, 0);
    fs.writeFileSync(day, [
      { kind: 'action', summary: 'screen_read_text({})', ts: t0, outcome: 'ok', detail: { result: { text: 'x' } } },
      { kind: 'conversation', ts: t0 + 59000, detail: { role: 'assistant', text: 'What do you think about the Nothing Phone (4a) Pro?', reply: INCIDENT, actions: [] } },
      { kind: 'conversation', ts: t0 + 90000, detail: { role: 'assistant', text: 'capital of France?', reply: 'Paris is the capital of France.', actions: [] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'replay-ranked-detectors.js'), day], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /replies=2\b/, 'the reader must see both replies: ' + r.stdout);
    assert.match(r.stdout, /unsearched-current-fact hits: 1 \(over all 2 replies\)/, r.stdout);
  });
});

// ---- screen_look: the description is cut at a sentence, and says so ----------

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
async function look(ocrText, visionReply) {
  const originalRequire = Module.prototype.require;
  const pc = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'screen_look') return { ok: true, result: { base64: 'ZmFrZS1wbmc=', width: 1920, height: 1080 } };
      if (c.cmd === 'screen_read_text') return { ok: true, result: { text: ocrText, lineCount: ocrText.split('\n').length } };
      return { ok: true, result: {} };
    },
  };
  Module.prototype.require = function (id) { return id === '../../../adapters/pc-child' ? pc : originalRequire.apply(this, arguments); };
  delete require.cache[FROM_PC_PATH];
  try {
    const m = require(FROM_PC_PATH);
    m.registerFromPc({ register: () => {}, effectors: new Map() }, {
      brain: { think: async () => ({ content: visionReply, offline: false }) },
      fs: { readJSON: () => null, writeJSON: () => {} },
      visionChainFor: async () => [{ provider: 'test', model: 'test-vision' }],
    });
    return await m.screen_look({ query: 'what is on screen?' });
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

describe('BUG-275 — screen_look never hands the model half a sentence', () => {
  const OCR = 'Brave browser\nlist_windows\nverifying side effects\nsettings panel\nconversation summary\nReact component';
  const SENTENCE = 'The Brave browser shows a conversation summary about list_windows and verifying side effects in a settings panel. ';

  test('(l) a long grounded description ends at a sentence, and the result says it was cut', async () => {
    const reply = SENTENCE.repeat(9); // ~1,000 characters, well over the 600 budget
    const res = await look(OCR, reply);
    assert.equal(res.ok, true, 'fixture check: the description is grounded in the OCR text');
    assert.ok(res.result.description.length <= 600);
    assert.match(res.result.description, /[.!?]$/, 'cut mid-sentence: ' + JSON.stringify(res.result.description.slice(-60)));
    assert.equal(res.result.descriptionTruncated, true, 'the model must know it holds part of the description');
  });

  test('(m) ADJACENT: a short description is untouched, and not marked', async () => {
    const res = await look(OCR, SENTENCE.trim());
    assert.equal(res.result.description, SENTENCE.trim());
    assert.equal(res.result.descriptionTruncated, false);
  });

  test('(n) a run-on description with no sentence end in reach is cut at a word, with an ellipsis — never mid-word', () => {
    const { cutEvidence } = require('../src/core/util/cut-evidence');
    const runOn = 'the Brave browser ' + 'shows panels and windows and settings '.repeat(30);
    const out = cutEvidence(runOn, 600);
    assert.equal(out.truncated, true);
    assert.ok(out.text.length <= 600);
    assert.match(out.text, / …$/);
    const kept = out.text.slice(0, -2).trim();
    assert.ok(runOn.startsWith(kept), 'the kept text is a prefix of the original');
    assert.equal(runOn[kept.length], ' ', 'and it ends at a word boundary, not inside a word');
    const early = 'Short. ' + 'x'.repeat(900);
    assert.match(cutEvidence(early, 600).text, / …$/, 'a sentence end that keeps under half the budget is not taken');
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug275/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All 15 tests were
// GREEN before each one.
//
//   U1  any tool in the window counts as a lookup (the first draft) -> (a)(a2)(f)
//   U2  questions treated as assertions                   -> (c)
//   U3  "checking … now" promises treated as assertions   -> (c)
//   U4  the stored sentence is unbounded                  -> (e)
//   U5  the silent aggregator drops this detector         -> (k)
//   U6  the healer playbook stops matching the kind       -> (i)
//   U7  the replay reader ignores a .jsonl path           -> (j)
//   U8  the replay has no unsearched pass                 -> (j)
//   U9  screen_look slices the description again          -> (l)
//   U10 screen_look drops the truncation flag             -> (l)(m)
//   U11 the half-budget floor is removed                  -> (n)
//   U12 the fallback cuts mid-word                        -> (n)
//   U13 the detector speaks its finding                   -> (g)(h)(i)
//
// TWO PROBES OF THE WIRING THIS CHANGE MOVED (the silent detectors' single call
// site in live-tool-adapter.js became silent-turn-anomalies.js):
//   P9b remove BUG-449's detector from the aggregator     -> bug-449 (k)
//   H1b remove BUG-275 H1's detector from the aggregator  -> SURVIVED on the first
//       run: no test drove H1 through the adapter, before or after the move. Test
//       (k) in bug-275-h1-promoted-ranked-entity.test.js was written from that, and
//       H1b now reddens it.
//
// Two tests were sharpened by reading them against their probes before the run:
// (e) first bounded a sentence that was never long, and (n) accepted any prefix,
// mid-word included.
