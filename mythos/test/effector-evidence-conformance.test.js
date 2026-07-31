'use strict';

// Wave 0 gate for the evidence contract (src/core/effectors/evidence.js).
//
// The root defect: every effector returned "the API call succeeded" and the
// voice layer spoke it as "the thing happened". Fixing tools one at a time
// whacked one symptom and the next session surfaced the sibling — four times.
// This file is the gate that stops the pattern re-entering with the next tool.
//
// TWO HALVES, deliberately:
//
//   1. The contract itself (verifiedOk / unverified / mismatch / isVerified).
//      Fully live from Wave 0.
//   2. A BEHAVIOURAL sweep: drive each world-changing effector with a mock that
//      returns the naive "the call worked" payload the real adapter returns,
//      and require the result to carry either real evidence or an honest
//      unverified:true. Entries in MIGRATION_LEDGER below are skipped by this
//      sweep until their wave lands.
//
// The ledger is the visible debt. It starts holding every world-changing tool
// (at Wave 0 none of them can prove anything yet) and each later wave DELETES
// its entry, which is what switches the behavioural half on for that tool.
// Deleting an entry without making the tool honest turns this file red — that
// is the point. Do not add an entry to make a red test green.
//
// NOTE ON `danger`: the tool definitions already carry a `danger` flag, and it
// is NOT usable as this list. ui_type and send_key — the two effectors that
// produced the 2026-07-31 fabrications — are both danger:false, because that
// flag means "needs confirmation / irreversible", not "reports success it
// cannot prove". The two properties are orthogonal, hence an explicit list.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const evidence = require('../src/core/effectors/evidence');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

// ---------------------------------------------------------------------------
// The world-changing set: effectors that alter something outside this process
// and therefore cannot honestly report ok:true on their own say-so.
// ---------------------------------------------------------------------------
const WORLD_CHANGING = [
  'ui_type', 'send_key', 'ui_click', 'focus_window', 'launch_app',
  'spotify_play', 'whatsapp_send',
];

// name -> why it cannot prove itself YET, and which wave removes this entry.
const MIGRATION_LEDGER = {
  // ui_type RETIRED in Wave 2: reads the focused control back via
  // ValuePattern/TextPattern (test/ui-type-readback.test.js).
  // send_key RETIRED in Wave 2: bare Enter in a messaging app requires a
  // preceding verified type (test/send-key-messaging-guard.test.js).
  ui_click: 'Wave 7 — a click has no oracle of its own; it is verified by what it produced (editable focus, then read-back).',
  focus_window: 'Wave 2 verifies foreground via the foreground-pid oracle; today ok:true means the focus call returned.',
  // launch_app RETIRED in Wave 1: ps-automation.ps1 no longer resolves by window
  // title, and from-pc.js reports the process-window oracle or an honest
  // unverified. See test/launch-resolution-no-title-fallback.test.js.
  spotify_play: 'Wave 5 compares nowPlaying/media_status against the request; today verified:true only means the CLICK verified.',
  whatsapp_send: 'Wave 7/8 route sending through app_reply + a spoken confirm over verified read-back text.',
};

// Naive adapter payloads — exactly the shape that made MYTHOS lie: a truthful
// report that the CALL succeeded, with nothing about the world.
function naivePcChild() {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      switch (cmdObj.cmd) {
        case 'focus_window': return { ok: true, result: { focused: true, pid: cmdObj.pid || 4242 } };
        case 'ui_type': return { ok: true, result: { typed: true, length: 5, typedIntoPid: cmdObj.pid || 4242, typedIntoTitle: 'Untitled - Notepad' } };
        case 'send_key': return { ok: true, result: { sent: true, key: cmdObj.key } };
        case 'ui_click': return { ok: true, result: { clicked: true } };
        case 'launch_app': return { ok: true, result: { pid: 4242, name: cmdObj.name, resolved: true, matchedBy: 'process' } };
        case 'list_windows': return { ok: true, result: { windows: [{ pid: 4242, title: 'Untitled - Notepad', process: 'notepad' }] } };
        default: return { ok: true, result: {} };
      }
    },
  };
}

const originalRequire = Module.prototype.require;
function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

// How to exercise each from-pc tool. Tools living in other modules are driven
// by their own wave's tests once they leave the ledger.
const PC_INVOCATIONS = {
  ui_type: (m) => m.ui_type({ text: 'hello', pid: 4242 }),
  send_key: (m) => m.send_key({ key: 'enter' }),
  ui_click: (m) => m.ui_click({ pid: 4242, elementPath: ['0'] }),
  focus_window: (m) => m.focus_window({ pid: 4242 }),
  launch_app: (m) => m.launch_app({ name: 'notepad' }),
};

// ---------------------------------------------------------------------------
describe('evidence contract — verifiedOk / unverified / mismatch', () => {
  it('verifiedOk attaches an oracle-named evidence field and marks the result proven', () => {
    const r = evidence.verifiedOk({ typed: true }, {
      oracle: 'read-back', expected: 'Hi Alex', observed: 'Hi Alex',
    });
    assert.equal(r.ok, true);
    assert.equal(r.unverified, false);
    assert.equal(r.evidence.oracle, 'read-back');
    assert.equal(r.evidence.observed, 'Hi Alex');
    assert.equal(r.evidence.expected, 'Hi Alex');
    assert.equal(r.typed, true, 'the original result fields must survive');
    assert.equal(evidence.isVerified(r), true);
  });

  it('verifiedOk does not mutate the result it was handed', () => {
    const original = { typed: true };
    evidence.verifiedOk(original, { oracle: 'ocr', observed: 'Hi Alex' });
    assert.deepEqual(original, { typed: true }, 'input must be treated as immutable');
  });

  it('verifiedOk REFUSES an oracle that is just the call itself', () => {
    // The whole failure mode in one assertion: "the API returned ok" is not an
    // oracle, and trying to register it as one must be a loud programmer error
    // rather than a quietly-accepted tick.
    assert.throws(() => evidence.verifiedOk({}, { oracle: 'sendinput-accepted', observed: '46 events' }),
      /unknown oracle/);
    assert.throws(() => evidence.verifiedOk({}, { oracle: '', observed: 'x' }), /unknown oracle/);
  });

  it('verifiedOk REFUSES an oracle that observed nothing', () => {
    assert.throws(() => evidence.verifiedOk({}, { oracle: 'ocr', observed: '' }), /produced no observation/);
    assert.throws(() => evidence.verifiedOk({}, { oracle: 'ocr', observed: '   ' }), /produced no observation/);
  });

  it('unverified stays ok:true — attempted is not the same as failed', () => {
    // Collapsing "cannot prove it" into ok:false would make MYTHOS deny things
    // it actually did, which is its own kind of lying.
    const r = evidence.unverified({ typed: true }, 'no readable text pattern');
    assert.equal(r.ok, true);
    assert.equal(r.unverified, true);
    assert.equal(r.reason, 'no readable text pattern');
    assert.equal(evidence.isVerified(r), false, 'unverified must never read as proven');
  });

  it('unverified always carries a spoken-usable reason, even when given none', () => {
    const r = evidence.unverified({}, '');
    assert.equal(r.unverified, true);
    assert.match(r.reason, /\S/);
  });

  it('mismatch is a failure and reports BOTH strings', () => {
    const r = evidence.mismatch({}, { oracle: 'read-back', expected: 'Hi Alex', observed: 'Hi Alexx' });
    assert.equal(r.ok, false);
    assert.equal(r.expected, 'Hi Alex');
    assert.equal(r.observed, 'Hi Alexx');
    assert.match(r.error, /Hi Alex/);
    assert.match(r.error, /Hi Alexx/);
    assert.equal(evidence.isVerified(r), false);
  });

  it('isVerified rejects a forged evidence field', () => {
    // A tool cannot earn a tick by inventing the shape by hand.
    assert.equal(evidence.isVerified({ ok: true, evidence: { oracle: 'vibes', observed: 'looks right' } }), false);
    assert.equal(evidence.isVerified({ ok: true, evidence: { oracle: 'ocr', observed: '' } }), false);
    assert.equal(evidence.isVerified({ ok: true }), false, 'bare ok:true is exactly the old lie');
    assert.equal(evidence.isVerified({ ok: false, evidence: { oracle: 'ocr', observed: 'x' } }), false);
    assert.equal(evidence.isVerified(null), false);
  });

  it('attemptedPhrase reads as speech, not as an error code', () => {
    const said = evidence.attemptedPhrase('sent the keystrokes', 'no readable text pattern');
    assert.match(said, /could not confirm/i);
    assert.match(said, /no readable text pattern/);
  });
});

// ---------------------------------------------------------------------------
describe('evidence contract — world-changing effector conformance', () => {
  it('every world-changing tool is a real, tiered tool (catches a rename)', () => {
    const unknown = WORLD_CHANGING.filter((name) => TIER_TABLE[name] === undefined).sort();
    assert.deepEqual(unknown, [],
      'named in WORLD_CHANGING but absent from TIER_TABLE — either renamed or never existed, ' +
      'so this gate has been silently watching nothing: ' + unknown.join(', '));
  });

  it('the migration ledger describes only real world-changing tools', () => {
    const stray = Object.keys(MIGRATION_LEDGER).filter((n) => WORLD_CHANGING.indexOf(n) === -1).sort();
    assert.deepEqual(stray, [],
      'exempted but not in WORLD_CHANGING — an exemption for a tool this gate never ' +
      'checked is how the pattern sneaks back in: ' + stray.join(', '));
  });

  it('every ledger entry states which wave retires it', () => {
    const vague = Object.keys(MIGRATION_LEDGER)
      .filter((n) => !/Wave\s*\d/i.test(MIGRATION_LEDGER[n]))
      .sort();
    assert.deepEqual(vague, [],
      'ledger entries must name the wave that removes them, otherwise the debt is ' +
      'permanent and invisible: ' + vague.join(', '));
  });

  it('sanity: the behavioural sweep can actually drive from-pc (never passes vacuously)', async () => {
    await withMockedPcChild(naivePcChild(), async (m) => {
      const r = await m.ui_type({ text: 'hello', pid: 4242 });
      assert.ok(r && typeof r === 'object', 'ui_type must return a result object through the mock');
    });
  });

  for (const name of WORLD_CHANGING) {
    if (!PC_INVOCATIONS[name]) continue;

    const ledgered = Object.prototype.hasOwnProperty.call(MIGRATION_LEDGER, name);
    const title = ledgered
      ? `${name}: still on the ledger — ${MIGRATION_LEDGER[name].split('.')[0]}`
      : `${name} returns evidence or an honest unverified:true, never a bare ok:true`;

    it(title, async () => {
      if (ledgered) return; // switched on by deleting this tool's ledger entry

      await withMockedPcChild(naivePcChild(), async (m) => {
        const r = await PC_INVOCATIONS[name](m);
        if (r.ok !== true) return; // an honest failure needs no evidence

        assert.ok(
          evidence.isVerified(r) || r.unverified === true,
          `${name} returned ok:true with neither evidence nor unverified:true. This is the ` +
          `root defect: the adapter confirmed the CALL, and nothing confirmed the WORLD. ` +
          `Got: ${JSON.stringify(r)}`
        );
        if (r.unverified === true) {
          assert.match(String(r.reason || ''), /\S/, `${name}'s unverified result must say why`);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The contract is worthless if `unverified` is dropped between the effector and
// the surfaces the operator actually perceives — the spoken reply, the Agent
// Actions panel, and the audit trail that made this whole diagnosis possible.
// ---------------------------------------------------------------------------
describe('evidence contract — unverified survives the trip to the operator', () => {
  const { dispatchAction } = require('../src/core/effectors/dispatch-action');

  function run(result) {
    const events = [];
    const audits = [];
    return dispatchAction(
      { tool: 'ui_type', args: { text: 'Hi Alex' } },
      {
        effectors: { invoke: async () => result, breakers: { allow: () => true } },
        bus: { emit: (type, payload) => { events.push({ type, payload }); }, subscribe: () => () => {} },
        memory: {
          audit: { write: (e) => { audits.push(e); } },
          episodic: { write: async () => ({ ref: 'ep-1' }) },
        },
        goals: null, config: {}, goalId: null, tier: 1, channel: 'voice',
      }
    ).then(() => ({
      completed: events.find((e) => e.type === 'action.completed'),
      audit: audits[0],
    }));
  }

  it('an unverified effector result reaches action.completed with its reason intact', async () => {
    const { completed, audit } = await run(
      evidence.unverified({ result: { typed: true } }, 'no readable text pattern')
    );
    assert.ok(completed, 'action.completed must still be emitted');
    assert.equal(completed.payload.ok, true, 'unverified is not a failure');
    assert.equal(completed.payload.unverified, true,
      'dropping this field is what let the HUD tick three ui_type calls into an empty Notepad');
    assert.match(String(completed.payload.reason), /no readable text pattern/);
    assert.equal(audit.unverified, true, 'the audit trail must be able to answer "did it really happen?"');
    assert.match(String(audit.reason), /no readable text pattern/);
  });

  it('a verified result is not tainted with unverified, and leaves the audit line clean', async () => {
    const { completed, audit } = await run(
      evidence.verifiedOk({ result: { typed: true } }, { oracle: 'read-back', expected: 'Hi Alex', observed: 'Hi Alex' })
    );
    assert.equal(completed.payload.ok, true);
    assert.equal(completed.payload.unverified, false);
    assert.equal(audit.unverified, undefined,
      'absent rather than false — these JSONL lines persist forever and stay grep-able');
    assert.equal(audit.outcome, 'ok', 'the existing outcome vocabulary must not shift under AD-4');
  });

  it('a genuine failure is still a failure, not downgraded to unverified', async () => {
    const { completed, audit } = await run({ ok: false, result: 'Type failed: SendInput injected 0 events' });
    assert.equal(completed.payload.ok, false);
    assert.equal(completed.payload.unverified, false);
    assert.equal(audit.outcome, 'fail');
  });

  it('the voice RULES forbid speaking an unverified action as done (both batch and Live read this)', () => {
    const { RULES } = require('../src/core/voice/voice-agent');
    assert.match(RULES, /EVIDENCE RULE/, 'the rule must exist in the shared RULES block');
    assert.match(RULES, /"unverified":\s*true/, 'the rule must name the actual field the model will see');
    assert.match(RULES, /\bevidence\b/i, 'the rule must tell the model what proof looks like');
    // The specific fabrication from 2026-07-31: "I have successfully typed..."
    assert.match(RULES, /never "done"|never “done”/i,
      'the rule must explicitly forbid the completion verbs, not merely encourage caution');
  });
});
