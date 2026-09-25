'use strict';

// BUG-234, found by the 2026-08-28 audit read of the ticket itself.
//
// BUG-234 shipped on 2026-08-14 and its closing paragraph says:
//
//     "Not done, deliberately: no playbook was added to make a `no-match` count
//      go down. A playbook that exists only to silence a log line is worse than
//      the log line."
//
// Commit ad6ad33, ONE DAY LATER, added four playbooks whose own header states
// that exact motive verbatim - "26 anomalies in the 2026-08-14 session reached
// no-match, and four kinds account for all of the recurring ones" - and the last
// of the four is for `live-tool-outcome-late-for-turn`, the very kind BUG-234
// chose to KEEP on the health channel rather than match.
//
// The header argues it is safe ("NOTHING IS HIDDEN BY THIS"), and the action is
// written to be honest: it returns `healed: false`. MEASURED 2026-08-28 by
// driving the real bus -> healer -> announcer chain, that honesty reaches nobody.
// `grep -rn "\.healed\b" src/ server/ ui/` finds NO READER. What actually happens:
//
//     > Self-healed: a Live turn that arrived with no operator transcript.
//       Trigger: live-turn-no-user-transcript. Action taken: acknowledge.
//
// spoken aloud for all four kinds, because immune/announcer.js speaks EVERY
// 'applied' outcome. And it is worse than speech: server/index.js's
// `actuallyHealed = !('outcome' in p) || p.outcome === 'applied'` puts
// `healed: true` in the anomaly log and writes an episodic row labelled
// `healed: <kind>`.
//
// THAT IS THE SAME DEFECT THE SERVER COMMENT ALREADY RECORDS FIXING ONCE:
// "36 such no-match pairs were found in the episodic logs, each claiming a fix
// that never happened." It was re-created by a route that fix cannot see - a
// playbook that resolves ok:true while doing nothing BY DESIGN - and it is the
// repo's "reports success it did not earn" class (BUG-311/316), reached from a
// new direction. The project memory `no-playbook-is-not-unhandled` predicted it
// in as many words: "An acknowledge playbook is not free - it speaks a falsehood."
//
// THE FIX is at the source, not at the two consumers: an action that reports
// `healed: false` resolves as 'acknowledged', not 'applied'. Both liars already
// test for 'applied', so both stop lying, and the dead `healed` field finally has
// a reader.
//
// Run: cd mythos && node --test test/bug-234-acknowledge-is-not-a-heal.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const { createBus } = require('../src/core/bus');
const { createHealer } = require('../src/core/immune/healer');

const HEALER_SRC = fs.readFileSync(path.join(SRC, 'core', 'immune', 'healer.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const BRIDGE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The four kinds ad6ad33 gave acknowledge playbooks.
const ACK_KINDS = [
  'live-turn-no-user-transcript',
  'live-turn-silent',
  'claimed-action-not-taken',
  'live-tool-outcome-late-for-turn',
];

// Drive the REAL chain. Reading the three files and reasoning about them is how
// this survived thirteen days; the falsehood is only obvious when you listen to
// what comes out of the speaker.
async function runChain(kinds) {
  const spoken = [];
  const healed = [];
  const bus = createBus({ historySize: 200 });
  // 2026-09-23, BUG-447: immune/announcer.js (the speaker these cases listened to)
  // is deleted — successful heals are never spoken (operator decision D5). Speech
  // is now captured where every immune line becomes audio: action.speak-requested.
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => { if (type === 'action.speak-requested') spoken.push(payload.text); return emit(type, payload); };
  const healer = createHealer({ bus, config: {}, effectors: null, brain: null });
  if (healer.start) healer.start();
  bus.subscribe('health.healed', (e) => healed.push(e.payload));
  for (const kind of kinds) {
    bus.emit('health.diagnosed', { kind, target: 'probe', severity: 'minor', evidence: {} });
    await sleep(80);
  }
  await sleep(250);
  if (healer.stop) healer.stop();
  return { spoken, healed };
}

describe('BUG-234 - an acknowledgement is not a heal', () => {
  it('MYTHOS does not say "Self-healed" for a playbook that heals nothing', async () => {
    const { spoken } = await runChain(ACK_KINDS);
    assert.deepEqual(spoken, [],
      'the acknowledge action is a documented no-op — announcing it re-creates the '
      + '"reports success it did not earn" class the repo has fixed four times. Heard: '
      + JSON.stringify(spoken));
  });

  it('the healed event does not claim the outcome was applied', async () => {
    const { healed } = await runChain(ACK_KINDS);
    assert.equal(healed.length, ACK_KINDS.length, 'every kind must still MATCH its playbook');
    for (const h of healed) {
      assert.notEqual(h.outcome, 'applied',
        h.kind + ' resolved as applied while its action reported healed:false — that single '
        + 'word is what makes the announcer speak and the server write healed:true');
      assert.equal(h.outcome, 'acknowledged');
    }
  });

  it('still MATCHES rather than falling through to no-match', async () => {
    // The whole point of F8 was to stop these reaching the expensive no-match
    // path (a brain call plus a 7-day episodic scan). Fixing the falsehood must
    // not undo that — this is the negative control.
    const { healed } = await runChain(['live-turn-silent']);
    assert.equal(healed[0].outcome, 'acknowledged');
    assert.equal(healed[0].playbookId, 'live-turn-silent-known');
  });

  it('a REAL heal is still applied — and, since BUG-447, still not spoken', async () => {
    // The other negative control. If the fix keyed on something broader than
    // `healed === false` it would stop recording genuine remediations as applied.
    // Being SPOKEN is no longer the test: D5 (2026-09-23) silenced every
    // successful heal; the applied outcome is what the HUD and vault record.
    const { spoken, healed } = await runChain(['provider-down']);
    assert.equal(healed.length, 1);
    assert.notEqual(healed[0].outcome, 'acknowledged',
      'probe-provider performs a real global re-probe — it must keep reporting applied');
    assert.deepEqual(spoken, [], 'a successful heal is never spoken (BUG-447, D5)');
  });
});

describe('BUG-234 - the two consumers that were lying', () => {
  it('the announcer that spoke applied heals is gone, so nothing can speak an acknowledgement as a heal', () => {
    // Was: a source pin on the announcer's `outcome !== 'applied'` guard. BUG-447
    // (2026-09-23) deleted the announcer, which removes the consumer this pinned.
    assert.equal(fs.existsSync(path.join(SRC, 'core', 'immune', 'announcer.js')), false);
  });

  it("the server's actuallyHealed still keys on applied", () => {
    assert.match(SERVER_SRC, /const actuallyHealed = !\('outcome' in p\) \|\| p\.outcome === 'applied';/,
      'same reliance: acknowledged must not satisfy this, or the anomaly log says healed:true');
  });

  it('the episodic row calls an acknowledgement what it is, not "unhandled"', () => {
    // 'unhandled' would be a second, smaller falsehood: the anomaly WAS
    // recognised, deliberately, by a playbook that exists for it.
    assert.match(SERVER_SRC, /outcome === 'acknowledged' \? 'acknowledged'/,
      'an acknowledged condition is neither healed nor unhandled');
  });

  it('the healed:false field has a reader now', () => {
    // It had none. `grep -rn "\.healed\b" src/ server/ ui/` returned nothing,
    // so the action's own honesty marker was inert — the same dead-field shape
    // as BUG-356's err.stderrText.
    assert.match(HEALER_SRC, /detail\.healed === false/);
  });
});

describe('BUG-234 - the ceiling guard that never guarded', () => {
  it('the cooldown assertion names cooldown specifically', () => {
    // MEASURED BY MUTATION 2026-08-28: the original assertion was
    //   outcomes.includes('cooldown') || outcomes.includes('heal-failed')
    // and setting the provider-down playbook's own cooldownMs from 60000 to 0 —
    // the exact bound BUG-234 promised not to widen — left
    // health-channel-non-faults.test.js AND immune.test.js at 72/72 green.
    // rotate-nim-key carries verifyMs, so the second diagnosis lands in the
    // recurrence branch and returns 'heal-failed' without ever consulting
    // cooldownMs. The disjunction accepted that, so the ceiling had no guard.
    // The `||` WAS THE WHOLE PROBLEM, and the fix is to delete it rather than to
    // add anything. Re-measured after the change: cooldown-only leaves the clean
    // suite at 72/72 and takes the mutant to fail=1. An earlier attempt to assert
    // "exactly one applied outcome" instead was WRONG and went red on correct
    // code — the real sequence here is ["cooldown","cooldown"], because the
    // playbook is already on cooldown when the case starts.
    // CODE, not prose about code. The corrected guard's own comment quotes the
    // old disjunction to explain what was wrong with it, so a flat search finds
    // it there — the seventh time in this campaign an assertion has scored a
    // mention as a statement.
    const T = fs.readFileSync(path.join(__dirname, 'health-channel-non-faults.test.js'), 'utf8')
      .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(T, /outcomes\.includes\('cooldown'\) \|\| outcomes\.includes\('heal-failed'\)/,
      "naming heal-failed as an acceptable alternative is what let a cooldown of 0 pass: "
      + 'rotate-nim-key carries verifyMs, so the second diagnosis lands in the recurrence '
      + 'branch and returns heal-failed WITHOUT EVER CONSULTING cooldownMs');
    assert.match(T, /assert\.ok\(outcomes\.includes\('cooldown'\)/,
      'the ceiling this test is named for must be the thing it asserts');
  });

  it('the provider-down playbook still carries its 60s cooldown', () => {
    assert.match(HEALER_SRC,
      /then: \[\{ do: 'probe-provider', args: \{ provider: '\$target', rotateKey: true \} \}\],\s*\r?\n\s*cooldownMs: 60000,/,
      'BUG-234 widened the MATCH and promised the ceilings would not move');
  });
});

describe('BUG-234 / BUG-273 - two comments that now say false things', () => {
  it('healer.js no longer claims no seed playbook uses $target', () => {
    // The comment above getPath said "None of the SEED_PLAYBOOKS above use this
    // — it exists for future playbooks". BUG-234's own widening made that false
    // the day it shipped: provider-down passes provider:'$target'.
    // ASSERTED POSITIVELY, and that is the point. The first version of this
    // guard was `doesNotMatch(/None of the SEED_PLAYBOOKS above use this/)` and
    // it was VACUOUS — the corrected comment quotes the old claim to explain it,
    // but without the word "above", so the pattern never matched either version
    // and a mutation restoring the falsehood survived. A negative assertion
    // about a comment cannot distinguish a retraction from a repetition; assert
    // the correction instead.
    assert.match(HEALER_SRC, /provider-down uses it/,
      'a confident comment that is wrong outlives the code, and the next reader trusts it');
    assert.match(HEALER_SRC, /provider: '\$target'/, 'because a seed playbook does use it');
  });

  it('s2s-bridge.js no longer states A2\'s refuted remedy as pending', () => {
    // BUG-273's own 2026-08-19 instruction: "its existing prose in s2s-bridge.js
    // must not be read as a pending remedy." The measurement it commissioned
    // REFUTED the hypothesis — worst case 25 frames, not 133 — and BUG-388 later
    // showed the 0.123 "bleed" this block reasons from was the operator's own
    // voice, not assistant audio.
    // The corrected block does NOT quote the phrase, so a flat search for it is
    // a real guard here rather than a mention-vs-statement trap. An earlier
    // version required a line break inside the phrase and was defeated by a
    // single-line reinstatement.
    assert.doesNotMatch(BRIDGE_SRC, /the fix is to stop replaying frames/,
      'the remedy was refuted by measurement and must not read as pending work');
    assert.match(BRIDGE_SRC, /NOTHING HERE IS PENDING/,
      'and the block must say so, not merely omit the sentence');
    assert.match(BRIDGE_SRC, /REFUTED/,
      'the block must say plainly that the measurement was taken and went the other way');
  });
});
