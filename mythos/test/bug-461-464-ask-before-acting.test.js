'use strict';

// BUG-461 + BUG-464 (plan Wave 2, consent) — MYTHOS acts on what the operator
// SAID, and asks first when the words do not ask.
//
// REPLAYED FIRST, 2026-09-24, every Live call in Episodic (13 days, 889 turns):
//   - 98 clicks, types and key presses the leash allowed with no confirm because
//     a human was connected (operator-present-trusted). Two ran in a turn whose
//     own words objected: 09-24 15:11:24 "I didn't say anything. I didn't say
//     anything. It's the background noise." and 09-23 14:05:39 "I didn't ask you
//     to play that video." The ticket blamed the four-word noise transcript
//     "Yep, can you play" (15:11:13); the vault shows that turn only took a
//     snapshot — the click came one turn later, carrying out the noise's request
//     under the operator's objection. With these rules: 61 proceed, 37 ask.
//   - 10 remember calls. 3 said "remember"/"keep it in memory"; 3 were standing
//     instructions ("next time …"); 2 were plainly unrequested ("November"
//     09-24 14:53:44; "Can you set this for now?" 09-10); 2 were ambiguous
//     (09-02). With these rules the 6 requested proceed and the other 4 ask. The
//     saved text is kept to 90 characters in the vault, and word overlap could
//     not tell requested from unrequested (0.29 against 0.33), so no overlap test.
//
// Mutation probes and their dated results: BUGS.md BUG-461 and BUG-464 Proof
// paragraphs, and the commit that added this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const authority = require('../src/core/voice/operator-authority');
const { createAuthorityGate, createTypedMemoryGate, HUMAN_PREMISE_REASONS, MEMORY_TOOLS } = require('../src/core/voice/authority-gate');
const { mintConsent, verifyConsent } = require('../src/core/leash/consent');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { buildTools } = require('../src/core/effectors/from-memory');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { makeLeash } = require('./helpers/leash-fixture');

const TODAY = new Date(2026, 8, 24);
// Verbatim from Episodic (the operator's words; the 15:11 lines are already in BUGS.md).
const OBJECTION_0924 = "I didn't say anything. I didn't say anything. It's the background noise. We'll have to fix it, log it.";
const OBJECTION_0923 = "you No, I did I ask you to play that video? I didn't ask you to play that video.";
const NOISE_0924 = 'Yep, can you play';
const TV_AUDIO_0911 = 'in times to come there are many questions but then it all depends on peace and tranquility along the line of actual control';
const REQUESTED_1455 = "Yeah, but I want you to you know the be in a way where if I tell you I'm not keeping well. One day and next time you come talk to me we talk to each other. You should ask me that if I was. Keeping well if I'm feeling better now.";
const DECLINED_1455 = "And about remembering my illness, rather I'm not keeping well. You don't have to remember that. I was just testing that if you remember the conversation from yesterday.";
const SAID_NOVEMBER = "Got it. I'll keep in mind that you haven't been feeling well and need to rest. Still, are you feeling like you're on the mend?";
const NOVEMBER_TEXT = 'User has not been feeling well and needs to rest. Current date: September 24, 2026.';

const trusted = (input) => authority.judgeTrustedAction(Object.assign({ previousAgeMs: NaN }, input));
const memory = (input) => authority.judgeMemoryWrite(Object.assign({ today: TODAY, text: 'something to keep' }, input));

describe('BUG-461 — the operator\'s words decide whether a trusted click, type or key runs', () => {
  it('(t1) REPLAY 09-24 15:11:24: a click in a turn that objects is held, whatever its length', () => {
    assert.deepEqual(trusted({ current: OBJECTION_0924 }), { proceed: false, reason: 'operator-objected' });
    assert.deepEqual(trusted({ current: OBJECTION_0923 }), { proceed: false, reason: 'operator-objected' });
    assert.ok(authority.countWords(OBJECTION_0924) > authority.SHORT_INPUT_MAX_WORDS, 'the word count alone would have let it through');
  });

  it('(t1b) an objection that comes WITH a new request is still held — the only case the objection rule decides alone', () => {
    // Both measured objections are also caught by (t3)'s not-a-request rule; this
    // one carries a request form, so only the objection stands between it and a click.
    assert.deepEqual(trusted({ current: "I didn't ask you to play that one. Can you play the second video instead?" }),
      { proceed: false, reason: 'operator-objected' });
  });

  it('(t2) the four-word noise transcript is held — the case a three-word threshold misses', () => {
    assert.deepEqual(trusted({ current: NOISE_0924 }), { proceed: false, reason: 'short-input' });
    assert.equal(authority.countWords(NOISE_0924), 4);
  });

  it('(t3) a longer transcript that is not a request is held (09-11: a news video\'s own audio)', () => {
    assert.deepEqual(trusted({ current: TV_AUDIO_0911 }), { proceed: false, reason: 'not-a-request' });
  });

  it('(t4) missing and stale words: nothing heard, or last heard too long ago, is held; a recent request carries on', () => {
    assert.deepEqual(trusted({ current: '' }), { proceed: false, reason: 'no-operator-words' });
    const w = authority.CONTINUATION_WINDOW_MS;
    assert.equal(trusted({ current: '', previous: 'Can you play the third video?', previousAgeMs: 20000, tool: 'browser_click' }).proceed, true);
    assert.deepEqual(trusted({ current: '', previous: 'Can you play the third video?', previousAgeMs: w + 1, tool: 'browser_click' }), { proceed: false, reason: 'no-operator-words' });
    // A turn MYTHOS started itself inherits the last words' JUDGEMENT, never a pass.
    assert.deepEqual(trusted({ current: '', previous: NOISE_0924, previousAgeMs: 5000 }), { proceed: false, reason: 'short-input-before' });
  });

  it('(t5) BOUND, pinned: real short commands are asked about too — the operator chose "ask first"', () => {
    for (const s of ['further', 'Mute the volume.', 'Close brief', 'pause', 'Scroll down a bit.']) {
      assert.equal(trusted({ current: s }).proceed, false, s);
    }
    // "pause" gets no exemption: nothing on this path can see the player, and a
    // toggle key on a misheard word is how noise toggled the video on 09-11.
  });

  it('(t6) ADJACENT, must proceed: the operator\'s real requests from the replay, each with the tool it drove', () => {
    // S1 (2026-09-25): the check now needs the call's tool, because a request
    // must name what THAT call does (F02). The tools are the vault's own: the
    // replay in the S1 commit paired each line with the call it drove. The sixth
    // line used to be "Yeah, yeah, go ahead. Don't ask me." — an approval with no
    // operation of its own; it is judged by the words before it now, pinned in
    // test/bug-461-464-authority-binds-operation-and-content.test.js (b6).
    for (const [s, tool] of [['Can you play the third video?', 'browser_click'],
      ['Yeah, okay. Can you just play the the first trailer?', 'browser_click'],
      ['Why dashboard? I asked you to play it on YouTube. On the Brave browser, you have it open.', 'browser_click'],
      ['Can you try to scroll down on that thread?', 'ui_click'], ['I mean close video player.', 'close_window']]) {
      assert.deepEqual(trusted({ current: s, tool }), { proceed: true, reason: 'operator-request' }, s);
    }
  });

  it('(t7) typed words cannot be noise: a typed short command runs, a typed objection still holds', () => {
    assert.equal(trusted({ current: 'pause', typed: true, tool: 'browser_click' }).proceed, true);
    assert.equal(trusted({ current: 'I did not ask you to open that.', typed: true, tool: 'browser_click' }).proceed, false);
  });

  it('(t8) a yes is a whole-utterance yes — "Yep, can you play" is not one', () => {
    for (const s of ['Yes.', 'Yes, yes, go ahead.', 'Sure, remember that.', 'Okay.', 'Yes please']) assert.equal(authority.isAffirmativeReply(s), true, s);
    for (const s of [NOISE_0924, 'yes but not that one', 'no', '', 'Yes. Also open Spotify.', 'Right.']) assert.equal(authority.isAffirmativeReply(s), false, s);
  });

  it('(t10) ATTACK: a typographic apostrophe is the same objection ("didn’t" from a phone keyboard)', () => {
    assert.equal(trusted({ current: 'I didn’t ask you to play that one. Can you play the second video instead?' }).reason, 'operator-objected');
    assert.equal(memory({ current: 'You don’t have to remember that, I was only testing you.' }).reason, 'operator-declined');
  });

  it('(t9) BOUND, pinned: the rules are English lexical proxies — a clear command in another language asks', () => {
    // Until S1 (2026-09-25) the first line PROCEEDED: "please" was the only English
    // word in it, and a request form was all the check looked for. It now asks,
    // because nothing in it names a click. Both still ask; neither is understood.
    assert.deepEqual(trusted({ current: 'teesra video chalao abhi turant please mere liye', tool: 'browser_click' }),
      { proceed: false, reason: 'not-this-action' });
    assert.equal(trusted({ current: 'teesra video chalao abhi turant mere liye', tool: 'browser_click' }).proceed, false);
  });
});

describe('BUG-464 — a permanent memory is written only when the operator asks', () => {
  it('(m1) REPLAY 14:53:44: "November" after "not keeping well" asks nothing — held', () => {
    assert.deepEqual(memory({ current: 'November', previous: 'not keeping well', previousAgeMs: 8000, text: NOVEMBER_TEXT }), { proceed: false, reason: 'not-requested' });
  });

  it('(m2) negation: the operator\'s own 14:55:27 line, and its neighbours', () => {
    assert.deepEqual(memory({ current: DECLINED_1455 }), { proceed: false, reason: 'operator-declined' });
    assert.equal(memory({ current: 'There is no need to remember that part of it, honestly.' }).reason, 'operator-declined');
    assert.equal(memory({ current: 'Please remember this, and then forget that other thing.' }).reason, 'operator-declined', 'a retraction anywhere wins');
  });

  it('(m3) quotation, hypothesis and incidental mentions are not requests', () => {
    for (const s of ['If I say remember my birthday, will you actually do it?', 'I remember when we went to Goa last year together',
      'Can you remember what I told you yesterday about the meeting?', 'The word "remember" keeps showing up in my notes today']) {
      assert.equal(memory({ current: s }).proceed, false, s);
    }
    // These two carry a form that WOULD count as an ask on its own — only the
    // hypothetical and quoted rules stand between them and a write.
    assert.equal(authority.findMemoryRequest('What if I said, remember my birthday is in May, would you save it?').explicit, true);
    assert.equal(memory({ current: 'What if I said, remember my birthday is in May, would you save it?' }).reason, 'not-requested');
    assert.equal(memory({ current: 'My sister wrote "Please remember the milk tomorrow" on the fridge again.' }).reason, 'not-requested');
  });

  it('(m4) ADJACENT, must proceed: the requested 14:55:56 save, and the explicit forms', () => {
    // S1 (2026-09-25, F03): the text saved must now say only what the operator
    // said, so each ask carries the text a model would save from it. Until then
    // every one of these proceeded with the placeholder 'something to keep' — any
    // text at all. A paraphrase of the same asks is a read-back now (the new file).
    assert.deepEqual(memory({ current: REQUESTED_1455,
      text: 'If I tell you I\'m not keeping well, next time you should ask me if I\'m feeling better.' }),
    { proceed: true, reason: 'operator-request' });
    for (const [s, text] of [
      ['Keep it in memory. Remember this, do not remind me of Gmail until the token is refreshed.',
        'Do not remind the operator of Gmail until the token is refreshed.'],
      ['Please remember that my sister\'s name is Priya', 'The operator\'s sister\'s name is Priya.'],
      ['So, next time don\'t say closing it, just close it.', 'Next time, don\'t say closing it, just close it.'],
      ['Don\'t forget that my meeting is on Friday morning', 'The operator\'s meeting is on Friday morning.'],
      ['From now on, always open links in the debug browser.', 'Always open links in the debug browser.']]) {
      assert.equal(memory({ current: s, text }).proceed, true, s);
    }
    // 09-10 turn 42: the ask was the previous turn; the call landed in an empty one.
    assert.equal(memory({ current: '', previous: 'Always remember when I ask you to open browser you open the debug browser', previousAgeMs: 3000,
      text: 'When the operator asks to open a browser, open the debug browser.' }).proceed, true);
  });

  it('(m5) an explicit ask with no content ("remember that") is a read-back, not a write', () => {
    assert.deepEqual(memory({ current: 'Yes, remember that.' }), { proceed: false, reason: 'bare-referent' });
  });

  it('(m6) a number the operator never said is a read-back; today\'s date is not', () => {
    assert.deepEqual(memory({ current: 'Please remember that my meeting is on Friday', text: 'Meeting on Friday at 5 pm' }), { proceed: false, reason: 'unsupported-number' });
    assert.equal(memory({ current: 'Please remember that my meeting is on Friday', text: 'Meeting Friday. Current date: September 24, 2026.' }).proceed, true);
    assert.equal(memory({ current: 'Please remember my PIN hint is 4471 for the locker', text: 'PIN hint 4471 (locker)' }).proceed, true);
  });

  it('(m7) "Can you set this for now?" (09-10) asked for a persona, not a permanent memory', () => {
    assert.equal(memory({ current: 'Yeah, I like this persona. Can you set this for now?' }).proceed, false);
  });
});

describe('the lock — remember writes nothing without a server-minted consent for exactly this call', () => {
  function rememberTool() {
    const writes = [];
    const tools = buildTools({ semantic: { write: (topic, lines, opts) => { writes.push({ topic, lines, opts }); return { ref: 'sem-1' }; } }, fs: {} });
    return { remember: tools.find((t) => t.name === 'remember'), writes };
  }
  const args = { text: 'The operator prefers dark mode everywhere.' };

  it('(l1) no consent: refused, and semantic.write is never called', async () => {
    const { remember, writes } = rememberTool();
    const r = await remember.fn(args, {});
    assert.equal(r.ok, false);
    assert.match(r.result.error, /no-consent/);
    assert.equal(writes.length, 0, 'the mechanism, not the return value: nothing reached the store');
  });

  it('(l2) a forged consent — the same fields as a plain object, or a key in the ARGUMENTS — is refused', async () => {
    const { remember, writes } = rememberTool();
    const real = mintConsent({ tool: 'remember', args, basis: 'operator-request' });
    const forged = JSON.parse(JSON.stringify(real));
    assert.equal((await remember.fn(args, { consent: forged })).ok, false);
    // A token in the ARGUMENTS can never pass, by construction: it is bound to the
    // exact arguments, and arguments that contain the token are not the ones it
    // was minted for. (Mutation p15, reading consent from args as well, survives
    // for exactly this reason — recorded, not hidden.)
    const withKey = { ...args, consent: real };
    assert.equal((await remember.fn(withKey, { consent: real })).ok, false, 'a token cannot sign the arguments that carry it');
    assert.equal((await remember.fn(withKey, {})).ok, false, 'the model writes args; consent is read only from the context');
    assert.equal(writes.length, 0);
  });

  it('(l3) consent is for ONE call: other text, a second use, or an old token are refused', async () => {
    const { remember, writes } = rememberTool();
    const token = mintConsent({ tool: 'remember', args, basis: 'operator-request' });
    assert.equal((await remember.fn({ text: 'The operator prefers light mode everywhere.' }, { consent: token })).ok, false);
    const fresh = mintConsent({ tool: 'remember', args, basis: 'operator-request' });
    assert.equal((await remember.fn(args, { consent: fresh })).ok, true);
    assert.equal((await remember.fn(args, { consent: fresh })).ok, false, 'single use');
    const old = mintConsent({ tool: 'remember', args, basis: 'operator-request', now: Date.now() - 31000 });
    assert.equal(verifyConsent(old, 'remember', args).reason, 'consent-expired');
    assert.equal(writes.length, 1);
  });

  it('(l4) the label says which consent it was — it used to say voice-explicit for everything', async () => {
    const { remember, writes } = rememberTool();
    await remember.fn(args, { consent: mintConsent({ tool: 'remember', args, basis: 'operator-request' }) });
    await remember.fn(args, { consent: mintConsent({ tool: 'remember', args, basis: 'approved-proposal' }) });
    assert.deepEqual(writes.map((w) => w.opts.sources), [['voice-explicit'], ['operator-approved']]);
  });

  it('(l5) the shared dispatcher carries the consent to the tool (hop 3 of 3), and never invents one', async () => {
    const { remember, writes } = rememberTool();
    const ctx = { bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } }, config: {},
      effectors: { invoke: (name, params, callCtx) => remember.fn(params, callCtx) } };
    const consent = mintConsent({ tool: 'remember', args, basis: 'operator-request' });
    assert.equal((await dispatchAction({ tool: 'remember', args }, { ...ctx, tier: 0, channel: 'voice-live', consent })).ok, true);
    assert.equal((await dispatchAction({ tool: 'remember', args }, { ...ctx, tier: 0, channel: 'cortex' })).ok, false,
      'the autonomous loop has no operator words, so it cannot write permanent memory');
    assert.equal(writes.length, 1);
  });

  it('(l6) hop 2 of 3: the server\'s dispatch wrapper forwards consent (it passes only the fields it names)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const body = src.slice(src.indexOf('async function dispatchAction(decision, ctx) {'));
    const wrapper = body.slice(0, body.indexOf('\n  }'));
    assert.ok(wrapper.length > 100, 'wrapper not found — this guard must fail loudly, not pass on nothing');
    assert.match(wrapper, /consent: ctx\.consent/);
  });
});

describe('the approval registry — a spoken yes needs a spoken proposal, from the same connection, once', () => {
  const registry = () => createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 60000 } });
  const action = { decision: { tool: 'browser_click', args: { ref: 'f2e308' } }, tier: 3 };

  it('(r1) a refused call alone is not approvable: acceptSpoken before markPresented is null', () => {
    const c = registry(); const id = c.create('s', action, 'conn-1', { spoken: true });
    assert.equal(c.acceptSpoken(id, 'conn-1'), null);
    assert.ok(c.peek(id), 'and a premature yes does not consume it');
  });

  it('(r2) presented, then accepted once', () => {
    const c = registry(); const id = c.create('s', action, 'conn-1', { spoken: true });
    assert.equal(c.markPresented(id, 'conn-1'), true);
    assert.deepEqual(c.acceptSpoken(id, 'conn-1'), action);
    assert.equal(c.acceptSpoken(id, 'conn-1'), null, 'single use');
  });

  it('(r3) another connection can neither present nor accept it, and cannot use it up', () => {
    const c = registry(); const id = c.create('s', action, 'conn-1', { spoken: true });
    assert.equal(c.markPresented(id, 'conn-2'), false);
    c.markPresented(id, 'conn-1');
    assert.equal(c.acceptSpoken(id, 'conn-2'), null);
    assert.deepEqual(c.acceptSpoken(id, 'conn-1'), action, 'the owner still can');
  });

  it('(r4) a click confirm is never voice-approvable; an unscoped entry never is either', () => {
    const c = registry();
    const click = c.create('s', action, 'conn-1');
    assert.equal(c.markPresented(click, 'conn-1'), false);
    assert.equal(c.acceptSpoken(click, 'conn-1'), null);
    const unscoped = c.create('s', action, null, { spoken: true });
    assert.equal(c.markPresented(unscoped, null), false);
  });

  it('(r5) a spoken entry\'s TTL can only shorten, and an expired one is never approved', async () => {
    const c = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 40 } });
    const id = c.create('s', action, 'conn-1', { spoken: true, ttlMs: 60000 });
    c.markPresented(id, 'conn-1');
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(c.acceptSpoken(id, 'conn-1'), null);
  });

  it('(r6) a spoken approval grants nothing further — no session grant, unlike a click accept', () => {
    const leash = makeLeash({ TRUSTED_TOOLS_DISABLED: true });
    const id = leash.confirm.create('s', { decision: { tool: 'browser_click', args: {} }, tier: 3 }, 'conn-1', { spoken: true });
    leash.confirm.markPresented(id, 'conn-1');
    assert.ok(leash.confirm.acceptSpoken(id, 'conn-1'));
    assert.equal(leash.check({ tool: 'browser_click', args: {} }, { connectionId: 'conn-1' }).requireConfirm, true,
      'with trust off, the next click still needs its own approval');
  });
});

// Through the REAL Live adapter and the REAL registry — the second route to the
// same answers as the pure tests above.
const verdictFor = (d) => (TIER_TABLE[d.tool] === 3
  ? { allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }
  : { allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' });

// S1 (2026-09-25): the wire now says whether a reply was heard in full (live-
// session.js puts interrupts and audioParts on every turn) and the browser
// effector names the element behind a ref. `heard` and `labels` model both; a
// test that needs a cut or a nameless ref passes its own.
const HEARD = { interrupts: 0, audioParts: 3 };
function live({ outcome, check, ttlMs = 120000, dispatch, heard = HEARD, labels = { f2e308: 'Café Ambience' } } = {}) {
  const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: ttlMs } });
  const dispatched = []; const notices = []; const anomalies = []; const audits = [];
  const leash = { check: check || verdictFor, confirm };
  const adapter = createLiveToolAdapter({
    leash,
    dispatchAction: async (decision, ctx) => {
      dispatched.push({ decision, ctx });
      if (dispatch) return dispatch(decision, ctx);
      return outcome || { ok: true, unverified: false, evidence: { oracle: 'page-state', observed: 'url changed to /watch' }, result: {} };
    },
    bus: { emit: (type, p) => { if (type === 'health.anomaly') anomalies.push(p); } },
    logger: { warn() {}, info() {} }, connectionId: 'conn-461',
    memory: { working: { tick: 1 }, episodic: { write() {} }, audit: { write: (e) => audits.push(e) } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => notices.push(t) }),
    toolAckDeadlineMs: 500,
    describeBrowserRef: (ref) => labels[ref] || null,
  });
  let n = 0; let turnNo = 0;
  return {
    adapter, confirm, dispatched, notices, anomalies, audits,
    async call(name, args, spoken, typed) {
      let sent = null;
      await adapter.handleLiveToolCalls([{ id: 'fc-' + (++n), name, args }],
        { sendToolResponse: (r) => { sent = r; }, userTextSoFar: spoken || '', typedTextSoFar: typed || '' });
      return sent && sent[0] ? sent[0].response : null;
    },
    async end(userText, assistantText, typedText, evidence) {
      adapter.onLiveTurnComplete({ userText: userText || '', assistantText: assistantText || '', turnId: ++turnNo, typedText: typedText || '',
        ...(evidence || heard) });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}
const CLICK = { ref: 'f2e308' };
const ASKED_CLICK = 'Sorry, Sir — did you want me to play the Café Ambience video?';

describe('through the real adapter — hold, ask, and run exactly the proposal on a yes', () => {
  it('(a1) REPLAY 15:11:24: the click in the objection turn does not run, and the model is told to ask', async () => {
    const h = live();
    const res = await h.call('browser_click', CLICK, OBJECTION_0924);
    assert.equal(h.dispatched.length, 0, 'before this change: dispatched — the click played a video nobody asked for');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /browser_click has NOT run/);
    assert.match(res.message, /Ask the operator one short question/, 'the next step is named in the message the model reads');
    const held = h.audits.filter((a) => a.decision === 'held');
    assert.equal(held.length, 1, 'the audit must say the allowed click was then held, or it shows a click that never happened');
    assert.equal(held[0].tool, 'browser_click');
    assert.match(held[0].reason, /^awaiting-operator-yes: operator-objected$/);
    assert.ok(!JSON.stringify(held[0]).includes('background noise'), 'no operator words in the audit line');
  });

  it('(a2) GOAL: asked, then "Yes." — the stored click runs once, with the stored args, and the model hears the outcome', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    assert.equal(h.dispatched.length, 0);
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 1);
    assert.deepEqual(h.dispatched[0].decision, { tool: 'browser_click', args: CLICK });
    assert.ok(h.notices.some((t) => /APPROVED browser_click/.test(t)), JSON.stringify(h.notices));
    await h.end('Yes.', 'Anything else?');
    assert.equal(h.dispatched.length, 1, 'a second yes approves nothing');
  });

  it('(a3) GOAL, the other route: the model re-issues the call on the yes — it runs once, not twice', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    await h.call('browser_click', CLICK, 'Yes, play it.');
    assert.equal(h.dispatched.length, 1);
    await h.end('Yes, play it.', 'Playing it now.');
    assert.equal(h.dispatched.length, 1, 'the turn-end approval found nothing left to run');
  });

  it('(a3b) the model re-issuing the call is not a yes: without the operator\'s yes it waits, and runs nothing', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    const res = await h.call('browser_click', CLICK, 'What was that about?');
    assert.equal(res.status, 'waiting_for_operator');
    assert.equal(h.dispatched.length, 0, 'the model cannot set the consent flag by asking twice');
  });

  it('(a4) an unrelated yes approves nothing: no proposal, or a proposal MYTHOS never asked about', async () => {
    const h = live();
    await h.end('Yes.', 'Hello.');
    assert.equal(h.dispatched.length, 0);
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, 'Right, one moment.'); // held, but no question was put
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0);
  });

  it('(a5) changed arguments authorise nothing: a yes with a DIFFERENT click is judged afresh (and held)', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    const res = await h.call('browser_click', { ref: 'f2e999' }, 'Yes.');
    // f2e999 has no name in the snapshot, so since S1 it cannot be asked about by
    // name: the model is told to get the operator's own words instead. Held either way.
    assert.equal(res.status, 'needs_operator_words');
    assert.equal(h.dispatched.length, 0);
  });

  it('(a6) any other speech cancels the proposal (WAVE 8 rule) — a later yes runs nothing', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    await h.end('Actually, open Spotify instead of that.', 'Sure.');
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0);
  });

  it('(a7) "no" cancels through the existing spoken-no path, and the model is told', async () => {
    const h = live();
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    await h.end('No, leave it.', 'Understood.');
    assert.ok(h.notices.some((t) => /said no\. Cancelled: browser_click/.test(t)));
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0);
  });

  it('(a8) the policy is re-checked before an approved call runs: withdrawn meanwhile, it does not run', async () => {
    let allowed = true;
    const h = live({ check: (d) => (allowed ? verdictFor(d) : { allow: false, requireConfirm: false, tier: 3, reason: 'dry-run' }) });
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    allowed = false;
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0);
    assert.ok(h.notices.some((t) => /no longer permitted: dry-run/.test(t)));
  });

  it('(a9) the "approval needs a click" notice (BUG-357) is not sent for a proposal a spoken yes can approve', async () => {
    const h = live({ dispatch: () => new Promise(() => {}) }); // the approved click never settles
    await h.call('browser_click', CLICK, NOISE_0924);
    await h.end(NOISE_0924, ASKED_CLICK);
    await h.end('Yes, go ahead.', 'On it.');
    assert.ok(!h.notices.some((t) => /did NOT dispatch anything/.test(t)), JSON.stringify(h.notices));
  });

  it('(a10) a real request runs straight away — no question, no delay', async () => {
    const h = live();
    const res = await h.call('browser_click', CLICK, 'Can you play the third video?');
    assert.equal(h.dispatched.length, 1);
    assert.notEqual(res.status, 'needs_operator_yes');
  });

  it('(a11) typed words reach the gate: a typed request runs; a typed yes approves a proposal', async () => {
    const h = live();
    await h.call('browser_click', CLICK, '', 'pause');
    assert.equal(h.dispatched.length, 1, 'typed "pause" is the operator, not noise');
    const g = live();
    await g.call('browser_click', CLICK, NOISE_0924);
    await g.end(NOISE_0924, ASKED_CLICK);
    await g.end('', 'Okay.', 'yes');
    assert.equal(g.dispatched.length, 1);
  });

  it('(a12) CONTAINMENT: a tool the leash did not allow for a human is not the gate\'s to hold or approve', async () => {
    const h = live({ check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'never-trustable' }) });
    const res = await h.call('gmail_send', { to: 'x', body: 'y' }, NOISE_0924);
    assert.equal(res.status, 'awaiting_human_confirmation', 'the HUD confirm path, unchanged');
    await h.end(NOISE_0924, 'Shall I send it?');
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0, 'a spoken yes can never approve a click-only confirm');
    assert.deepEqual([...HUMAN_PREMISE_REASONS].sort(), ['operator-present-trusted', 'session-granted']);
  });

  it('(a13) BUG-460 kept honest: "further" held and then ASKED about draws no "I missed what you said"', async () => {
    const h = live();
    await h.call('browser_press_key', { key: 'PageDown' }, 'further');
    await h.end('further', 'Do you want me to scroll further down the page?');
    assert.equal(h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length, 0);
  });
});

describe('BUG-464 through the real adapter — to the real store', () => {
  function withStore() {
    const writes = [];
    const tools = buildTools({ semantic: { write: (topic, lines, opts) => { writes.push({ topic, lines, opts }); return { ref: 'sem-1' }; } }, fs: {} });
    const ctx = { bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } }, config: {},
      effectors: { invoke: (name, params, callCtx) => tools.find((t) => t.name === name).fn(params, callCtx) } };
    const h = live({ dispatch: (decision, dctx) => dispatchAction(decision, { ...ctx, ...dctx }) });
    return { h, writes };
  }

  it('(s1) REPLAY 14:53:37: remember on "November" writes nothing, and the correction still fires on the assertion', async () => {
    const { h, writes } = withStore();
    const res = await h.call('remember', { text: NOVEMBER_TEXT }, 'November');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /Shall I remember this: 'User has not been feeling well/);
    await h.end('November', SAID_NOVEMBER);
    assert.equal(writes.length, 0, 'before this change: written, labelled voice-explicit');
    assert.equal(h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length, 1);
  });

  it('(s2) the unrelated yes: the real reply had the words AND a question — about her health. "Yes" saves nothing', async () => {
    const { h, writes } = withStore();
    await h.call('remember', { text: NOVEMBER_TEXT }, 'November');
    await h.end('November', SAID_NOVEMBER);
    await h.end('Yes.', 'Glad to hear it.');
    assert.equal(writes.length, 0);
  });

  it('(s3) GOAL: read back word for word, then "Yes." — written once, labelled operator-approved', async () => {
    const { h, writes } = withStore();
    await h.call('remember', { text: NOVEMBER_TEXT }, 'November');
    await h.end('November', `Shall I remember this: "${NOVEMBER_TEXT}"?`);
    await h.end('Yes.', 'Okay.');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].lines, [NOVEMBER_TEXT]);
    assert.deepEqual(writes[0].opts.sources, ['operator-approved']);
  });

  it('(s4) a paraphrase is not a read-back: the yes saves nothing', async () => {
    const { h, writes } = withStore();
    await h.call('remember', { text: NOVEMBER_TEXT }, 'November');
    await h.end('November', 'Should I save a note about your health?');
    await h.end('Yes.', 'Okay.');
    assert.equal(writes.length, 0);
  });

  it('(s5) an explicit ask writes at once, through the real dispatcher, labelled voice-explicit', async () => {
    const { h, writes } = withStore();
    const res = await h.call('remember', { text: 'The operator\'s sister\'s name is Priya.' }, 'Please remember that my sister\'s name is Priya.');
    assert.notEqual(res.status, 'needs_operator_yes');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].opts.sources, ['voice-explicit']);
  });

  it('(s5b) S1: the same ask saved in the model\'s own words ("is called") is read back first, then saved on a yes', async () => {
    // Until 2026-09-25 this was (s5) itself and wrote at once. "Called" is not a
    // word the operator said — harmless here, but the same rule is what stops
    // "blue" being saved as "green" (F03), so a paraphrase is confirmed, not trusted.
    const { h, writes } = withStore();
    const text = 'The operator\'s sister is called Priya.';
    const res = await h.call('remember', { text }, 'Please remember that my sister\'s name is Priya.');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /the text to save is not what the operator said/);
    await h.end('Please remember that my sister\'s name is Priya.', `Shall I remember this: "${text}"?`);
    assert.equal(writes.length, 0);
    await h.end('Yes.', 'Saved.');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].opts.sources, ['operator-approved']);
  });

  it('(s6) the requested 14:55:56 save still lands: read back in the model\'s words, then saved on the yes', async () => {
    // Until S1 this wrote at once. The saved text is the model's paraphrase
    // ("mentions they are unwell" — words the operator never used), so it is now
    // read back first; the GOAL, the operator's request saved, is unchanged.
    const { h, writes } = withStore();
    const text = 'If the operator mentions they are unwell, ask if they are feeling better next time.';
    const res = await h.call('remember', { text }, REQUESTED_1455);
    assert.equal(res.status, 'needs_operator_yes');
    await h.end(REQUESTED_1455, `Shall I remember this: "${text}"?`);
    await h.end('Yes, please.', 'Done.');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].lines, [text]);
  });
});

describe('the typed/batch path (voice-agent.js) — same rule, same lock', () => {
  it('(p1) not asked: no consent, a read-back instruction; asked: consent for exactly that call', () => {
    const g = createTypedMemoryGate({ now: () => TODAY.getTime() });
    const d = { tool: 'remember', args: { text: NOVEMBER_TEXT } };
    const held = g.hold(d, 'November', 'conn-1');
    assert.ok(held.refuse && !held.consent);
    assert.match(held.refuse, /Read this exact text back/);
    const yes = g.hold(d, 'Yes.', 'conn-1');
    assert.equal(verifyConsent(yes.consent, 'remember', d.args).basis, 'approved-proposal');
    const again = g.hold(d, 'Yes.', 'conn-1');
    assert.ok(again.refuse, 'the proposal was used up');
    const asked = g.hold({ tool: 'remember', args: { text: 'Dark mode everywhere.' } }, 'Please remember that I like dark mode everywhere.', 'conn-1');
    assert.equal(verifyConsent(asked.consent, 'remember', { text: 'Dark mode everywhere.' }).basis, 'operator-request');
    assert.deepEqual(g.hold({ tool: 'browser_click', args: {} }, 'x', 'conn-1'), {}, 'only memory writes are gated on this path');
  });

  it('(p2) the batch agent hands the utterance to the gate: "November" + remember is never dispatched', async () => {
    const { createVoiceAgent } = require('../src/core/voice/voice-agent');
    const dispatched = [];
    const agent = createVoiceAgent({
      brain: { think: async () => ({ content: JSON.stringify({ say: 'Noted.', actions: [{ tool: 'remember', args: { text: NOVEMBER_TEXT } }] }), parsed: { say: 'Noted.', actions: [{ tool: 'remember', args: { text: NOVEMBER_TEXT } }] } }) },
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
      dispatch: async (d, c) => { dispatched.push({ d, c }); return { ok: true, result: {} }; },
      bus: { emit() {} }, config: { VOICE_MAX_TOOL_ITERATIONS: 1 },
    });
    await agent.handleUtterance({ text: 'November', ctx: { connectionId: 'conn-1' } });
    assert.equal(dispatched.filter((x) => x.d.tool === 'remember').length, 0);
  });

  it('(p3) ADJACENT: an explicit typed ask IS dispatched, carrying a consent for exactly that call', async () => {
    const { createVoiceAgent } = require('../src/core/voice/voice-agent');
    const act = { tool: 'remember', args: { text: 'The operator likes dark mode everywhere.' } };
    const dispatched = [];
    const agent = createVoiceAgent({
      brain: { think: async () => ({ content: JSON.stringify({ say: 'Saved.', actions: [act] }), parsed: { say: 'Saved.', actions: [act] } }) },
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
      dispatch: async (d, c) => { dispatched.push({ d, c }); return { ok: true, result: {} }; },
      bus: { emit() {} }, config: { VOICE_MAX_TOOL_ITERATIONS: 1 },
    });
    await agent.handleUtterance({ text: 'Please remember that I like dark mode everywhere.', ctx: { connectionId: 'conn-1' } });
    const saves = dispatched.filter((x) => x.d.tool === 'remember');
    assert.equal(saves.length, 1, 'the utterance must reach the gate, or no ask can ever be honoured');
    assert.equal(verifyConsent(saves[0].c.consent, 'remember', saves[0].d.args).basis, 'operator-request');
  });
});

describe('hop 1 of 3 — the Live session hands the operator\'s words to the tool call', () => {
  const { EventEmitter } = require('events');
  const { createLiveSession } = require('../src/core/voice/live-session');
  class Sock extends EventEmitter {
    constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
    send(j) { this.sent.push(JSON.parse(j)); }
    close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
    frame(f) { this.emit('message', Buffer.from(JSON.stringify(f))); }
  }

  it('(u1) spoken and typed words so far ride on the tool call, and reset at the turn boundary', async (t) => {
    const priorKey = process.env.GOOGLE_API_KEY; // open() refuses without one; a dummy, as live-session tests use
    process.env.GOOGLE_API_KEY = 'test-key';
    t.after(() => { if (priorKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = priorKey; });
    const sockets = []; const calls = []; const turns = [];
    const session = createLiveSession({
      config: {}, bus: { emit() {} }, logger: { warn() {}, info() {} }, spend: { recordCall() {} },
      breakers: { allow: () => true, fail() {}, success() {} }, systemInstruction: 't', functionDeclarations: [],
      onAudioOut() {}, onTranscript() {}, onState() {}, onTurnComplete: (t) => turns.push(t),
      onToolCall: (fc, ctx) => { calls.push(ctx); },
      createSocket: () => { const s = new Sock(); sockets.push(s); return s; },
    });
    const opened = session.open(); sockets[0].readyState = 1; sockets[0].emit('open'); sockets[0].frame({ setupComplete: {} }); await opened;
    sockets[0].frame({ serverContent: { inputTranscription: { text: NOISE_0924 } } });
    session.sendText('pause', { site: 'operator-typed', operator: true });
    sockets[0].frame({ toolCall: { functionCalls: [{ id: 'fc-1', name: 'browser_click', args: {} }] } });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[0].userTextSoFar, NOISE_0924);
    assert.equal(calls[0].typedTextSoFar, 'pause');
    sockets[0].frame({ serverContent: { turnComplete: true } });
    assert.equal(turns[0].typedText, 'pause', 'the turn record carries the typed words too');
    sockets[0].frame({ toolCall: { functionCalls: [{ id: 'fc-2', name: 'browser_click', args: {} }] } });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[1].userTextSoFar, '');
    assert.equal(calls[1].typedTextSoFar, '', 'last turn\'s words never authorise this turn\'s call directly');
    session.close('test');
  });
});

describe('derived sets and forward guards', () => {
  it('(g1) MEMORY_TOOLS is every tool whose effector writes user-facts — derived from the effector source', () => {
    const dir = path.join(__dirname, '..', 'src', 'core', 'effectors');
    const writers = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const re = /async function (\w+)\s*\([^)]*\)\s*\{[\s\S]*?\n {2}\}/g;
      let m;
      while ((m = re.exec(src))) if (/\.write\(\s*'user-facts'/.test(m[0])) writers.push(m[1]);
    }
    assert.ok(writers.length >= 1, 'the scan found no writer at all — it is broken, not proving anything');
    assert.deepEqual(writers.sort(), [...MEMORY_TOOLS].sort());
  });

  it('(g2) HUMAN_PREMISE_REASONS is what the real leash says ONLY when a human connection is driving', () => {
    const make = (cfg) => makeLeash(cfg);
    const seen = new Set();
    const trustOn = make({});
    for (const tool of Object.keys(TIER_TABLE)) {
      const withHuman = trustOn.check({ tool, args: {} }, { connectionId: 'conn-1' });
      const without = trustOn.check({ tool, args: {} }, {});
      if (withHuman.allow && !without.allow) seen.add(withHuman.reason);
    }
    const trustOff = make({ TRUSTED_TOOLS_DISABLED: true });
    const id = trustOff.confirm.create('s', { decision: { tool: 'browser_click', args: {} }, tier: 3 }, 'conn-1');
    trustOff.confirm.accept(id, 'conn-1');
    seen.add(trustOff.check({ tool: 'browser_click', args: {} }, { connectionId: 'conn-1' }).reason);
    assert.deepEqual([...seen].sort(), [...HUMAN_PREMISE_REASONS].sort());
  });

  it('(g3) only the authority gate mints consent — no other runtime file can hand remember a token', () => {
    const root = path.join(__dirname, '..', 'src');
    const minters = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && /mintConsent\(/.test(fs.readFileSync(p, 'utf8'))) minters.push(path.relative(root, p).replace(/\\/g, '/'));
      }
    })(root);
    assert.deepEqual(minters.sort(), ['core/leash/consent.js', 'core/voice/authority-gate.js']);
  });
});

describe('known gaps, pinned with the reason', () => {
  it('DECIDED 2026-09-25 (was a known gap): the background summariser writes user-facts only when MEMORY_AUTO_USER_FACTS=true', () => {
    // memory/index.js step 3b asks the memory lane to "Extract durable facts about
    // the user" and writes each to user-facts with no request. It was pinned here as
    // an open door on 2026-09-24, "when it is decided, flip this". The operator
    // decided on 2026-09-25 (BUG-463): off by default. The behaviour is pinned end to
    // end in test/bug-463-startup-notes-and-auto-facts.test.js (f)-(h); this keeps
    // the write itself gated in the source.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'memory', 'index.js'), 'utf8');
    assert.match(src, /if \(process\.env\.MEMORY_AUTO_USER_FACTS !== 'true'\) \{[\s\S]{0,400}\} else try \{/);
  });

  it('CLOSED 2026-09-25 (was a known gap, audit F04): a question that does not name the click\'s target presents nothing', () => {
    // The original reproduction, kept verbatim as the regression: before S1 the
    // last assertion was presented === true — "Shall I play the other video
    // instead?" presented a click on ref e9 it never named, and a yes would have run it.
    const make = (describeRef) => createAuthorityGate({ leash: { confirm: createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 60000 } }) },
      connectionId: 'c', pendingConfirms: new Map(), dispatchAction: async () => ({ ok: true }), resolveConfirm: () => {}, describeRef });
    const heard = { interrupts: 0, audioParts: 4 };
    const nameless = make(null);
    nameless.hold({ id: 'x' }, { tool: 'browser_click', args: { ref: 'e9' } }, { allow: true, reason: 'operator-present-trusted', tier: 3 }, { spoken: 'yes' });
    nameless.onTurnComplete({ userText: 'yes', assistantText: 'Shall I play the other video instead?', turnId: 1, ...heard });
    assert.equal(nameless._internal.proposal.presented, false, 'the ref has no name here, so no question can have named it');
    const named = make((ref) => (ref === 'e9' ? 'Xiaomi 15 Ultra long-term review' : null));
    named.hold({ id: 'y' }, { tool: 'browser_click', args: { ref: 'e9' } }, { allow: true, reason: 'operator-present-trusted', tier: 3 }, { spoken: 'yes' });
    named.onTurnComplete({ userText: 'yes', assistantText: 'Shall I play the other video instead?', turnId: 1, ...heard });
    assert.equal(named._internal.proposal.presented, false, 'the WRONG video, even with a name to check against');
  });
});
