'use strict';

// S1 of the Stage 1 repair campaign (2026-09-25) — audit findings F01-F05
// (mythos/docs/PLAN-AUDIT-2026-09-25.md), residuals of BUG-461 and BUG-464.
// "Ask first" is only as good as what it checks, and against main f456217d it
// checked the SHAPE of the operator's words, not their meaning:
//   F01  "Please do not click that button"            -> proceed (a click)
//   F02  "Could you explain why this happens"         -> proceed (a click)
//   F03  "Remember my favorite color is blue"         -> may save "...is green"
//   F04  "Shall I play the other video instead?"      -> presents a click on a video it never named
//   F05  "I will not remember your favorite color is blue" counts as reading
//        "Your favorite color is blue" back; so does a read-back the room never
//        heard, because nothing asked whether the audio played.
// Each is reproduced below as the test marked (repro); every one of those was
// green BEFORE this change in the sense that the old code produced the unsafe
// answer — the mutation record at the end of this file says which fail on the
// old code and how that was checked.
//
// Measured before writing the rules (Gate A), read-only over all four vault
// roots, 15,587 Episodic rows: 294 gated calls, 158 of which ran straight away
// under the old rules. Under these rules 126 still do; the 32 that now ask were
// read one by one. Among them: a window closed after "Can you open Brave?"
// (five times), a click after "take a screenshot", a window closed after "can
// you show us". Of 47 remember calls, 3 proceeded; 2 still do, and the third
// was a paraphrase ("on a new tab" saved as "in a new tab") that is read back now.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const authority = require('../src/core/voice/operator-authority');
const words = require('../src/core/voice/authority-words');
const { createAuthorityGate, createTypedMemoryGate, HUMAN_PREMISE_REASONS } = require('../src/core/voice/authority-gate');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { createLiveSession } = require('../src/core/voice/live-session');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { buildTools } = require('../src/core/effectors/from-memory');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { makeLeash } = require('./helpers/leash-fixture');

const TODAY = new Date(2026, 8, 25);
const trusted = (current, tool, args, extra) => authority.judgeTrustedAction(Object.assign({ current, tool, args, previousAgeMs: NaN }, extra));
const memory = (current, text, extra) => authority.judgeMemoryWrite(Object.assign({ current, text, today: TODAY }, extra));

describe('F01 — a prohibition is never a request', () => {
  it('(a1 repro) "Please do not click that button" holds the click', () => {
    assert.deepEqual(trusted('Please do not click that button', 'browser_click'), { proceed: false, reason: 'operator-prohibited' });
  });

  it('(a2) contractions, a missing apostrophe, a phone keyboard\'s apostrophe, "never" and "stop clicking"', () => {
    for (const [s, tool] of [['Don\'t click it, please, not yet.', 'browser_click'], ['dont click that one for now', 'see_and_click'],
      ['Please don’t press anything right now', 'browser_press_key'], ['Never open that link again, okay?', 'browser_click'],
      ['Do not type that into the box please', 'browser_type'], ['Stop clicking things on the page, please.', 'ui_click'],
      ['Please don\'t do anything with the windows yet', 'close_window']]) {
      assert.equal(trusted(s, tool, { text: 'x' }).reason, 'operator-prohibited', s);
    }
  });

  it('(a3) denial wins over a nearby "please" and a new request: a mixed sentence asks', () => {
    assert.equal(trusted('Don\'t click that one, click the other one please', 'browser_click').reason, 'operator-prohibited');
    assert.equal(trusted('My note says "do not press enter" but can you press escape', 'browser_press_key', { key: 'Escape' }).reason,
      'operator-prohibited', 'a quoted prohibition only ever makes a call ask');
  });

  it('(a4) a prohibition holds the operation it names, not every operation (the real 07-31 line)', () => {
    const line = 'Yeah, I approve you to type but do not press enter.';
    assert.equal(authority.prohibits(line, 'ui_type'), false, 'typing was approved');
    assert.equal(authority.prohibits(line, 'browser_press_key'), true, 'pressing was not');
    assert.equal(trusted(line, 'browser_press_key', { key: 'Enter' }).reason, 'operator-prohibited');
    // BOUND, pinned: the typing still asks, as it did before S1 — "I approve you
    // to" is not one of the request forms (REQUEST_PHRASE_RE).
    assert.equal(trusted(line, 'ui_type', { text: 'hi' }).reason, 'not-a-request');
  });

  it('(a5) ADJACENT, must not fire: "don\'t ask me", "don\'t wait", a suggestion, and "stop playing" (a pause request)', () => {
    for (const [s, tool] of [['Don\'t ask me, just click the first video', 'browser_click'], ['Can you play it? Don\'t wait for me.', 'browser_click'],
      ['Can you stop playing this song please', 'browser_click']]) {
      assert.deepEqual(trusted(s, tool), { proceed: true, reason: 'operator-request' }, s);
    }
    assert.equal(authority.prohibits('Why don\'t you play the next one?', 'browser_click'), false, '"why don\'t you" suggests');
  });
});

describe('F02 — the words must ask for what THIS call does', () => {
  it('(b1 repro) "Could you explain why this happens" authorises no click, type or key press', () => {
    for (const [tool, args] of [['browser_click', { ref: 'e1' }], ['browser_type', { text: 'why this happens' }], ['browser_press_key', { key: 'Enter' }]]) {
      assert.deepEqual(trusted('Could you explain why this happens', tool, args), { proceed: false, reason: 'not-this-action' }, tool);
    }
  });

  it('(b2 repro, vault) "Can you open Brave? Only Brave and open YouTube on it." does not close a window', () => {
    assert.deepEqual(trusted('Can you open Brave? Only Brave and open YouTube on it.', 'close_window', { pid: 1 }),
      { proceed: false, reason: 'not-this-action' });
    assert.equal(trusted('Can you just take a screenshot of my screen now?', 'see_and_click', { text: 'Play' }).reason, 'not-this-action');
  });

  it('(b3) a request for a different operation asks; an unknown tool or no tool asks', () => {
    assert.equal(trusted('Please type hello there for me', 'browser_click').reason, 'not-this-action');
    assert.equal(trusted('Can you close this tab now', 'browser_type', { text: 'x' }).reason, 'not-this-action');
    assert.equal(trusted('Can you click the button', 'mystery_tool').reason, 'unsupported-operation');
    assert.equal(trusted('Can you click the button', undefined).reason, 'unsupported-operation', 'no tool, nothing to match — fail safe');
  });

  it('(b4) typing the operator\'s own words for an on-screen request is asked for; other text, or no on-screen verb, is not', () => {
    const said = 'Can you play the GTA 6 extended trailer video?';
    assert.deepEqual(trusted(said, 'browser_type', { text: 'GTA 6 extended trailer' }), { proceed: true, reason: 'operator-request' });
    assert.equal(trusted(said, 'browser_type', { text: 'GTA 5 trailer' }).reason, 'not-this-action', 'a number they did not say');
    assert.equal(trusted(said, 'browser_type', { text: 'GTA 6 leaks reddit' }).reason, 'not-this-action', 'words they did not say');
    assert.equal(trusted('Could you explain why this happens', 'browser_type', { text: 'why this happens' }).reason, 'not-this-action');
  });

  it('(b5) -ing forms ask ("try playing"); a past tense reports ("I closed it")', () => {
    assert.equal(trusted('Can you try playing this video?', 'see_and_click', { text: 'Play' }).proceed, true);
    assert.equal(trusted('Try again. Try again. Try searching Mousumi.', 'ui_type', { text: 'Mousumi' }).proceed, true);
    assert.equal(trusted('I closed it already, can you open Brave', 'close_window').reason, 'not-this-action');
  });

  it('(b6) "go ahead" / "try again" carry the operator\'s PREVIOUS words\' operation — if recent, and if those pass', () => {
    const now = 'Yeah, yeah, go ahead. Don\'t ask me.';
    assert.deepEqual(trusted(now, 'browser_click', {}, { previous: 'Can you play the third video?', previousAgeMs: 20000 }),
      { proceed: true, reason: 'retry' });
    assert.equal(trusted(now, 'browser_click', {}, { previous: 'Can you play the third video?', previousAgeMs: 61000 }).reason, 'not-this-action');
    assert.equal(trusted(now, 'browser_click', {}, { previous: 'Could you explain this to me?', previousAgeMs: 5000 }).reason, 'not-this-action');
    assert.equal(trusted(now, 'browser_click', {}, { previous: 'Yep, can you play', previousAgeMs: 5000 }).reason, 'not-this-action',
      'the noise transcript is still too short to carry anything');
    assert.equal(trusted(now, 'browser_click').reason, 'not-this-action', 'with nothing before it, an approval approves nothing');
  });

  it('(b7) quoted and hypothetical requests are mentioned, not made', () => {
    assert.equal(trusted('He said "click the red button" to me earlier', 'browser_click').reason, 'not-a-request');
    assert.equal(trusted('What if I asked you to click it right now?', 'browser_click').reason, 'not-a-request');
    assert.equal(trusted('Can you click the button labelled "Subscribe" please', 'browser_click').proceed, true, 'a quote inside a real request');
  });

  it('(b8) BOUND, labelled: Bengali and Hindi commands ask — English lexical rules never authorise another language', () => {
    for (const s of ['তৃতীয় ভিডিওটা চালাও এখনই', 'तीसरा वीडियो चलाओ अभी', 'teesra video chalao please abhi']) {
      assert.equal(trusted(s, 'browser_click', {}, { typed: true }).proceed, false, s);
    }
    assert.equal(trusted('play the third video', 'browser_click', {}, { typed: true }).proceed, true, 'the English control');
  });
});

describe('F03 — a memory says only what the operator said', () => {
  it('(c1 repro) "Remember my favorite color is blue" does not authorise "…is green"', () => {
    assert.deepEqual(memory('Remember my favorite color is blue', 'My favorite color is green'), { proceed: false, reason: 'content-mismatch' });
    assert.deepEqual(memory('Remember my favorite color is blue', 'The operator\'s favorite color is blue.'), { proceed: true, reason: 'operator-request' });
  });

  it('(c2) an altered name, a dropped relationship, an added fact', () => {
    const said = 'Please remember that my sister\'s name is Priya';
    assert.equal(memory(said, 'The operator\'s sister\'s name is Riya.').reason, 'content-mismatch');
    assert.equal(memory(said, 'User\'s name is Priya.').reason, 'content-mismatch', 'about the operator now, not the sister');
    assert.equal(memory('Remember my favorite color is blue', 'Favorite color is blue and favorite food is pizza').reason, 'content-mismatch');
  });

  it('(c3) a negation dropped or added flips the fact', () => {
    assert.equal(memory('Please remember that I don\'t like coffee at all', 'User likes coffee.').reason, 'content-mismatch');
    assert.equal(memory('Please remember that I like coffee in the morning', 'User does not like coffee in the morning.').reason, 'content-mismatch');
    assert.equal(memory('Please remember that I don\'t like coffee at all', 'User does not like coffee at all.').proceed, true);
  });

  it('(c4) a translation or paraphrase is read back, not trusted; a small word ("at" for "in") counts', () => {
    assert.equal(memory('Please remember that amar priyo rong neel', 'Favorite color is blue').reason, 'content-mismatch');
    assert.equal(memory('Please remember to call mom in 5 minutes', 'Call mom at 5').reason, 'content-mismatch');
  });

  it('(c5) the model\'s "Current date:" suffix and today\'s month are allowed; another month is not', () => {
    assert.equal(memory('Please remember that my meeting is on Friday', 'Meeting on Friday. Current date: September 25, 2026.').proceed, true);
    assert.equal(memory('Please remember that my meeting is on Friday', 'Meeting on Friday in October.').reason, 'content-mismatch');
  });

  it('(c6) the typed/batch path takes the same rule: "green" for "blue" is read back', () => {
    const g = createTypedMemoryGate({ now: () => TODAY.getTime() });
    const held = g.hold({ tool: 'remember', args: { text: 'My favorite color is green' } }, 'Remember my favorite color is blue', 'conn-1');
    assert.ok(held.refuse && !held.consent);
    assert.match(held.refuse, /not what the operator said/);
  });
});

describe('F05 — a read-back carries every word, number and negation', () => {
  it('(d1 repro) "I will not remember…" is not a read-back of the thing it refuses', () => {
    assert.equal(words.readBackMatches('I will not remember your favorite color is blue', 'Your favorite color is blue'), false);
    assert.equal(words.readBackMatches('Shall I remember this: your favorite color is blue?', 'Your favorite color is blue'), true);
  });

  it('(d2 repro) a short word the old overlap could not see: "red" read back for "blue"', () => {
    // The old test counted words of four letters or more at 60%: favorite and
    // color matched, "red" was invisible, so this passed.
    assert.equal(words.readBackMatches('Shall I remember your favorite color is red?', 'Your favorite color is blue'), false);
  });

  it('(d3) a different number, an extra number, an omitted clause', () => {
    assert.equal(words.readBackMatches('Shall I remember: meeting at 6?', 'Meeting at 5'), false);
    assert.equal(words.readBackMatches('Shall I remember your meeting at 5 or 6?', 'Meeting at 5'), false);
    assert.equal(words.readBackMatches('Shall I remember that your sister is Priya?', 'Your sister Priya lives in Pune'), false);
  });

  it('(d4) BOUND: another script compares, but only an English question presents', () => {
    assert.equal(words.readBackMatches('আমার প্রিয় রং নীল', 'আমার প্রিয় রং নীল'), true, 'Unicode words are words');
    assert.equal(words.readBackMatches('আমার প্রিয় রং লাল', 'আমার প্রিয় রং নীল'), false);
  });
});

describe('ATTACKED 2026-09-25 — the guard above, broken on purpose before it shipped', () => {
  it('(k1) two spaces, commas, "never, ever" and capitals do not get a prohibition past', () => {
    // The first version of PROHIBITION_RE let the first three PROCEED: it wanted
    // single spaces and no punctuation between "do not" and the verb.
    for (const s of ['Please do  not click that button', 'Please do not ever, under any circumstances, click that',
      'Never, ever click that button please', 'PLEASE DO NOT CLICK THAT BUTTON']) {
      assert.equal(trusted(s, 'browser_click').reason, 'operator-prohibited', s);
    }
    assert.equal(trusted('Please don\'t worry about it, just click the first video', 'browser_click').proceed, true, 'ADJACENT');
  });

  it('(k2) the same words in another order are another fact: "I owe Ravi" is not "Ravi owes me"', () => {
    const said = 'Please remember that I owe Ravi 500 rupees';
    assert.equal(memory(said, 'Ravi owes me 500 rupees').reason, 'content-mismatch');
    assert.equal(memory(said, 'The operator owes Ravi 500 rupees').proceed, true, 'ADJACENT: same order');
    assert.equal(words.readBackMatches('Shall I remember that Ravi owes you 500 rupees?', 'User owes Ravi 500 rupees'), false,
      'a read-back with the roles swapped presents nothing — the first version said it did');
    assert.equal(words.readBackMatches('Shall I remember that you owe Ravi 500 rupees?', 'User owes Ravi 500 rupees'), true);
  });

  it('(k3) a name is named in any order; a stem never shrinks to one letter ("red" and "ring" stay apart)', () => {
    assert.equal(words.readBackMatches('Shall I play Never Gonna Give You Up by Rick Astley?', 'Rick Astley - Never Gonna Give',
      { numbers: 'subset', ordered: false }), true);
    assert.equal(words.readBackMatches('Shall I remember the ring?', 'The red one'), false);
  });
});

// ---- the real adapter, the real registry, the real dispatcher and store ----

function harness({ labels = {}, heard = { interrupts: 0, audioParts: 3 } } = {}) {
  const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 120000 } });
  const writes = []; const dispatched = []; const notices = [];
  const tools = buildTools({ semantic: { write: (topic, lines, opts) => { writes.push({ topic, lines, opts }); return { ref: 'sem-1' }; } }, fs: {} });
  const ctx = { bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } }, config: {},
    effectors: { invoke: (name, params, callCtx) => {
      const tool = tools.find((t) => t.name === name);
      return tool ? tool.fn(params, callCtx) : { ok: true, result: {} };
    } } };
  const verdictFor = (d) => (TIER_TABLE[d.tool] === 3
    ? { allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }
    : { allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' });
  const adapter = createLiveToolAdapter({
    leash: { check: verdictFor, confirm },
    dispatchAction: (decision, dctx) => { dispatched.push(decision); return dispatchAction(decision, { ...ctx, ...dctx }); },
    bus: { emit() {} }, logger: { warn() {}, info() {} }, connectionId: 'conn-s1',
    memory: { working: { tick: 1 }, episodic: { write() {} }, audit: { write() {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => notices.push(t) }),
    toolAckDeadlineMs: 500, describeBrowserRef: (ref) => labels[ref] || null,
  });
  let n = 0; let turn = 0;
  return {
    adapter, writes, dispatched, notices,
    async call(name, args, spoken) {
      let sent = null;
      await adapter.handleLiveToolCalls([{ id: 'fc-' + (++n), name, args }],
        { sendToolResponse: (r) => { sent = r; }, userTextSoFar: spoken || '', typedTextSoFar: '' });
      return sent && sent[0] ? sent[0].response : null;
    },
    async end(userText, assistantText, evidence) {
      const turnId = ++turn;
      adapter.onLiveTurnComplete({ userText: userText || '', assistantText: assistantText || '', turnId, typedText: '', ...(evidence || heard) });
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
      return turnId;
    },
  };
}

describe('F03 + F05 through the real adapter to the real store', () => {
  const BLUE = 'Remember my favorite color is blue';
  const GREEN = { text: 'My favorite color is green' };

  it('(s1 repro) "green" for "blue" writes nothing; it is read back exactly instead', async () => {
    const h = harness();
    const res = await h.call('remember', GREEN, BLUE);
    assert.equal(h.writes.length, 0, 'before S1: written at once, labelled voice-explicit');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /Shall I remember this: 'My favorite color is green'/);
  });

  it('(s2) a fresh, exact, heard confirmation of the proposed text saves it once — the operator heard "green"', async () => {
    const h = harness();
    await h.call('remember', GREEN, BLUE);
    await h.end(BLUE, 'Shall I remember this: "My favorite color is green"?');
    await h.end('Yes.', 'Saved.');
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].lines, [GREEN.text]);
    assert.deepEqual(h.writes[0].opts.sources, ['operator-approved']);
  });

  it('(s3 repro) a negated "read-back" presents nothing, so the yes saves nothing', async () => {
    const h = harness();
    await h.call('remember', { text: 'Your favorite color is blue' }, 'November');
    await h.end('November', 'Should I remember that? I will not remember your favorite color is blue.');
    await h.end('Yes.', 'Okay.');
    assert.equal(h.writes.length, 0);
  });

  it('(s4) a read-back the room did not hear in full presents nothing: cut, silent, or unreported', async () => {
    for (const evidence of [{ interrupts: 1, audioParts: 9 }, { interrupts: 0, audioParts: 0 }, {}]) {
      const h = harness();
      await h.call('remember', GREEN, BLUE);
      await h.end(BLUE, 'Shall I remember this: "My favorite color is green"?', evidence);
      await h.end('Yes.', 'Okay.');
      assert.equal(h.writes.length, 0, JSON.stringify(evidence));
    }
  });

  it('(s5) the HUD\'s cut report un-presents the read-back of THAT turn only', async () => {
    const h = harness();
    await h.call('remember', GREEN, BLUE);
    const readBackTurn = await h.end(BLUE, 'Shall I remember this: "My favorite color is green"?');
    assert.equal(h.adapter.onUnheard({ turnId: readBackTurn - 1, text: 'x' }), false, 'another turn\'s cut changes nothing');
    assert.equal(h.adapter.onUnheard({ turnId: readBackTurn, text: 'green' }), true);
    await h.end('Yes.', 'Okay.');
    assert.equal(h.writes.length, 0, 'a yes to half a question saves nothing');
  });
});

describe('F04 — a question must name the click\'s target', () => {
  const TITLE = 'Rick Astley - Never Gonna Give You Up (Official Music Video)';

  it('(e1) the browser snapshot names each ref, and forgets it when the page moves', async (t) => {
    const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');
    const agent = require('../adapters/browser-agent');
    const saved = { withPage: agent.withPage, getStatus: agent.getStatus, ensureOnline: agent.ensureOnline };
    t.after(() => { Object.assign(agent, saved); delete require.cache[FROM_BROWSER]; });
    agent.getStatus = () => ({ state: 'ONLINE', hint: null }); agent.ensureOnline = async () => {};
    const page = { url: () => 'https://www.youtube.com/', title: async () => 'YouTube', evaluate: async () => ({}),
      ariaSnapshot: async () => `- main [ref=e1]:\n  - link "${TITLE}" [ref=e12] [cursor=pointer]\n  - button "Subscribe" [ref=e13]` };
    agent.withPage = async (fn) => fn(page);
    delete require.cache[FROM_BROWSER];
    const fb = require(FROM_BROWSER);
    fb.__resetSnapshotStateForTest();
    assert.equal(fb.labelForRef('e12'), null, 'no snapshot yet, no name');
    const snap = await fb.browser_snapshot({});
    assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 300));
    assert.equal(fb.labelForRef('e12'), TITLE);
    assert.equal(fb.labelForRef('e99'), null);
    fb.__resetSnapshotStateForTest();
    assert.equal(fb.labelForRef('e12'), null, 'an invalidated generation names nothing');
  });

  it('(e2 repro) "Shall I play the other video instead?" presents nothing; naming it does, and the yes runs it once', async () => {
    const wrong = harness({ labels: { e12: TITLE } });
    const res = await wrong.call('browser_click', { ref: 'e12' }, 'Yep, can you play');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /Shall I click 'Rick Astley - Never Gonna Give'/, 'the model is told the words to say');
    await wrong.end('Yep, can you play', 'Shall I play the other video instead?');
    await wrong.end('Yes.', 'Okay.');
    assert.equal(wrong.dispatched.length, 0);
    const right = harness({ labels: { e12: TITLE } });
    await right.call('browser_click', { ref: 'e12' }, 'Yep, can you play');
    await right.end('Yep, can you play', 'Did you want me to play Rick Astley, Never Gonna Give You Up?');
    await right.end('Yes.', 'Okay.');
    assert.deepEqual(right.dispatched, [{ tool: 'browser_click', args: { ref: 'e12' } }]);
  });

  it('(e3) a key is named by itself or by what it does: "Shall I refresh the page?" puts F5 to the operator', async () => {
    for (const [question, runs] of [['Shall I refresh the page?', 1], ['Shall I press F5?', 1], ['Shall I press Enter?', 0]]) {
      const h = harness();
      await h.call('browser_press_key', { key: 'F5' }, 'refresh the page');
      await h.end('refresh the page', question);
      await h.end('Yes.', 'Done.');
      assert.equal(h.dispatched.length, runs, question);
    }
  });

  it('(e4) a click with nothing to name (coordinates) cannot be approved by a yes — the message says how to go on, and that route runs', async () => {
    const h = harness();
    const res = await h.call('click_at', { x: 834, y: 186 }, 'Yep, can you play');
    assert.equal(res.status, 'needs_operator_words');
    assert.match(res.message, /ask them to say in their own words what they want/);
    assert.match(res.message, /call click_at again and it runs/, 'refusal rule 1: the next step is in the message');
    await h.end('Yep, can you play', 'I was about to click the video. What would you like me to play?');
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0, 'a bare yes approves nothing it could not have heard named');
    await h.call('click_at', { x: 834, y: 186 }, 'Can you play the first video on the page please');
    assert.deepEqual(h.dispatched, [{ tool: 'click_at', args: { x: 834, y: 186 } }], 'the GOAL: their own words ran it, once');
  });
});

describe('S1 exit gate — through the REAL Live session', () => {
  class Sock extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
    send(j) { this.sent.push(JSON.parse(j)); }
    close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
    frame(f) { this.emit('message', Buffer.from(JSON.stringify(f))); }
  }
  const AUDIO = { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAAAAAA' } };

  async function wired(t) {
    const priorKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key';
    t.after(() => { if (priorKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = priorKey; });
    const h = harness();
    const sockets = [];
    const session = createLiveSession({
      config: {}, bus: { emit() {} }, logger: { warn() {}, info() {} }, spend: { recordCall() {} },
      breakers: { allow: () => true, fail() {}, success() {} }, systemInstruction: 't', functionDeclarations: [],
      onAudioOut() {}, onTranscript() {}, onState() {},
      onTurnComplete: (turn) => h.adapter.onLiveTurnComplete(turn),
      onToolCall: (calls, handlers) => h.adapter.handleLiveToolCalls(calls, handlers),
      createSocket: () => { const s = new Sock(); sockets.push(s); return s; },
    });
    const opened = session.open(); sockets[0].readyState = 1; sockets[0].emit('open'); sockets[0].frame({ setupComplete: {} }); await opened;
    t.after(() => session.close('test'));
    const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
    return { h, sock: sockets[0], settle };
  }

  it('(x1) "Please do not click that button" + a click call: zero dispatches', async (t) => {
    const { h, sock, settle } = await wired(t);
    sock.frame({ serverContent: { inputTranscription: { text: 'Please do not click that button' } } });
    sock.frame({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'browser_click', args: { ref: 'e5' } }] } });
    await settle();
    sock.frame({ serverContent: { turnComplete: true } });
    await settle();
    assert.equal(h.dispatched.length, 0);
  });

  it('(x2) an exact read-back Gemini cut, then "Yes.": zero writes; the same read-back heard in full: one write', async (t) => {
    for (const cut of [true, false]) {
      const { h, sock, settle } = await wired(t);
      sock.frame({ serverContent: { inputTranscription: { text: 'November' } } });
      sock.frame({ toolCall: { functionCalls: [{ id: 'fc-m', name: 'remember', args: { text: 'User likes lofi music' } }] } });
      await settle();
      sock.frame({ serverContent: { outputTranscription: { text: 'Shall I remember this: "User likes lofi music"?' }, modelTurn: { parts: [AUDIO] } } });
      if (cut) sock.frame({ serverContent: { interrupted: true } });
      sock.frame({ serverContent: { turnComplete: true } });
      await settle();
      sock.frame({ serverContent: { inputTranscription: { text: 'Yes.' } } });
      sock.frame({ serverContent: { turnComplete: true } });
      await settle();
      assert.equal(h.writes.length, cut ? 0 : 1, cut ? 'cut' : 'heard in full');
    }
  });
});

describe('derived sets, so the next tool or key cannot slip past', () => {
  it('(g4) every tool the real leash allows ONLY because a human is connected has an operation family', () => {
    const seen = new Set();
    const trustOn = makeLeash({});
    for (const tool of Object.keys(TIER_TABLE)) {
      const withHuman = trustOn.check({ tool, args: {} }, { connectionId: 'conn-1' });
      const without = trustOn.check({ tool, args: {} }, {});
      if (withHuman.allow && !without.allow && HUMAN_PREMISE_REASONS.has(withHuman.reason)) seen.add(tool);
    }
    const trustOff = makeLeash({ TRUSTED_TOOLS_DISABLED: true });
    for (const tool of Object.keys(TIER_TABLE)) {
      const id = trustOff.confirm.create('s', { decision: { tool, args: {} }, tier: 3 }, 'conn-1');
      trustOff.confirm.accept(id, 'conn-1');
      const v = trustOff.check({ tool, args: {} }, { connectionId: 'conn-1' });
      if (v.allow && v.reason === 'session-granted') seen.add(tool);
    }
    assert.ok(seen.size >= 10, `the derivation found ${seen.size} tools — it is broken, not proving anything`);
    const unmapped = [...seen].filter((tool) => !authority.TOOL_OPERATION[tool]);
    assert.deepEqual(unmapped, [], 'a gated tool with no family asks on every call; give it one in operator-authority.js');
  });

  it('(g5) every key the browser tool accepts has words for what it does', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-browser.js'), 'utf8');
    const list = (name) => {
      const m = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(src);
      assert.ok(m, name + ' not found in from-browser.js — the derivation is broken');
      return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    const keys = new Set([...list('ALLOWED_KEYS'), ...list('RELOAD_KEYS'), ...list('PLAYER_KEYS')]);
    assert.ok(keys.size >= 20, `found ${keys.size} keys`);
    assert.deepEqual([...keys].filter((k) => !authority.KEY_WORDS[k]), []);
    assert.deepEqual(Object.keys(authority.KEY_WORDS).filter((k) => !keys.has(k)), [], 'no words for a key the tool refuses');
  });
});

// MUTATION RECORD, run 2026-09-25.
// 1. NEGATIVE CONTROL: the seven changed runtime files put back as they are at
//    f456217d, this file run, the files restored and checked by sha256. 32 of
//    36 tests failed (the (k) block did not exist yet). 26 failed on their own
//    assertion — the old code gave the unsafe answer; 6 — (a4) (a5) (s5) (e1)
//    (g4) (g5) — failed because the seam they test did not exist. (d1)-(d4)
//    passed by construction: they test authority-words.js, which the old code
//    never called. Its predecessor, speechCovers(), returned TRUE for the (d1),
//    (d2) and (d3) "meeting at 6" read-backs, which is the defect.
// 2. PROBES on the new code, each applied, confirmed applied (marker present,
//    hash changed), run, restored and confirmed by sha256
//    (driver: .cache/s1/mutate.js, not tracked):
//    (m1) prohibits() returns false                   -> (a1) (a2) (a3) (a4) (k1) (x1) fail
//    (m2) namesOperation() always proceeds            -> (b1) (b2) (b3) (b4) (b5) (b6) (b8) fail
//    (m3) contentMismatch() returns false             -> (c1)-(c6) (k2) (s1) (s2) (s4) (s5) fail
//    (m4) readBackMatches() ignores negation          -> (d1) (s3) fail
//    (m5) heardInFull() returns true                  -> (s4) (x2) fail
//    (m6) onUnheard() returns before revoking         -> (s5) fails
//    (m7) targetLabel() names every click 'the video' -> (e2) (e4) fail
//    (m8) inOrder() returns true                      -> (k2) fails
//    (m9) plain() stops collapsing whitespace         -> (k1) fails
//    None survived. (b7) survives (m2) by design: quotes and hypotheticals are
//    refused by judgeWords() before the operation is ever matched.
