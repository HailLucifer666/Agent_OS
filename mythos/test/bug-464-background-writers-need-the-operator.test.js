'use strict';

// BUG-464, widened by the operator's decision of 2026-10-06: nothing goes into
// permanent memory unless the operator asked for it, or approved the exact text
// read back to them — the rule `remember` already followed (leash/consent.js).
//
// GATE B, the set derived from the reason "a durable record about the operator is
// written without the operator's request" (every writer into the operator
// profile, user facts, notes and Semantic memory, found by searching the runtime
// for the store writers, not by the ticket's list; (d1) below re-derives it on
// every run, so a new writer fails until someone classifies it):
//   remember                         consent lock (BUG-464, 2026-09-24)       unchanged
//   memory/index.js step 3b          MEMORY_AUTO_USER_FACTS (BUG-463)          unchanged
//   note_take (from-memory.js)       consent lock                              NEW
//   write_note (from-pc.js)          consent lock                              NEW
//   identity/reflection.js runNow    MEMORY_AUTO_USER_FACTS, before the brain  NEW
//   memory/habit-promoter.js         ON (2nd decision, 2026-10-06): 3 plays on
//                                    2+ local days, read from Episodic         NEW
//   memory/index.js step 3           ON, drops lines about the operator        NEW
//   memory/index.js step 3c merge    rewrites existing records only            unchanged
//   log_incident                     NOT IN SET: a record about MYTHOS's faults
// Plus the two residuals the 2026-09-25 attended run left on BUG-464:
//   (i)  the refusal now says nothing is kept and forbids "I'll keep that in mind";
//   (ii) a spoken "no" to a spoken proposal no longer injects a cancel notice,
//        which Gemini Live answered as a new turn ("I've cancelled adding that
//        preference to memory", 02:14:29, six seconds after the cancel).
//
// NEGATIVE CONTROL, 2026-10-06: the seven changed runtime files put back as they
// are at 323fba62 (the new auto-operator-facts.js kept): 21 of 27 red. The six
// green are the ones that must be: (c2) and (r2) adjacent, (k1) the pin, (s1)/(h2)
// the new module itself, and (a2), whose goal (one note on disk) the unlocked code
// also reached, by writing at once — (a1) is the test that tells them apart.
// (n5) first passed there for the wrong reason (the goal gate refused a goalless
// cortex call before the effector ran); it now uses an active goal and asserts the
// refusal is the lock's own.
//
// MUTATION PROBES, 2026-10-06 — each applied once by exact-string replacement
// (a missing anchor aborts the probe), confirmed changed by hash, run against this
// file, restored from a copy and confirmed by hash. 14 probes, 14 caught:
//   P1  note_take's consent check disabled                  -> (n1)(n2)(n3)(n4)(n5)
//   P2  write_note's consent check disabled                 -> (w1)
//   P3  NOTE_TOOLS emptied in authority-gate.js             -> (a1)(a2)(a3)(a4)(a5)(t1)(t2)(d2)
//   P4b judgeNoteWrite always proceeds                      -> (j1)(j2)(j3)(a1)(a3)(t1)(t2)
//   P5  judgeNoteWrite ignores negation                     -> (j2)
//   P6  reflection's switch check disabled                  -> (r1)(d1)
//   P7  habit-promoter's switch check disabled              -> (h1)(d1)
//   P8  the switch accepts any non-empty value              -> (s1)(h2)
//   P9  cancel notice sent for spoken proposals again       -> (c1)
//   P10 cancel notice skipped for click confirms too        -> (c2)
//   P11 refusal loses "nothing is saved" and the prohibition -> (q1)
//   P12 stamp moved back after the gate (adapter)           -> (a5)
//   P13 FIXTURE: (a2) reads back a different text           -> (a2)
//   P14 the gate's note rule always proceeds (judgeSave)    -> (a1)(a3)(t1)(t2)
// (P7, the habit switch, retired with the operator's second decision below.)
//
// SECOND DECISION, 2026-10-06: habits stay on (3 plays on 2+ local days), and
// step 3 stays on but drops lines about the operator. Negative control with
// memory/index.js and habit-promoter.js as at 323fba62 (new modules kept): 5 of
// 35 red, (h1)(h4)(d1)(x1)(x2); (h2b) is green there because the old promoter
// also promoted it — it was red against the switch-gated build (first round).
// 9 more probes, 9 caught, same procedure:
//   P15 day rule removed                                    -> (h1)(h4)
//   P16 MIN_HABIT_DAYS = 1                                  -> (h1)(h4)
//   P17 Episodic history ignored (in-process only)          -> (h4)
//   P18 a failed play counted                               -> (h4)
//   P19 step 3 writes the raw distillation                  -> (d1)(x1)  (d1 tightened after this probe first passed it)
//   P20 classifier loses semantic.js's identity pattern     -> (o1)(o2)
//   P21 'user' dropped from the referents                   -> (o1)(o3)(x1)(x2)
//   P22 the drop event carries the dropped text             -> (x1)
//   P23 all-operator distillation skip goes silent          -> (x2)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const authority = require('../src/core/voice/operator-authority');
const gateModule = require('../src/core/voice/authority-gate');
const { createAuthorityGate, createTypedMemoryGate } = gateModule;
const { mintConsent, verifyConsent } = require('../src/core/leash/consent');
const { createConfirmRegistry } = require('../src/core/leash/confirm');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { buildTools } = require('../src/core/effectors/from-memory');
const { createNotesStore } = require('../src/core/memory/notes');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const SRC = path.join(__dirname, '..', 'src');
const ON = { MEMORY_AUTO_USER_FACTS: 'true' };

let dir; let notes;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-464-notes-')); notes = createNotesStore({ dir }); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
const noteFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.toLowerCase());
const noteTool = () => buildTools({ notes }).find((t) => t.name === 'note_take');

describe('the lock — note_take writes nothing without a server-minted consent for exactly this call', () => {
  const args = { title: 'Groceries', text: 'buy milk and eggs tomorrow' };

  it('(n1) no consent: refused, and no file reaches the disk', async () => {
    const r = await noteTool().fn(args, {});
    assert.equal(r.ok, false);
    assert.match(r.result.error, /no-consent/);
    assert.deepEqual(noteFiles(), [], 'the mechanism, not the return value: nothing on disk');
  });

  it('(n2) a forged token (plain object) or one carried in the ARGUMENTS is refused', async () => {
    const real = mintConsent({ tool: 'note_take', args, basis: 'operator-request' });
    assert.equal((await noteTool().fn(args, { consent: JSON.parse(JSON.stringify(real)) })).ok, false);
    assert.equal((await noteTool().fn({ ...args, consent: real }, {})).ok, false);
    assert.deepEqual(noteFiles(), []);
  });

  it('(n3) ADJACENT: a consent for exactly this call writes the note, once', async () => {
    const consent = mintConsent({ tool: 'note_take', args, basis: 'operator-request' });
    assert.equal((await noteTool().fn(args, { consent })).ok, true);
    assert.deepEqual(noteFiles(), ['groceries.md']);
    assert.equal((await noteTool().fn(args, { consent })).ok, false, 'single use');
  });

  it('(n4) a consent for another text, or for remember, does not write this note', async () => {
    const other = mintConsent({ tool: 'note_take', args: { ...args, text: 'buy bread' }, basis: 'operator-request' });
    assert.match((await noteTool().fn(args, { consent: other })).result.error, /consent-for-another-call/);
    const rem = mintConsent({ tool: 'remember', args, basis: 'operator-request' });
    assert.equal((await noteTool().fn(args, { consent: rem })).ok, false);
    assert.deepEqual(noteFiles(), []);
  });

  it('(n5) the autonomous loop (the shared dispatcher with no operator words) cannot write a note', async () => {
    const tool = noteTool();
    // An ACTIVE goal with budget, so the dispatcher's own goal gate admits the call
    // and the effector is reached: without it this test passed on the unfixed code
    // (refused as autonomous-without-goal, found by the 2026-10-06 negative control).
    const goals = { get: () => ({ status: 'active', budget: { tokens: 1000, actions: 10 }, spent: {} }), debitBudget() {} };
    const ctx = { bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } }, config: {}, goals,
      effectors: { invoke: (name, params, callCtx) => tool.fn(params, callCtx) } };
    const out = await dispatchAction({ tool: 'note_take', args }, { ...ctx, tier: 1, channel: 'cortex', goalId: 'goal-1' });
    assert.equal(out.ok, false);
    assert.match(JSON.stringify(out.result), /no-consent/, 'refused by the lock, not by the goal gate');
    assert.deepEqual(noteFiles(), []);
    const consent = mintConsent({ tool: 'note_take', args, basis: 'operator-request' });
    assert.equal((await dispatchAction({ tool: 'note_take', args }, { ...ctx, tier: 1, channel: 'voice-live', consent })).ok, true,
      'ADJACENT: the dispatcher carries a server-minted consent through');
    assert.deepEqual(noteFiles(), ['groceries.md']);
  });
});

describe('the lock — write_note (pc-child NOVA-Notes) never reaches pc-child without consent', () => {
  it('(w1) no consent: refused before pc-child is asked; with consent: pc-child gets exactly the call', async () => {
    const pcChild = require('../adapters/pc-child');
    const fromPc = require('../src/core/effectors/from-pc');
    const saved = { getStatus: pcChild.getStatus, sendCommand: pcChild.sendCommand };
    const sent = [];
    pcChild.getStatus = () => ({ state: 'ONLINE' });
    pcChild.sendCommand = async (cmd) => { sent.push(cmd); return { ok: true, result: { path: 'n.txt' } }; };
    try {
      const writeNote = fromPc.TOOLS.find((t) => t.name === 'write_note');
      const args = { text: 'call the plumber on Monday', title: 'todo' };
      const refused = await writeNote.fn(args, {});
      assert.equal(refused.ok, false);
      assert.match(String(refused.result && (refused.result.error || refused.result)), /no-consent/);
      assert.equal(sent.length, 0, 'the mechanism: pc-child was never asked to write');
      const consent = mintConsent({ tool: 'write_note', args, basis: 'operator-request' });
      assert.equal((await writeNote.fn(args, { consent })).ok, true, 'ADJACENT: a requested note is written');
      assert.deepEqual(sent, [{ cmd: 'write_note', text: args.text, title: 'todo' }]);
    } finally { Object.assign(pcChild, saved); }
  });
});

describe('the rule — what counts as the operator asking for a note (pure)', () => {
  const judge = (current, extra) => authority.judgeNoteWrite(Object.assign({ current }, extra));

  it('(j1) explicit asks proceed; unrelated words, a question about notes and a read request do not', () => {
    for (const s of ['Take a note: buy milk and eggs tomorrow.', 'Can you write that down?', 'Please add this to my shopping note.',
      'Make a quick note of the recipe you just read.', 'Note that down for me.', 'Write it down.']) {
      assert.equal(judge(s).proceed, true, s);
    }
    for (const s of ['November', 'What is in my shopping note?', 'Read my project note.', 'I was feeling unwell yesterday.',
      'Did you take a note of that?', '']) {
      assert.equal(judge(s).proceed, false, s);
    }
  });

  it('(j2) negation, objection, quotation and hypotheticals do not ask', () => {
    for (const s of ["You don't have to write that down.", 'No need to take a note of it.', "Don't make a note of that.",
      "I didn't ask you to take a note.", 'He told me "take a note" every morning.', 'If I say take a note, just nod.']) {
      assert.equal(judge(s).proceed, false, s);
    }
  });

  it('(j3) a turn with no words inherits the last words if recent (60 s), never a stale ask', () => {
    assert.equal(judge('', { previous: 'Take a note: call Ravi.', previousAgeMs: 5000 }).proceed, true);
    assert.equal(judge('', { previous: 'Take a note: call Ravi.', previousAgeMs: authority.CONTINUATION_WINDOW_MS + 1 }).proceed, false);
  });
});

// The real Live adapter, the real confirm registry, the real dispatcher and the
// real note_take writing into a temp notes directory: the GOAL (a file on disk),
// not only the refusal.
const HEARD = { interrupts: 0, audioParts: 3 };
function live() {
  const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 120000 } });
  const tool = noteTool();
  const dispatched = []; const notices = [];
  const verdict = (d) => ({ allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0,
    reason: TIER_TABLE[d.tool] === 3 ? 'operator-present-trusted' : 'within-autonomous-max' });
  const effectors = { invoke: (name, params, callCtx) => (name === 'note_take' ? tool.fn(params, callCtx) : { ok: true, result: {} }) };
  const adapter = createLiveToolAdapter({
    leash: { check: verdict, confirm },
    dispatchAction: async (decision, ctx) => {
      dispatched.push({ decision: JSON.parse(JSON.stringify(decision)), consent: ctx.consent });
      return dispatchAction(decision, { ...ctx, bus: { emit() {} }, memory: { audit: { write() {} }, episodic: { write: async () => ({}) } },
        config: {}, effectors });
    },
    bus: { emit() {} }, logger: { warn() {}, info() {} }, connectionId: 'conn-464',
    memory: { working: { tick: 1 }, episodic: { write() {} }, audit: { write() {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => notices.push(t) }),
    toolAckDeadlineMs: 500,
  });
  let n = 0; let turn = 0;
  return {
    dispatched, notices, confirm,
    async call(name, args, spoken) {
      let sent = null;
      await adapter.handleLiveToolCalls([{ id: 'fc-' + (++n), name, args }],
        { sendToolResponse: (r) => { sent = r; }, userTextSoFar: spoken || '', typedTextSoFar: '' });
      return sent && sent[0] ? sent[0].response : null;
    },
    async end(userText, assistantText) {
      adapter.onLiveTurnComplete({ userText: userText || '', assistantText: assistantText || '', turnId: ++turn, typedText: '', ...HEARD });
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}
const NOTE = { title: 'Rest', text: 'The operator was unwell yesterday and needs rest' };

describe('through the real Live adapter — notes follow the remember rule', () => {
  it('(a1) a note the operator did not ask for is held, and nothing reaches the disk', async () => {
    const h = live();
    const res = await h.call('note_take', NOTE, 'I was feeling unwell yesterday, but better now.');
    assert.equal(h.dispatched.length, 0, 'before this change: dispatched and written');
    assert.equal(res.status, 'needs_operator_yes');
    assert.ok(res.message.includes(NOTE.text), 'the refusal carries the exact text to read back');
    assert.deepEqual(noteFiles(), []);
  });

  it('(a2) GOAL: read back exactly, then "Yes." — the note is written once, with the stored text', async () => {
    const h = live();
    await h.call('note_take', NOTE, 'I was feeling unwell yesterday, but better now.');
    await h.end('I was feeling unwell yesterday, but better now.', `Shall I save this note: "${NOTE.text}"?`);
    await h.end('Yes.', 'Saved.');
    assert.equal(h.dispatched.length, 1);
    assert.deepEqual(h.dispatched[0].decision.args, NOTE);
    assert.deepEqual(noteFiles(), ['rest.md']);
    await h.end('Yes.', 'Anything else?');
    assert.equal(h.dispatched.length, 1, 'a second yes approves nothing');
  });

  it('(a3) a read-back of a DIFFERENT text presents nothing, so a yes writes nothing', async () => {
    const h = live();
    await h.call('note_take', NOTE, 'I was feeling unwell yesterday, but better now.');
    await h.end('I was feeling unwell yesterday, but better now.', 'Shall I save this note: "The operator is fine now"?');
    await h.end('Yes.', 'Okay.');
    assert.equal(h.dispatched.length, 0);
    assert.deepEqual(noteFiles(), []);
  });

  it('(a4) ADJACENT: an operator-requested note runs at once, carrying a consent for exactly that call', async () => {
    const h = live();
    const args = { title: 'Groceries', text: 'buy milk and eggs tomorrow' };
    await h.call('note_take', args, 'Take a note called groceries: buy milk and eggs tomorrow.');
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.dispatched[0].consent.tool, 'note_take');
    assert.deepEqual(noteFiles(), ['groceries.md'], 'the goal: the file is on disk');
  });

  it('(a5) a stamped write_note is judged as stamped: the consent fits the args the effector receives', async () => {
    // BUG-300 appends a provenance footer to write_note's text in the adapter. The
    // consent is bound to the exact arguments, so the stamp must happen BEFORE the
    // gate mints it, or every requested write_note would be refused as
    // consent-for-another-call.
    const h = live();
    await h.call('write_note', { text: 'call the plumber' }, 'Can you write that down as a note: call the plumber.');
    assert.equal(h.dispatched.length, 1);
    const d = h.dispatched[0];
    assert.match(d.decision.args.text, /not verified by any tool/);
    assert.equal(verifyConsent(d.consent, 'write_note', d.decision.args).ok, true);
  });
});

describe('the typed/batch path — the same rule for notes', () => {
  it('(t1) not asked: refused with a read-back; asked: consent for exactly that call; a yes approves the read-back', () => {
    const g = createTypedMemoryGate({ now: () => Date.now() });
    const d = { tool: 'note_take', args: NOTE };
    const held = g.hold(d, 'November', 'conn-1');
    assert.ok(held.refuse && !held.consent);
    assert.ok(held.refuse.includes(NOTE.text));
    const yes = g.hold(d, 'Yes.', 'conn-1');
    assert.equal(verifyConsent(yes.consent, 'note_take', d.args).basis, 'approved-proposal');
    const asked = g.hold({ tool: 'write_note', args: { text: 'buy milk' } }, 'Please take a note: buy milk.', 'conn-1');
    assert.equal(verifyConsent(asked.consent, 'write_note', { text: 'buy milk' }).basis, 'operator-request');
  });

  it('(t2) the batch agent: "November" + note_take is never dispatched; an asked note is, with its consent', async () => {
    const { createVoiceAgent } = require('../src/core/voice/voice-agent');
    const run = async (utterance) => {
      const dispatched = [];
      const act = { tool: 'note_take', args: NOTE };
      const agent = createVoiceAgent({
        brain: { think: async () => ({ content: JSON.stringify({ say: 'Noted.', actions: [act] }), parsed: { say: 'Noted.', actions: [act] } }) },
        leash: { check: () => ({ allow: true, requireConfirm: false, tier: 1, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
        dispatch: async (dd, c) => { dispatched.push({ dd, c }); return { ok: true, result: {} }; },
        bus: { emit() {} }, config: { VOICE_MAX_TOOL_ITERATIONS: 1 },
        // The real catalog comes from the hub; without note_take in it the call is
        // refused as an unknown tool and this test would pass for the wrong reason.
        hub: { catalog: () => [{ name: 'note_take', description: 'Write a note.', params: { title: 'string', text: 'string' } }] },
      });
      await agent.handleUtterance({ text: utterance, ctx: { connectionId: 'conn-1' } });
      return dispatched;
    };
    assert.equal((await run('November')).length, 0);
    const asked = await run('Please take a note: the operator was unwell yesterday and needs rest.');
    assert.equal(asked.length, 1, 'ADJACENT, and the proof the catalog reached the tool at all');
    assert.equal(verifyConsent(asked[0].c.consent, 'note_take', NOTE).basis, 'operator-request');
  });
});

describe('residual (i) — the refusal tells the model to read back, and forbids the unbacked claim', () => {
  it('(q1) Live: nothing is saved, do not say it is kept, ask this exact question', async () => {
    const h = live();
    const text = "Don't repeat the email list every time.";
    const res = await h.call('remember', { text }, 'You don\'t have to repeat that every time.');
    assert.equal(res.status, 'needs_operator_yes');
    assert.match(res.message, /nothing is saved/i);
    assert.match(res.message, /Do not say you will keep it/i, '09-25 02:14: "I\'ll keep that in mind" was said and nothing backed it');
    assert.ok(res.message.includes(`Shall I remember this: '${text}'?`));
    const typed = createTypedMemoryGate().hold({ tool: 'remember', args: { text } }, 'You don\'t have to repeat that every time.', 'c');
    assert.match(typed.refuse, /nothing is saved/i);
    assert.match(typed.refuse, /Do not say you will keep it/i);
  });
});

describe('residual (ii) — a spoken "no" to a spoken proposal does not provoke a new turn', () => {
  it('(c1) the proposal is cancelled, and no cancel notice is injected (Gemini answers every injection as a turn)', async () => {
    const h = live();
    await h.call('remember', { text: "Don't repeat the email list every time." }, 'You don\'t have to repeat that every time.');
    await h.end('You don\'t have to repeat that every time.', 'Got it.');
    await h.end('No, forget it.', 'Okay.');
    assert.deepEqual(h.notices.filter((t) => /Cancelled/.test(t)), [], 'before this change: "The operator said no. Cancelled: remember."');
    await h.end('Yes.', 'Sure.');
    assert.equal(h.dispatched.length, 0, 'and the cancel stands: a later yes writes nothing');
  });

  it('(c2) ADJACENT: a click confirm the operator cancels by voice is still reported, as before', async () => {
    const leashCheck = { allow: true, requireConfirm: true, tier: 3, reason: 'tier-3-confirm' };
    const confirm = createConfirmRegistry({ config: { LEASH_CONFIRM_TTL_MS: 120000 } });
    const notices = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => leashCheck, confirm }, dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit() {} }, logger: { warn() {}, info() {} }, connectionId: 'conn-464b',
      memory: { working: { tick: 1 }, episodic: { write() {} }, audit: { write() {} } },
      historyAppend: () => {}, reflection: null, summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => notices.push(t) }), toolAckDeadlineMs: 500,
    });
    await adapter.handleLiveToolCalls([{ id: 'x1', name: 'gmail_send', args: { to: 'a@b.c' } }],
      { sendToolResponse: () => {}, userTextSoFar: 'send it', typedTextSoFar: '' });
    adapter.onLiveTurnComplete({ userText: 'No, cancel that.', assistantText: '', turnId: 1, typedText: '', ...HEARD });
    assert.equal(notices.filter((t) => /Cancelled: gmail_send/.test(t)).length, 1);
  });
});

describe('background writers about the operator — off unless MEMORY_AUTO_USER_FACTS is exactly "true"', () => {
  const { autoOperatorFactsOn } = require('../src/core/memory/auto-operator-facts');

  it('(s1) one predicate: only the exact string "true" turns it on', () => {
    assert.equal(autoOperatorFactsOn({ MEMORY_AUTO_USER_FACTS: 'true' }), true);
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE', 'true ', ' true']) {
      assert.equal(autoOperatorFactsOn({ MEMORY_AUTO_USER_FACTS: v }), false, String(v));
    }
  });

  function reflectionRig(env) {
    const writes = []; let thinks = 0;
    const { createReflection } = require('../src/core/identity/reflection');
    const reflection = createReflection({
      brain: { think: async () => { thinks += 1; return { parsed: { preferences: ['Prefers short spoken answers'], style: 'terse and direct', profile: 'Is working on bugs 439 and 441.\nWorks late.' } }; } },
      memory: { episodic: { recall: () => Array.from({ length: 6 }, (_, i) => ({ record: { summary: 'turn ' + i } })) }, identity: { readRaw: () => '' } },
      identity: {
        learn: async (e) => { writes.push('learn:' + e.text); return { ref: 'r' }; },
        setOperatorStyle: () => { writes.push('style'); return { ok: true }; },
        setOperatorProfile: () => { writes.push('profile'); return { ok: true }; },
        getOperatorProfile: () => '',
      },
      logger: { info() {}, warn() {} }, env,
    });
    return { reflection, writes, thinks: () => thinks };
  }

  it('(r1) reflection writes no preference, style or profile by default — and asks no model', async () => {
    const off = reflectionRig({});
    const res = await off.reflection.runNow('cadence');
    assert.deepEqual(off.writes, [], 'before this change: learn + style + profile, every ~15 turns');
    assert.equal(off.thinks(), 0, 'the conversation is not even sent to a model');
    assert.equal(res.skipped, 'auto-operator-facts-off');
    const on = reflectionRig(ON);
    await on.reflection.runNow('cadence');
    assert.deepEqual(on.writes, ['learn:Prefers short spoken answers', 'style', 'profile'], 'ADJACENT: "true" restores it exactly');
  });

  it('(r2) the action-outcome pass is not about the operator and is unchanged by the switch', async () => {
    const { createReflection } = require('../src/core/identity/reflection');
    let thinks = 0;
    const r = createReflection({ brain: { think: async () => { thinks += 1; return { parsed: { failures: [], successes: [] } }; } },
      memory: { episodic: { recall: () => Array.from({ length: 6 }, () => ({ record: { outcome: 'ok', summary: 'x' } })) } },
      identity: {}, logger: { info() {}, warn() {} }, env: {} });
    await r.reflectOnActions('test');
    assert.equal(thinks, 1);
  });

  // OPERATOR DECISION 2026-10-06 (second): habits STAY ON — "this will be your PA"
  // — but only behaviour genuinely repeated: at least 3 plays on at least 2
  // different local days. The "listens to lofi" fact came from lofi played while
  // TESTING "play the second/third video", all in one sitting.
  const { createHabitPromoter } = require('../src/core/memory/habit-promoter');
  const DAY = 24 * 3600 * 1000;
  const T0 = new Date(2026, 9, 6, 10, 0, 0).getTime();
  function promoter(extra) {
    const writes = []; let t = T0;
    const p = createHabitPromoter(Object.assign({ semantic: { write: (topic, facts) => { writes.push(facts[0]); return { ref: topic }; } },
      now: () => t }, extra));
    return { p, writes, at: (ms) => { t = ms; } };
  }

  it('(h1) three plays in ONE day promote nothing — a test session is not a taste', () => {
    const h = promoter({ env: ON }); // the switch ON, so only the day rule can hold it back
    for (let i = 0; i < 5; i++) { h.at(T0 + i * 60000); h.p.observe('spotify_play', { query: 'lofi' }, true); }
    assert.deepEqual(h.writes, [], 'before this change: promoted on the third play, the 09-xx test session');
  });

  it('(h2b) three plays over TWO local days promote, with the switch unset (habits stay on)', () => {
    const h = promoter({ env: {} });
    h.at(T0); h.p.observe('spotify_play', { query: 'Radiohead' }, true);
    h.at(T0 + 3600000); h.p.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.deepEqual(h.writes, []);
    h.at(T0 + DAY); h.p.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.equal(h.writes.length, 1);
    assert.match(h.writes[0], /radiohead/i);
  });

  it('(h3) two plays on two days are not three: the count still applies', () => {
    const h = promoter({ env: ON });
    h.at(T0); h.p.observe('spotify_play', { query: 'Radiohead' }, true);
    h.at(T0 + DAY); h.p.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.deepEqual(h.writes, []);
  });

  it('(h4) the days survive a restart: a fresh promoter reads them from Episodic (the plays already on record)', () => {
    const rec = (ts, q) => ({ record: { kind: 'action', ts, outcome: 'ok', summary: 'spotify_play(' + JSON.stringify({ query: q }) + ')' } });
    const yesterday = [rec(T0 - DAY, 'Radiohead'), rec(T0 - DAY + 60000, 'Radiohead')];
    const sameDay = [rec(T0 - 120000, 'lofi'), rec(T0 - 60000, 'lofi')];
    const episodic = (rows) => ({ recall: () => rows });
    // The current play is on record before observe() runs: dispatch-action writes Episodic (step 3) before it calls observe (4.5).
    const a = promoter({ episodic: episodic([...yesterday, rec(T0, 'Radiohead')]) });
    a.p.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.equal(a.writes.length, 1, 'yesterday\'s two plays + today\'s = a habit, across a restart');
    const b = promoter({ episodic: episodic([...sameDay, rec(T0, 'lofi')]) });
    b.p.observe('spotify_play', { query: 'lofi' }, true);
    assert.deepEqual(b.writes, [], 'three plays in one sitting, read back from Episodic, are still one day');
    const c = promoter({ episodic: episodic([rec(T0 - DAY, 'Radiohead'), { record: { kind: 'action', ts: T0 - DAY, outcome: 'fail', summary: 'spotify_play({"query":"Radiohead"})' } }, rec(T0, 'Radiohead')]) });
    c.p.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.deepEqual(c.writes, [], 'a failed play is not a play');
  });

  it('(h2) step 3b and the shared predicate give one answer for every value (two routes, one answer)', () => {
    const src = fs.readFileSync(path.join(SRC, 'core', 'memory', 'index.js'), 'utf8');
    assert.match(src, /process\.env\.MEMORY_AUTO_USER_FACTS !== 'true'/, 'step 3b still gates on the literal');
    for (const v of [undefined, 'true', 'TRUE', '1', 'true ']) {
      assert.equal(autoOperatorFactsOn({ MEMORY_AUTO_USER_FACTS: v }), v === 'true', String(v));
    }
  });
});

describe('derived sets — a new writer cannot slip in unclassified (gate D)', () => {
  // Every call into a store that keeps a durable record about the operator:
  // Semantic memory, the identity's operator files, the notes store, pc-child's
  // NOVA-Notes. Selected by the writer API, not by a list of files.
  const WRITER_RE = /\bsemantic\.write\(|\bidentity\.learn\(|\.setOperatorStyle\(|\.setOperatorProfile\(|\bnotes\.write\(|cmd: 'write_note'/;
  // file -> how each of its writers is gated. 'consent' = verifyConsent in the
  // same file; 'switch' = autoOperatorFactsOn or the step-3b literal; anything else
  // is a waiver whose text says why.
  const CLASSIFIED = {
    'core/effectors/from-memory.js': 'consent', // remember, note_take; log_incident's 'incidents' write is waived below by snippet
    'core/effectors/from-pc.js': 'consent',
    'core/identity/reflection.js': 'switch',
    'core/memory/habit-promoter.js': 'repetition', // operator decision 2026-10-06: on, but only repeated behaviour
    'core/memory/index.js': 'switch', // step 3b; steps 3 and 3c are classified below by snippet
  };
  const WAIVED_SNIPPETS = {
    "semantic.write('incidents'": 'log_incident: a record of a MYTHOS fault the operator reported, not a claim about the operator',
    "semantic.write('consolidated-' + Date.now(), mergedFacts": 'step 3c merge: rewrites records that already exist; adds no new claim',
  };
  // Step 3 stays on (operator decision 2026-10-06) because what it writes is
  // screened: its write must be of the screened text, never the raw distillation.
  const SCREENED_SNIPPETS = { "semantic.write('consolidated-' + Date.now(), [screened.kept]": /withoutOperatorLines\(/ };

  it('(d1) every durable writer is gated by consent or the switch, or waived with a reason', () => {
    const unclassified = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const rel = path.relative(SRC, p).replace(/\\/g, '/');
        const src = fs.readFileSync(p, 'utf8');
        src.split('\n').forEach((line, i) => {
          // A comment, or a line that is string content (a template's text), is not a call.
          if (/^\s*(?:\/\/|\*|['"`])/.test(line) || !WRITER_RE.test(line)) return;
          if (Object.keys(WAIVED_SNIPPETS).some((s) => line.includes(s))) return;
          const screened = Object.keys(SCREENED_SNIPPETS).find((s) => line.includes(s));
          if (screened) { if (!SCREENED_SNIPPETS[screened].test(src)) unclassified.push(rel + ':' + (i + 1) + ' unscreened'); return; }
          const how = CLASSIFIED[rel];
          const gated = how === 'consent' ? /verifyConsent\(/.test(src)
            // In memory/index.js the switch covers only step 3b's user-facts write; any other
            // write there must be screened or waived by snippet (probe P19, 2026-10-06, found
            // a raw step-3 write passing here on the file's switch alone).
            : how === 'switch' ? /autoOperatorFactsOn\(|MEMORY_AUTO_USER_FACTS !== 'true'/.test(src)
              && (rel !== 'core/memory/index.js' || line.includes("'user-facts'"))
              : how === 'repetition' ? /MIN_HABIT_DAYS/.test(src) : false;
          if (!gated) unclassified.push(rel + ':' + (i + 1) + ' ' + line.trim());
        });
      }
    })(SRC);
    assert.deepEqual(unclassified, []);
  });

  it('(d2) the gated tool set is exactly the effectors that verify a consent — derived from the effector source', () => {
    const dir2 = path.join(SRC, 'core', 'effectors');
    const verifiers = [];
    for (const f of fs.readdirSync(dir2).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir2, f), 'utf8');
      for (const m of src.matchAll(/verifyConsent\([^,]+,\s*'(\w+)'/g)) verifiers.push(m[1]);
    }
    assert.ok(verifiers.length >= 3, 'the scan found too little — it is broken, not proving anything');
    assert.deepEqual(verifiers.sort(), [...gateModule.CONSENT_TOOLS].sort());
  });
});

// OPERATOR DECISION 2026-10-06 (second), replacing the (k1) pin: step 3 stays on,
// and keeps MYTHOS's own status lines, but no line it writes may describe the
// operator — nobody asked for those.
describe('step 3 (consolidated-*) keeps MYTHOS\'s own status and drops lines about the operator', () => {
  const { describesOperator, withoutOperatorLines } = require('../src/core/memory/operator-lines');
  const SELF = ['4 active goals and 160 incidents logged.', 'MYTHOS restarted twice after a Live socket drop.',
    'The Spotify adapter was offline for an hour.'];
  const ABOUT = ['The user is currently working on bugs 439, 441 and 442.', "The operator's sister is called Priya.",
    'User prefers dark mode everywhere.', 'Sir likes lofi music in the evening.', 'The user\'s name is Alex.',
    'Prefers to be called boss.'];

  it('(o1) the classifier: every operator line is caught, every self-status line is kept', () => {
    for (const l of ABOUT) assert.equal(describesOperator(l), true, l);
    for (const l of SELF) assert.equal(describesOperator(l), false, l);
    // "user" inside another word, or MYTHOS's own users/sessions, is not the operator.
    for (const l of ['Superuser mode was disabled.', 'Reused the cached token.']) assert.equal(describesOperator(l), false, l);
  });

  it('(o2) derived, not a new word list: the referents are authority-words.js\'s names for the operator, the claims are semantic.js\'s', () => {
    const aw = fs.readFileSync(path.join(SRC, 'core', 'voice', 'authority-words.js'), 'utf8');
    const { OPERATOR_REFERENTS } = require('../src/core/memory/operator-lines');
    for (const w of OPERATOR_REFERENTS) assert.match(aw, new RegExp("'[^']*\\b" + w + "\\b[^']*'"), w + ' is in FILLER');
    const { IDENTITY_CLAIM_RE } = require('../src/core/memory/semantic');
    assert.ok(IDENTITY_CLAIM_RE instanceof RegExp, 'semantic.js exports the BUG-080 identity-claim pattern it guards with');
    assert.equal(describesOperator('Prefers to be called boss.'), IDENTITY_CLAIM_RE.test('Prefers to be called boss.'));
  });

  it('(o3) a blob of distilled lines: operator lines dropped, self lines kept in order, bullets intact', () => {
    const r = withoutOperatorLines(['- ' + SELF[0], '- ' + ABOUT[0], '- ' + SELF[1], '- ' + ABOUT[1]].join('\n'));
    assert.equal(r.kept, ['- ' + SELF[0], '- ' + SELF[1]].join('\n'));
    assert.equal(r.dropped, 2);
  });

  async function consolidateWith(content) {
    const { createMemory } = require('../src/core/memory/index');
    const { createBus } = require('../src/core/bus');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug464-step3-'));
    const events = [];
    const bus = createBus({ historySize: 100 });
    bus.subscribe('memory.consolidate-skip', (e) => events.push(e.payload)); // the existing diagnostic event, not a new name
    try {
      const memory = createMemory({ config: { MYTHOS_VAULT_ROOT: root }, bus, logger: { debug() {}, info() {}, warn() {}, error() {} },
        brain: { think: async (req) => (req.source === 'memory:consolidate' ? { content } : { offline: true }) } });
      await memory.init();
      for (let i = 0; i < 3; i++) memory.episodic.write({ kind: 'conversation', summary: 'User: status ' + i + ' | MYTHOS: ok', salience: 0.9 });
      await memory.consolidate({});
      const sem = path.join(root, 'Semantic');
      const files = fs.existsSync(sem) ? fs.readdirSync(sem).filter((f) => f.startsWith('consolidated-')) : [];
      const text = files.map((f) => fs.readFileSync(path.join(sem, f), 'utf8')).join('\n');
      return { files, text, events };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  it('(x1) through a real consolidation: self-status lines land in consolidated-*, the operator line does not', async () => {
    const r = await consolidateWith([SELF[0], ABOUT[0], SELF[1]].join('\n'));
    assert.equal(r.files.length, 1, 'step 3 stays on');
    assert.ok(r.text.includes(SELF[0]) && r.text.includes(SELF[1]));
    assert.ok(!r.text.includes('bugs 439'), 'before this change: the operator line was written with the rest');
    const dropped = r.events.find((e) => e.reason === 'operator-lines-dropped');
    assert.equal(dropped && dropped.count, 1, 'the drop is counted on the bus, without the dropped text');
    assert.ok(!JSON.stringify(r.events).includes('439'), 'no operator text in the event');
  });

  it('(x2) a distillation that is ONLY about the operator writes no file at all', async () => {
    const r = await consolidateWith([ABOUT[0], ABOUT[2]].join('\n'));
    assert.deepEqual(r.files, []);
  });

  it('(x3) ADJACENT: a pure self-status distillation is written exactly as before', async () => {
    const r = await consolidateWith(SELF.join('\n'));
    assert.equal(r.files.length, 1);
    for (const l of SELF) assert.ok(r.text.includes(l), l);
    assert.ok(!r.events.some((e) => e.reason === 'operator-lines-dropped'));
  });
});
