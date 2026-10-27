'use strict';

// bug-273-d3-system-notice-logged.test.js — BUG-273 D3.
//
// D3 AS FILED: *"rambling on by yourself"* with no operator input, MYTHOS logging
// its own corrective ("cease speaking immediately"), 61 turns in 10 minutes, turn 1
// `systemInitiated:true`. The ask was "audit what opens a turn with no operator
// utterance".
//
// THE AUDIT, run against the real log the complaint came from
// (mythos-server.log, 2026-08-18T11:32–11:50):
//
//     61  turns
//     26  systemInitiated:true            <- 43% of the conversation was MYTHOS
//                                            answering MYTHOS
//     18  of those had a tool-call batch since the previous turn
//      8  had NO tool call anywhere
//      6  chains of 2-3 CONSECUTIVE system-initiated turns
//
// ...and nothing in the log could say why any of them happened. `systemInitiated`
// is recorded by live-session.js on the turn AFTER the fact; it cannot name what
// injected the text. There are THIRTEEN call sites — six in live-tool-adapter.js
// (late outcomes, confirm resolutions, voice cancels, late-for-turn actions, two
// kinds of AD-4 self-correction) and seven in server/index.js (proactive speech,
// the boot greeting, replies routed into Live, and the HUD text box) — all calling
// one unlabelled function.
//
// AND ONE OF THE THIRTEEN IS NOT US AT ALL. The HUD text box routes the operator's
// typed words through the same `sendText`, so every typed message was marked
// system-initiated. That is not cosmetic: `turnSystemInitiated` is the guard on the
// half-blind-transcript anomaly, so those turns were exempted from the one monitor
// that notices when the operator was not heard — the monitor A2 exists to serve.
// A count inflated by operator input, and a check silenced on operator input, from
// the same missing argument.
//
// THE FIX IS ONE ARGUMENT AND ONE LOG LINE, AT THE ONE DOOR. `sendText` is the only
// way text enters a Live session in this process, so instrumenting it covers all
// thirteen — including the seven live-tool-adapter.js cannot see. Instrumenting the
// adapter's own helper instead would have covered six, and **a partial log of what
// starts a turn is worse than none: the gaps read as "nothing happened"** — the same
// trap as the verifier criterion that could never fire (BUG-273, `8d61547`).
//
// Q8 — WHAT THIS DELIBERATELY DOES NOT DO: change when anything is sent. The
// candidate fix is coalescing — `reportLateOutcome` is per-tool with no batching, so
// two slow tools finishing together produce two injections and therefore two spoken
// turns, which is consistent with those 2-3 chains. Consistent is not demonstrated,
// and the conversational path is exactly where this repo has traded one bug for
// another before (BUG-272 V1 -> V2). Two `live.text-injected` lines inside one turn
// gap is the proof, and now it can be read.
//
// Q2 — the text is NOT logged. These strings carry tool results, message bodies and
// whatever the operator typed. Site, class and length attribute a turn; the content
// already lives in the audit vault under its own rules.
//
// Run: cd mythos && node --test test/bug-273-d3-system-notice-logged.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLiveToolAdapter, SYSTEM_NOTICE_PREFIX,
} = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

const VOICE_DIR = path.join(__dirname, '..', 'src', 'core', 'voice');
const stripComments = (t) => t.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const readSrc = (p) => stripComments(fs.readFileSync(p, 'utf8'));

// BUG-432 (2026-09-10) MOVED THE DOOR AND THESE ASSERTIONS FOLLOWED IT, WHICH IS
// WHY THEY ARE NOW WRITTEN DIFFERENTLY. Serialising notices split the door in
// two: sendText decides WHETHER a frame goes now, sendNoticeFrame does the
// sending. The log line and the turnSystemInitiated flag went with the frame,
// because a queued notice has to carry the same effects as an immediate one and
// live.text-injected has to keep meaning "spoken now". These three tests read a
// slice of source, so all three went red on a change that broke none of the
// invariants they exist to protect — the brittleness of a source-shape window,
// which this repo has hit before.
//
// So the window is the whole injection region, and the one-door property is now
// asserted DIRECTLY (exactly one live.text-injected line in the file, and
// sendText reaching the wire only through the frame function) instead of being
// implied by the log happening to sit inside one particular function. That is
// stronger than what it replaced: the old slice would have been satisfied by a
// second injector elsewhere in the file.
const injectionRegion = (src) => src.slice(src.indexOf('function sendNoticeFrame('), src.indexOf('function sendToolResponse('));
// The log PAYLOAD moved with the same change, into notice-queue.js, because
// live-session.js is at its file-size ratchet ceiling. Two of these three tests
// read the payload rather than the call, so they follow it — and the invariant is
// tightened on the way: injectionFields must be the ONLY builder, so a second
// inline payload cannot reintroduce the raw text behind this guard.
const payloadOwner = () => { const src = readSrc(path.join(VOICE_DIR, 'notice-queue.js')); return src.slice(src.indexOf('function injectionFields('), src.indexOf('function createNoticeQueueFromEnv(')); };

// A slow tool, so the outcome lands through reportLateOutcome after the turn has
// closed — the production path, driven the way production drives it rather than by
// reaching for an unexported function.
const SLOW_TOOL = 'launch_app';

function harness(opts = {}) {
  const sent = [];
  const logs = [];
  const session = {
    isOpen: () => (opts.open === undefined ? true : opts.open),
    sendText: (text, meta) => { sent.push({ text, meta }); return true; },
  };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-273', reject: () => {} },
    },
    dispatchAction: opts.dispatchAction || (async () => ({ ok: true, result: {} })),
    bus: { emit() {} },
    logger: { warn() {}, info: (msg, fields) => logs.push({ msg, fields }) },
    connectionId: 'conn-273', toolResultHoldMaxMs: 0, // BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
  });
  return { adapter, sent, logs, session };
}

// Drive one slow tool through the real entry point and wait for its late outcome.
async function runSlowTool(h, outcome) {
  await h.adapter.handleLiveToolCalls(
    [{ id: 'c1', name: SLOW_TOOL, args: { name: 'wt' } }],
    { sendToolResponse: () => {} },
  );
  // the late path resolves on its own microtask chain
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  return outcome;
}

describe('BUG-273 D3 — every turn MYTHOS starts itself is attributable', () => {
  test('a late outcome names its site, its tool and its claim class', async () => {
    const h = harness({ dispatchAction: async () => ({ ok: true, result: { launched: true } }) });
    await runSlowTool(h);

    const injected = h.sent.filter((s) => s.meta);
    assert.ok(injected.length >= 1, 'the injection that provokes a spoken turn must carry attribution');
    const meta = injected[injected.length - 1].meta;
    assert.equal(meta.site, 'late-outcome',
      'WHICH site — systemInitiated:true on the next turn cannot say, and there are thirteen');
    assert.equal(meta.tool, SLOW_TOOL);
    assert.equal(meta.claim, 'ok');
  });

  test('the claim class distinguishes failed / unverified / partial — B1 and B2 turned on exactly this', async () => {
    const failed = harness({ dispatchAction: async () => ({ ok: false, result: { error: 'no browser' } }) });
    await runSlowTool(failed);
    assert.equal(failed.sent.filter((s) => s.meta).pop().meta.claim, 'failed');

    const unproven = harness({ dispatchAction: async () => ({ ok: true, unverified: true, reason: 'no oracle' }) });
    await runSlowTool(unproven);
    assert.equal(unproven.sent.filter((s) => s.meta).pop().meta.claim, 'unverified');

    const partial = harness({ dispatchAction: async () => ({
      ok: true, unverified: true, reason: 'nothing observed the window',
      confirmedStep: 'the process started',
    }) });
    await runSlowTool(partial);
    assert.equal(partial.sent.filter((s) => s.meta).pop().meta.claim, 'unverified-partial',
      'B2 exists because "no proof either way" and "this half IS proven" are different facts');
  });

  test('a notice that could NOT be delivered is still recorded', async () => {
    // "the outcome never reached the model" and "the model was told and said nothing"
    // are different failures that used to look identical from outside this module.
    const h = harness({ open: false, dispatchAction: async () => ({ ok: true, result: {} }) });
    await runSlowTool(h);
    assert.equal(h.sent.length, 0, 'nothing on the wire');
    const missed = h.logs.filter((l) => l.msg === 'live.system-notice' && l.fields.delivered === false);
    assert.equal(missed.length, 1, 'silence must be recorded as silence, not as nothing');
    assert.match(String(missed[0].fields.reason), /no open live session/);
  });

  test('the wire format is unchanged — BUG-117\'s prefix still leads every injection', async () => {
    const h = harness({ dispatchAction: async () => ({ ok: true, result: {} }) });
    await runSlowTool(h);
    const injected = h.sent.filter((s) => s.meta).pop();
    assert.ok(injected.text.startsWith(SYSTEM_NOTICE_PREFIX),
      'still self-describing, still first — Gemini attributes this frame to the user, '
      + 'and routing six sites through one helper must not quietly reword them');
  });
});

describe('BUG-273 D3 — one door, and it knows who knocked', () => {
  test('live-session has exactly ONE injector, and it logs every call', () => {
    const src = readSrc(path.join(VOICE_DIR, 'live-session.js'));
    // One door, asserted as a count over the whole file rather than inferred from
    // where the line happens to sit. Two log lines would make every injection
    // count wrong, and two wire writes would make the log a partial record —
    // which this file's header says is worse than no record at all.
    assert.equal((src.match(/logger\.info\('live\.text-injected'/g) || []).length, 1,
      'exactly one live.text-injected line, or the counts across thirteen sites will not mean the same thing');
    assert.equal((src.match(/realtimeInput: \{ text:/g) || []).length, 1,
      'and exactly one place that writes text to the wire');
    const fn = injectionRegion(src);
    assert.match(fn, /logger\.info\('live\.text-injected'/, 'the log belongs in the injection region');
    assert.match(fn, /injectionFields\(/, 'and the payload comes from its single owner');
    assert.match(payloadOwner(), /site:/, 'which must say WHICH site');
    // Counted on the field that could carry the payload, not on site: — the queue
    // also logs live.notice-held and live.notice-undelivered, which legitimately
    // name a site and carry no text. One chars: field means one payload builder,
    // so the doesNotMatch guard below cannot be walked around by a second one.
    assert.equal((readSrc(path.join(VOICE_DIR, 'notice-queue.js')).match(/chars:/g) || []).length, 1,
      'one payload builder — a second inline object could carry the text past the guard below');
    // sendText may decide to hold a frame, but it must not reach the wire itself.
    const door = fn.slice(fn.indexOf('function sendText('));
    assert.doesNotMatch(door, /realtimeInput/, 'sendText delegates; it does not send');
    assert.match(door, /sendNoticeFrame\(/, 'and the frame function is how it delegates');
  });

  test('the injected TEXT is never logged, only its length', () => {
    const fn = payloadOwner();
    // Scoped to the payload, not the whole function: the wire frame itself is
    // `realtimeInput: { text: String(text) }`, and a detector that cannot tell the
    // payload from the log line is the false-positive shape this repo keeps hitting
    // (my own comment matched my own detector twice in this ticket alone).
    const logArgs = fn;
    assert.match(logArgs, /chars:/, 'a length is enough to attribute a turn');
    // The invariant is "no FIELD carries the string", not "the word text does not
    // appear" — `chars: String(text).length` reads the variable and is the whole
    // point. Match a field whose VALUE is the raw text and nothing else.
    assert.doesNotMatch(logArgs, /:\s*(String\()?text\)?\s*[,}]/,
      'these strings carry tool results, message bodies and whatever the operator typed');
  });

  test('the adapter does NOT double-log what the door already logged', () => {
    // Two lines for the adapter's six sites and one for the server's seven would be a
    // worse log than none — anyone counting injections would get a wrong answer.
    const src = readSrc(path.join(VOICE_DIR, 'live-tool-adapter.js'));
    const helper = src.slice(src.indexOf('function sendSystemNotice('));
    const body = helper.slice(0, helper.indexOf('\n  }'));
    assert.doesNotMatch(body, /delivered: true/,
      'the delivered line is written at the door; only the UNDELIVERED case, which '
      + 'never reaches the door, belongs here');
  });

  test('the operator TYPING is not counted as MYTHOS talking to itself', () => {
    // The HUD text box goes through the same sendText, because the Live protocol has
    // no system role after setup. Unlabelled, it marked the turn system-initiated —
    // which is the guard on the half-blind-transcript anomaly, so a turn where the
    // operator was not heard could be exempted from the check that exists to catch it.
    const src = readSrc(path.join(__dirname, '..', 'server', 'index.js'));
    const typed = (src.match(/operator: true/g) || []).length;
    assert.ok(typed >= 3, 'all three HUD text paths must declare themselves operator input');

    const fn = injectionRegion(readSrc(path.join(VOICE_DIR, 'live-session.js')));
    assert.match(fn, /if \(!fromOperator\) turnSystemInitiated = true;/,
      'operator input must not set the flag');
    assert.match(fn, /m\.operator === true/,
      'and the default must stay "ours" — an unlabelled caller inside the pipeline IS '
      + 'the pipeline, so the safe default is to claim it, not to disown it');
  });

  test('every call site in both files passes attribution', () => {
    // Q1/no-silent-gaps: an unlabelled site logs site:"unattributed", which is honest
    // but useless. Catch them here, where the list is enumerable, rather than in a log
    // read six weeks from now.
    for (const file of [
      path.join(VOICE_DIR, 'live-tool-adapter.js'),
      path.join(__dirname, '..', 'server', 'index.js'),
    ]) {
      const src = readSrc(file);
      const calls = src.match(/\.sendText\([^;]*\)/g) || [];
      for (const call of calls) {
        assert.match(call, /site:/,
          path.basename(file) + ' has an unattributed injection: ' + call.slice(0, 90));
      }
    }
  });
});
