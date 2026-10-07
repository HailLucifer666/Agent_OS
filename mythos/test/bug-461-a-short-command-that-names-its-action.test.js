'use strict';

// BUG-461, B2c of the Stage 1 repair campaign (2026-09-26): a short spoken command
// whose own words name the action runs without asking, and "Yes, refresh the web
// page" is a yes.
//
// The operator's answer after the 09-25 sitting (campaign C1 row 8): short commands
// whose own words name the action run without asking. Rev 8 bounds it: only the
// matching operation AND argument, never a denial, a quote, a hypothetical, an
// unclear target or background noise. S1 held every spoken command of four words or
// fewer, so on 09-25 02:19:29 "refresh the page" was held and asked about, and the
// operator's answer, "Yes, refresh the web page", was dropped as other speech.
//
// Measured first, read-only (.cache/b2c/measure.js, every vault root, 2,286 live
// turns, 1,512 with operator words):
//   - 328 live utterances were four words or fewer, and 122 named an action word.
//     The only one that was noise AND reached a gated tool was the 09-24 "Yep, can
//     you play" (a yes-word, then a question with no object). Every real one starts
//     with its verb: "refresh the page", "Mute the volume.", "Scroll down a bit.",
//     "Pause the video.", "Mythos, pause the song.".
//   - Of 47 replies to MYTHOS's action questions that began with a yes-word, about
//     half approved and half did not: "Yeah, I heard two voices", "Okay. Moving on,
//     what's the price…", "Yes, first find the path and then try to open it".
//   - Bengali and Hindi: 23 of 1,915 transcripts, all 07-31 to 08-10, none since, and
//     none a short command to a click, type or key. The same Bengali words came back
//     in Bengali script, in Devanagari and in Latin letters, and English came back in
//     Devanagari once. So those still ask (C1 row 15), pinned in (l1).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const authority = require('../src/core/voice/operator-authority');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { createLiveSession } = require('../src/core/voice/live-session');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const F5 = { key: 'F5' };
const trusted = (current, tool, args, extra) => authority.judgeTrustedAction(Object.assign({ current, tool, args, previousAgeMs: NaN }, extra));
const proceeds = (current, tool, args, extra) => trusted(current, tool, args, extra).proceed;

describe('a short command that names its action and its argument runs', () => {
  it('(c1) REPLAY 09-25 02:19:29: "refresh the page" runs F5, and only F5', () => {
    assert.deepEqual(trusted('refresh the page', 'browser_press_key', F5), { proceed: true, reason: 'short-command' });
    // The words name refresh; a call that presses another key was not asked for.
    assert.equal(proceeds('refresh the page', 'browser_press_key', { key: 'PageDown' }), false);
    assert.equal(proceeds('refresh the page', 'browser_press_key', {}), false, 'no key named, nothing to match');
  });

  it('(c2) the operator\'s real short commands, each with the call it drove, run', () => {
    for (const [said, tool, args] of [
      ['Mute the volume.', 'browser_press_key', { key: 'm' }],          // 09-11 16:40:12
      ['Scroll down a bit.', 'browser_press_key', { key: 'PageDown' }], // 09-24 15:10:57
      ['Pause the video.', 'browser_press_key', { key: 'k' }],          // 08-07 15:18:50
      ['pause', 'browser_press_key', { key: 'k' }],
      ['Mythos, pause the song.', 'browser_press_key', { key: 'Space' }],
      ['Press enter.', 'browser_press_key', { key: 'Enter' }],
      ['scroll down', 'send_key', { key: 'pagedown' }],
      ['press page down', 'send_key', { key: 'pagedown' }],
    ]) {
      assert.deepEqual(trusted(said, tool, args), { proceed: true, reason: 'short-command' }, said);
    }
  });

  it('(c3) typing: a short command runs only when it dictates every word typed', () => {
    assert.equal(proceeds('search lofi music', 'browser_type', { ref: 'e3', text: 'lofi music' }), true);
    assert.equal(proceeds('type hello world', 'ui_type', { text: 'hello world' }), true);
    assert.equal(proceeds('type hello', 'ui_type', { text: 'hello there' }), false, '"there" was not said');
    assert.equal(proceeds('type the number', 'ui_type', { text: '42' }), false, 'a number was not said');
    assert.equal(proceeds('lofi music', 'browser_type', { ref: 'e3', text: 'lofi music' }), false, 'no verb: not a command');
  });

  it('(c4) MUST STILL ASK: the measured noise and the shapes around it', () => {
    // 09-24 15:11:13, the noise BUG-461 was filed for: a yes-word and a question.
    for (const args of [{ key: 'k' }, { key: 'Space' }]) assert.equal(proceeds('Yep, can you play', 'browser_press_key', args), false);
    assert.equal(proceeds('Yep, can you play', 'browser_click', { ref: 'f2e308' }), false);
    assert.equal(proceeds('can you pause', 'browser_press_key', { key: 'k' }), false, 'a question is not a command');
    // A yes-word opens a reply, not a command: with a proposal armed, the reply
    // path judges it; with none, it asks (one question, not a guess).
    assert.equal(proceeds('Yep, pause', 'browser_press_key', { key: 'k' }), false);
    // send_key acts on a desktop app, where Space and the player letters type a
    // character: "pause" does not name them there.
    assert.equal(proceeds('pause', 'send_key', { key: 'space' }), false);
    assert.equal(proceeds('pause', 'send_key', { key: 'k' }), false);
    // A key is named by a whole word: "center" does not say Enter.
    assert.equal(proceeds('press center', 'browser_press_key', { key: 'Enter' }), false);
    // Measured noise fragments and garbles, with the calls they could meet.
    for (const said of ['Obituary', 'sea', '2.0', 'isn\'t something?', 'Face scrolling down.', 'cross playback']) {
      assert.equal(proceeds(said, 'browser_press_key', { key: 'PageDown' }), false, said);
      assert.equal(proceeds(said, 'browser_press_key', { key: 'k' }), false, said);
    }
  });

  it('(c5) BOUND, pinned: a click and a window close still ask on short words — nothing binds the words to the target', () => {
    // browser_click acts on a ref, and a ref's label is a page's, not the operator's;
    // close_window acts on a pid. 08-10 03:26:39 "Close Slack" was followed by
    // "Sorry, I meant open anti-gravity": asking there was worth a second.
    assert.equal(trusted('Skip ad', 'browser_click', { ref: 'e9' }).reason, 'short-input');
    assert.equal(trusted('Pause the song.', 'browser_click', { ref: 'e1329' }).reason, 'short-input');
    assert.equal(trusted('Close Slack', 'close_window', { pid: 4120 }).reason, 'short-input');
    assert.equal(trusted('Close brief', 'close_window', { pid: 4120 }).reason, 'short-input');
    assert.equal(trusted('refresh the page', 'browser_click', { ref: 'e2' }).reason, 'short-input');
  });

  it('(c6) a denial, a prohibition, a quote or no tool still wins over a short command', () => {
    assert.equal(trusted("don't refresh", 'browser_press_key', F5).reason, 'operator-prohibited');
    assert.equal(trusted('never pause it', 'browser_press_key', { key: 'k' }).reason, 'operator-prohibited');
    assert.equal(trusted('I didn\'t say pause', 'browser_press_key', { key: 'k' }).reason, 'operator-objected');
    assert.equal(proceeds('"refresh the page"', 'browser_press_key', F5), false, 'quoted: mentioned, not made');
    assert.equal(proceeds('refresh the page', undefined, F5), false, 'no tool, nothing to match');
  });

  it('(c7) "further" carries a recent short command for the SAME call, once', () => {
    const down = { key: 'PageDown' };
    // 09-24 15:10:57 "Scroll down a bit.", then 15:11:06 "further".
    assert.deepEqual(trusted('further', 'browser_press_key', down, { previous: 'Scroll down a bit.', previousAgeMs: 9000 }),
      { proceed: true, reason: 'retry' });
    assert.equal(proceeds('further', 'browser_press_key', down, { previous: 'Scroll down a bit.', previousAgeMs: authority.CONTINUATION_WINDOW_MS + 1 }), false, 'stale');
    assert.equal(proceeds('further', 'browser_press_key', down, { previous: 'Mute the volume.', previousAgeMs: 9000 }), false, 'another action');
    assert.equal(proceeds('further', 'browser_press_key', down), false, 'nothing before it');
    assert.equal(proceeds('further', 'browser_press_key', down, { previous: 'further', previousAgeMs: 9000 }), false, 'one hop only');
    // Only the whole word carries on: "scroll further up" is a new direction.
    for (const said of ['scroll further up', 'scroll up further', 'further up']) {
      assert.equal(proceeds(said, 'browser_press_key', down, { previous: 'Scroll down a bit.', previousAgeMs: 9000 }), false, said);
    }
  });
});

describe('a yes that goes on is a yes only when the rest approves THIS call', () => {
  const rest = (s) => authority.yesAndRest(s);

  it('(y1) the rest after a clean leading yes, or null', () => {
    assert.equal(rest('Yes, refresh the web page'), 'refresh the web page');
    assert.equal(rest('Okay, refresh it.'), 'refresh it.');
    assert.equal(rest('refresh the web page'), null, 'no yes');
    assert.equal(rest('Yes.'), null, 'nothing after it');
  });

  it('(y2) a contrast, a sequence, a deferral, another target or a question makes it no yes at all', () => {
    for (const s of ["Okay. Moving on, what's the price of Nothing Phone (1) Pro in India?",
      'Yes, first find the path and then try to open it.', "Okay, but I didn't give you the link yet.",
      'Sure. I am playing a game. Can you tell me what game is this?', 'Yeah, next time ask before closing any window.',
      'Yes, press F5 on the other tab', 'Yes, scroll down instead', 'Yes, refresh it later', 'yes but not that one']) {
      assert.equal(rest(s), null, s);
    }
    // Without one, the rest is handed back to be judged on its own words; (r5)
    // shows it approves nothing when those words do not ask for the call.
    assert.equal(rest('Yeah, I heard two voices.'), 'I heard two voices.');
  });

  it('(y4) ATTACKED: a rest that forbids the action, or calls itself noise, names nothing', () => {
    // No "not" or "n't" in either, so only restNamesCall's own checks stand here.
    assert.equal(authority.restNamesCall('stop pressing page down', 'browser_press_key', { key: 'PageDown' }), false);
    assert.equal(authority.restNamesCall('press F5, that was background noise', 'browser_press_key', F5), false);
    assert.equal(authority.restNamesCall('press F5', 'browser_press_key', F5), true, 'adjacent: the plain restatement names it');
  });

  it('(y3) approval-only words are a whole yes now: "proceed", "approved", "try again"', () => {
    for (const s of ['Yes, proceed. Approved.', 'Yes, go ahead proceed.', 'Yeah, try again.', 'Proceed.', 'Approved.']) {
      assert.equal(authority.isAffirmativeReply(s), true, s);
    }
  });
});

// ---- the real adapter, the real confirm registry, the real dispatcher ----
function harness({ heard = { interrupts: 0, audioParts: 3 }, labels = {} } = {}) {
  const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 120000 } });
  const dispatched = [];
  const ctx = { bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } }, config: {},
    effectors: { invoke: () => ({ ok: true, result: {} }) } };
  const verdictFor = (d) => (TIER_TABLE[d.tool] === 3
    ? { allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }
    : { allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' });
  const adapter = createLiveToolAdapter({
    leash: { check: verdictFor, confirm },
    dispatchAction: (decision, dctx) => { dispatched.push(decision); return dispatchAction(decision, { ...ctx, ...dctx }); },
    bus: { emit() {} }, logger: { warn() {}, info() {} }, connectionId: 'conn-b2c',
    memory: { working: { tick: 1 }, episodic: { write() {} }, audit: { write() {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText() {} }), toolAckDeadlineMs: 500,
    describeBrowserRef: (ref) => labels[ref] || null,
  });
  let n = 0; let turn = 0;
  return {
    adapter, dispatched,
    async call(name, args, spoken) {
      let sent = null;
      await adapter.handleLiveToolCalls([{ id: 'fc-' + (++n), name, args }],
        { sendToolResponse: (r) => { sent = r; }, userTextSoFar: spoken || '', typedTextSoFar: '' });
      return sent && sent[0] ? sent[0].response : null;
    },
    async end(userText, assistantText) {
      adapter.onLiveTurnComplete({ userText, assistantText, turnId: ++turn, typedText: '', ...heard });
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

// The real 09-25 question, and the call it proposed.
const ASKED_0219 = 'Shall I press F5 to refresh the page, Sir?';
async function presentedF5(h) {
  const res = await h.call('browser_press_key', F5, 'Can you see the page?');
  assert.equal(res.status, 'needs_operator_yes', 'the call is held: the words do not ask for it');
  await h.end('Can you see the page?', ASKED_0219);
  assert.equal(h.dispatched.length, 0);
}

describe('through the real adapter', () => {
  it('(r1) REPLAY 09-25 02:19:42, as said: "Yes, refresh the web page" runs the proposed F5 once', async () => {
    const h = harness();
    await presentedF5(h);
    await h.end('Yes, refresh the web page', 'Refreshing it now.');
    assert.equal(h.dispatched.length, 1);
    assert.deepEqual(h.dispatched[0].args, F5);
  });

  it('(r2) the same yes through the re-issue route: one dispatch, the proposal consumed', async () => {
    const h = harness();
    await presentedF5(h);
    const res = await h.call('browser_press_key', F5, 'Yes, refresh the web page');
    assert.ok(!res || !/^(?:needs_operator_yes|waiting_for_operator)$/.test(res.status), JSON.stringify(res));
    assert.equal(h.dispatched.length, 1, 'the re-issued call itself ran');
    await h.end('Yes, refresh the web page', 'Done.');
    assert.equal(h.dispatched.length, 1, 'and the turn\'s end did not run it a second time');
  });

  it('(r3) BOUND, pinned: as transcribed, "Yes, we face the web page." is not a yes, and nothing runs', async () => {
    // The transcriber turned "refresh" into "we face". Nothing in the words tells
    // that apart from "Yeah, I heard two voices"; the proposal is dropped (WAVE 8).
    const h = harness();
    await presentedF5(h);
    await h.end('Yes, we face the web page.', 'F5 it is then.');
    assert.equal(h.dispatched.length, 0);
  });

  it('(r4) a yes that names another key, or another tab, approves nothing', async () => {
    for (const said of ['Yes, press page down', 'Yes, refresh the other tab']) {
      const h = harness();
      await presentedF5(h);
      await h.end(said, 'Okay.');
      assert.equal(h.dispatched.length, 0, said);
    }
  });

  it('(r5) MUST NOT approve: every measured yes-word reply that went on to something else, through the adapter', async () => {
    for (const said of ['Yeah, I heard two voices.', "Okay. Moving on, what's the price of Nothing Phone (1) Pro in India?",
      'Yes, first find the path and then try to open it.', "Okay, but I didn't give you the link yet.",
      'Sure. I am playing a game. Can you tell me what game is this?', 'Yeah, next time ask before closing any window.',
      'Yes, so can you book an appointment tomorrow for vet around 4:00 p.m.?', 'Yeah, take a look at the screenshot more closely.']) {
      const h = harness();
      await presentedF5(h);
      await h.end(said, 'Okay.');
      assert.equal(h.dispatched.length, 0, said);
    }
  });

  it('(r6) ATTACKED 2026-09-26: "Yes, please play the third video for me" does not approve a click on the video MYTHOS named', async () => {
    // A rest that names a click is not matched to the page's label, so it approves
    // nothing, even when it names the same video. A whole yes still approves it.
    const CAFE = 'Café Ambience ☕ Relaxing Jazz Music for Work and Study';
    for (const [said, runs] of [['Yes, please play the third video for me', 0], ['Yes, click Café Ambience', 0], ['Yes.', 1]]) {
      const h = harness({ labels: { f2e308: CAFE } });
      const res = await h.call('browser_click', { ref: 'f2e308' }, 'What are the results?');
      assert.equal(res.status, 'needs_operator_yes');
      await h.end('What are the results?', 'Shall I click \'Café Ambience ☕ Relaxing Jazz Music\'?');
      await h.end(said, 'Okay.');
      assert.equal(h.dispatched.length, runs, said);
    }
  });

  it('(r7) a memory proposal: a yes that restates the exact words approves; one that changes them does not', async () => {
    const GREEN = { text: 'My favorite color is green' };
    for (const [said, runs] of [['Yes, remember my favorite color is green', 1], ['Yes, remember my favorite color is blue', 0]]) {
      const h = harness();
      const res = await h.call('remember', GREEN, 'Remember my favorite color is blue');
      assert.equal(res.status, 'needs_operator_yes');
      await h.end('Remember my favorite color is blue', 'Shall I remember this: "My favorite color is green"?');
      await h.end(said, 'Okay.');
      assert.equal(h.dispatched.length, runs, said);
      if (runs) assert.deepEqual(h.dispatched[0].args, GREEN, 'the stored call runs, not a new one');
    }
  });

  it('(l1) BOUND, pinned: a Bengali or Hindi reply never approves, and a Bengali "no" still cancels', async () => {
    // Measured shapes: 08-10 15:26:19 "हां, बोलो। बोलो ना।" (Hindi "yes, speak"),
    // 08-02 06:24:20 "না না না" (Bengali "no no no"), 07-31 05:52:16 English in
    // Devanagari, "कैन यू जस्ट प्रेस द प्ले बटन?" ("Can you just press the play button?").
    for (const said of ['हां, बोलो। बोलो ना।', 'হ্যাঁ, রিফ্রেশ করো', 'না না না', 'कैन यू जस्ट प्रेस द प्ले बटन?']) {
      const h = harness();
      await presentedF5(h);
      await h.end(said, 'Okay.');
      assert.equal(h.dispatched.length, 0, said);
      await h.end('Yes.', 'Okay.');
      assert.equal(h.dispatched.length, 0, said + ' then "Yes.": the proposal was dropped, so a later yes runs nothing');
    }
    assert.equal(proceeds('कैन यू जस्ट प्रेस द प्ले बटन?', 'browser_press_key', { key: 'k' }), false);
    assert.equal(proceeds('বন্ধ করো', 'browser_press_key', { key: 'k' }), false);
  });
});

describe('through the REAL Live session', () => {
  class Sock extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
    send(j) { this.sent.push(JSON.parse(j)); }
    close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
    frame(f) { this.emit('message', Buffer.from(JSON.stringify(f))); }
  }

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

  it('(x1) spoken "refresh the page" + an F5 call: one dispatch; the 09-24 noise + a play key: none', async (t) => {
    for (const [said, args, want] of [['refresh the page', F5, 1], ['Yep, can you play', { key: 'k' }, 0]]) {
      const { h, sock, settle } = await wired(t);
      sock.frame({ serverContent: { inputTranscription: { text: said } } });
      sock.frame({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'browser_press_key', args }] } });
      await settle();
      sock.frame({ serverContent: { turnComplete: true } });
      await settle();
      assert.equal(h.dispatched.length, want, said);
    }
  });
});

// PROOF RECORD, run 2026-09-26 (driver: .cache/b2c/mutate.js, not tracked).
// 1. NEGATIVE CONTROL: operator-authority.js and authority-gate.js put back as they
//    are at S1 (f819adac), this file run, both restored and checked by sha256.
//    12 of 20 tests failed: (c1) (c2) (c3) (c7) (r1) (r2) (r7) (x1) on their own
//    assertion — S1 held every short command and took only a whole yes — and (y1)
//    to (y4) because yesAndRest/restNamesCall did not exist yet. The other 8 pass on
//    both by design: (c4) (c5) (c6) (r3) (r4) (r5) (r6) (l1) are the cases that
//    must still ask, and S1 asked on them too.
// 2. PROBES on the new code, each applied once, confirmed applied (hash changed),
//    run against a green baseline, restored from a byte copy and checked by sha256:
//    (m1)  shortCommandNames() always true          -> c1 c3 c4 c5 c6 c7 r3-r6 l1 x1
//    (m2)  a yes-word may lead a command            -> c4
//    (m3)  no verb-first check                      -> c4 x1
//    (m4)  a key named only by its own name         -> c1 c2 c7 r1 r2 x1
//    (m5)  send_key Space takes the player words    -> c4
//    (m6)  typing need not dictate its words        -> c3
//    (m7)  typing need not dictate its numbers      -> c3
//    (m8)  "further" carries any recent words       -> c7
//    (m9)  "further" carries nothing                -> c7
//    (m10) a short command matched by family only   -> c1 c2
//    (m11) a contrast or question keeps the yes     -> y2 r4
//    (m12) a rest judged like fresh words           -> r6 (the rule before the 2026-09-26 attack)
//    (m13) only a whole yes approves                -> r1 r2 r7
//    (m14) a memory rest matched as a key or typing -> r7
//    (m15) the re-issue route takes a whole yes only-> r2
//    (m16) the reply route takes a whole yes only   -> r1 r7
//    (m17) "proceed", "approved" not a yes          -> y3
//    (m18) restNamesCall without prohibits()        -> y4
//    (m19) restNamesCall without the denial check   -> y4
//    (m20) every short command asks (S1)            -> c1 c2 c3 c7 x1
//    (m21) a key name inside another word           -> c4
//    (m22) CONTINUE_RE not anchored at the start    -> c7
//    (m23) CONTINUE_RE not anchored at the end      -> c7
//    None survived. Two earlier runs left three survivors between them, each a weak test, fixed:
//    (r2) passed on the turn-end route when the re-issue route was broken (m15), and
//    (c7) had no "... further" or "further ..." case (m22, m23).
