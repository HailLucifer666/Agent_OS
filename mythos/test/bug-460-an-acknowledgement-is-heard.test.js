'use strict';

// BUG-460 — B2a of the Stage 1 repair campaign (2026-09-25), plan A5.
//
// fragment-guard.js corrects MYTHOS ("I did not catch that") when the operator's
// words are one short token and the reply is long. A recognised acknowledgement
// met that shape: on 2026-09-25 at 02:11:41 the operator said "Okay.", MYTHOS said
// "Glad to hear it. Anything interesting on your end, or just business as usual?",
// and the correction was injected (raw-S.log, live.text-injected
// ad4-correction-unheard, accepted:true).
//
// REPLAY FIRST (read-only, all four vault copies, 2286 Live turns). The rule fired
// 26 times. By what was heard:
//   acknowledgements   6   "Okay." x2, "No." x2, "Sure.", "Right."  all FALSE —
//                          the operator was understood ("Right." reported the
//                          clipboard_read of the turn before)
//   command words      7   "browser", "YouTube", "Chrome", "music", "again",
//                          "further", "Windows" — a separate question (B2c); unchanged
//   garbled / unclear 11   "Voetrij", "OXalpha", "chá", "November", ... — what the
//                          rule exists for; unchanged
//   other              2   "Sí.", "¿Qué?" — likely a mis-transcription; unchanged
// The fix exempts exactly the first class. The replay is re-run in (r1).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isAssertionOnUnintelligibleInput } = require('../src/core/voice/fragment-guard');
const { isAcknowledgement } = require('../src/core/voice/acknowledgement');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { TIER_TABLE } = require('../src/core/leash/tiers');

// Verbatim from the 2026-09-25 session (Episodic), and the other five replayed acknowledgements' reply lengths.
const SAID_OKAY = 'Glad to hear it. Anything interesting on your end, or just business as usual?';
const LONG_REPLY = 'Understood, I will keep the windows as they are then. What would you like to do next?';
const ACK_CASES = ['Okay.', 'No.', 'Sure.', 'Right.'];

const verdictFor = (d) => (TIER_TABLE[d.tool] === 3
  ? { allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }
  : { allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' });

function harness(outcomeFor) {
  const injected = []; const anomalies = [];
  const adapter = createLiveToolAdapter({
    leash: { check: verdictFor, confirm: { create: () => 'c' } },
    dispatchAction: async (d) => outcomeFor(d.tool || d.name || ''),
    bus: { emit: (type, p) => { if (type === 'health.anomaly') anomalies.push(p); } },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-460-ack',
    memory: { working: { tick: 1 }, episodic: { write() {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => injected.push(t) }),
    toolAckDeadlineMs: 500,
  });
  return { adapter, injected, anomalies };
}
const fired = (h) => h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length;
const noticed = (h) => h.injected.some((t) => /did not\s+transcribe as anything intelligible/.test(t));

describe('an acknowledgement is heard, not a fragment', () => {
  it('(a1 repro) 02:11:41 verbatim, through the real adapter: "Okay." + read_status + a normal reply draws no correction', async () => {
    const h = harness(() => ({ ok: true, result: { status: 'ok' } }));
    await h.adapter.handleLiveToolCalls([{ id: 'c-rs', name: 'read_status', args: {} }], { sendToolResponse: () => {}, userTextSoFar: 'Okay.' });
    h.adapter.onLiveTurnComplete({ userText: 'Okay.', assistantText: SAID_OKAY, turnId: 2 });
    assert.equal(fired(h), 0, 'before B2a: the anomaly fired and the "did not catch that" notice was injected');
    assert.equal(noticed(h), false);
  });

  it('(a2 repro) each replayed acknowledgement, with a reply past the threshold and no action', () => {
    for (const heard of ACK_CASES) assert.equal(isAssertionOnUnintelligibleInput(heard, LONG_REPLY, []), false, heard);
  });

  it('(a3) the operator\'s three languages, native script and romanised, and the punctuation around them', () => {
    for (const w of ['OKAY!', 'okay?', 'Okay…', 'ok', '"Yeah."', 'Nope', 'হ্যাঁ', 'না।', 'আচ্ছা', 'हाँ', 'नहीं।', 'ठीक', 'haan', 'Theek', 'accha']) {
      assert.equal(isAcknowledgement(w), true, w);
    }
  });
});

describe('what must still draw the correction', () => {
  it('(k1 must-keep) garbled tokens from the replay still fire', () => {
    for (const heard of ['Voetrij', 'OXalpha', 'chá', 'November', 'आदिए']) {
      assert.equal(isAssertionOnUnintelligibleInput(heard, LONG_REPLY, []), true, heard);
    }
  });

  it('(k2 must-keep) a command word is not an acknowledgement: "further" with no oracle still fires, through the real adapter', async () => {
    const h = harness(() => ({ ok: true, unverified: true, reason: 'could not read the scroll position', result: {} }));
    await h.adapter.handleLiveToolCalls([{ id: 'c-sc', name: 'browser_scroll', args: { direction: 'down' } }], { sendToolResponse: () => {}, userTextSoFar: 'further' });
    h.adapter.onLiveTurnComplete({ userText: 'further', assistantText: 'Got it, going further down. How about now, do you see it?', turnId: 3 });
    assert.equal(fired(h), 1);
    for (const w of ['browser', 'music', 'again', 'YouTube']) assert.equal(isAcknowledgement(w), false, w);
  });

  it('(k3, attacked) near-misses are not acknowledgements: the whole utterance or nothing', () => {
    for (const w of ['okayyy', 'o.k.ay', 'no1', 'know', 'noon', 'nod', 'rightt', 'okay-play', 'yesterday', 'haanji', 'Sí.', '¿Qué?', 'hmm', 'mm', 'uh-huh', '']) {
      assert.equal(isAcknowledgement(w), false, JSON.stringify(w));
    }
    // An acknowledgement followed by a request is a request; the guard never sees it (it has a space), and the classifier refuses it too.
    assert.equal(isAcknowledgement('okay, play it'), false);
  });

  it('(k4 must-keep) an empty transcript and a short reply are unchanged', () => {
    assert.equal(isAssertionOnUnintelligibleInput('', LONG_REPLY, []), false);
    assert.equal(isAssertionOnUnintelligibleInput('Voetrij', 'Okay, Sir.', []), false);
  });
});

describe('an acknowledgement is never consent', () => {
  it('(c1) only fragment-guard.js imports the classifier — derived by scanning every source file', () => {
    const root = path.join(__dirname, '..');
    const importers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); continue; }
        if (!/\.(js|mjs|cjs)$/.test(e.name) || p.includes(path.sep + 'test' + path.sep)) continue;
        if (/acknowledgement(\.js)?['"]/.test(fs.readFileSync(p, 'utf8'))) importers.push(path.relative(root, p).split(path.sep).join('/'));
      }
    };
    for (const d of ['src', 'server', 'ui', 'electron', 'scripts', 'adapters']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
    assert.deepEqual(importers.sort(), ['src/core/voice/fragment-guard.js'],
      'an acknowledgement classifier reachable from the authority gate or a confirm path would turn "okay" into a yes');
  });
});

describe('the replayed history', () => {
  it('(r1) the six acknowledgement fires are exempt; every other replayed fire still fires', () => {
    // Heard text of all 26 replayed fires (their replies were all past the threshold).
    const garbledOrCommand = ['tooling', 'again', 'browser', 'YouTube', 'Chrome', 'head', 'Voetrij', 'Sí.', '¿Qué?', 'Windows',
      'OXalpha', '2.0', 'music', 'anything', 'bro', 'Obituary', 'never', 'chá', 'November', 'further'];
    for (const heard of ['Sure.', 'No.', 'No.', 'Okay.', 'Right.', 'Okay.']) assert.equal(isAssertionOnUnintelligibleInput(heard, LONG_REPLY, []), false, heard);
    for (const heard of garbledOrCommand) assert.equal(isAssertionOnUnintelligibleInput(heard, LONG_REPLY, []), true, heard);
  });
});

// NEGATIVE CONTROL, run 2026-09-25: with acknowledgement.js present but not yet
// consulted by fragment-guard.js (main's rule), a1, a2, c1 and r1 fail — a1 through
// the real adapter, firing the anomaly on "Okay." exactly as at 02:11:41. The five
// must-keep and classifier tests pass on both.
//
// MUTATION RECORD, run 2026-09-25. Each probe applied as an exact substring
// (verified to change the file), this file run, the source restored from a byte
// copy and checked by sha256.
//   m1 the guard no longer consults the classifier        → a1, a2, r1
//   m2 punctuation stripped anywhere, not at the edges     → k3
//   m3 a prefix counts as the whole utterance              → k1, k3, r1
//   m4 a filler sound ("hmm") joins the list               → k3
//   m5 no case folding                                     → a1, a2, a3, r1
//   m6 the danda leaves the shared punctuation class       → a3
//   m7 the trailing edge is not stripped                   → a1, a2, a3, r1
//   m8 the authority layer imports the classifier          → c1
// Two findings from the probes, both fixed before this record: a first draft
// wrote the leading and trailing punctuation classes out separately, and dropping
// the danda from the leading one survived every test (nothing starts with a
// danda) — the edges now share one class, so they cannot diverge; and a
// .normalize('NFC') step changed none of the listed words, so it was removed
// rather than kept untested.
