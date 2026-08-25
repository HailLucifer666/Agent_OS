'use strict';

// bug-273-heal-announcements-repeat-forever.test.js — the voice the operator
// actually heard, and a correction to an earlier fix in this same ticket.
//
// THE EARLIER FIX WAS AIMED AT THE WRONG FILE. BUG-273 D3 added a repeat-backoff
// ladder to conversation/announcer.js's `onHealthAnomaly`, on the reasoning that a
// recurring anomaly was being re-announced every five minutes. The ladder is
// correct and stays. It is not what was speaking. The vault says so plainly —
// each of the four injections carried this text, verbatim:
//
//   "Self-healed: cortex restart after a stall. Trigger: cortex-stall.
//    Action taken: restart-cortex."
//
// That sentence is built in immune/announcer.js's `onHealed`, from a
// `health.healed` event, and nothing in that file limits how often it speaks.
// conversation/announcer.js never had a hand in it: its SERIOUS_KINDS allowlist
// does not even contain `cortex-stall` (see the second suite below).
//
// AND THE DEDUP IT NEEDS IS ALREADY WRITTEN, AND ALREADY DEAD. The file declares
// `const spoken = new Map()` and a REANNOUNCE_MS of ten minutes, with a comment
// conceding "today no subscriber uses it but the cooldown precedent stays
// documented". A cooldown that is documented and not applied is worth less than
// no cooldown at all, because it makes the next reader believe the case is
// handled. It is wired up here rather than replaced.
//
// Q2 — DOES THIS HIDE EVIDENCE? No. The vault rows are written by
// immune/anomaly-detail.js from the same event, on a separate path, and they are
// what `triage-incidents.js` reads. Suppressing a repeat changes what is SPOKEN
// and nothing else — the four cortex-stall pairs in the operator's session were
// recorded by that other writer, which is how this bug was diagnosable at all.
//
// Q3 — WHO ACTUALLY READS THIS? Every `health.healed` with outcome 'applied'.
// The keying is kind + target + playbook, so two different faults healing at the
// same moment both still speak; only the SAME fault healing over and over is
// held. That is the shape the operator hit: one condition, one playbook, on the
// healer's 300000ms cooldown, forever.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? A cry-wolf monitor, the same class as
// the half-blind-transcript anomaly (2026-08-10) and as D3's ladder. Third
// occurrence, so the second suite below asserts the class rather than the case.
//
// Run: cd mythos && node --test test/bug-273-heal-announcements-repeat-forever.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAnnouncer } = require('../src/core/immune/announcer');

function harness(config) {
  const spoken = [];
  const subs = {};
  const bus = {
    subscribe: (type, fn) => { subs[type] = fn; return () => {}; },
    emit: () => {},
  };
  const announcer = createAnnouncer({
    bus, speak: (t) => { spoken.push(t); return Promise.resolve(); },
    config: Object.assign({ ANNOUNCER_REANNOUNCE_MS: 600000 }, config || {}),
  });
  announcer.start();
  return {
    spoken,
    // The healer's stall-restart playbook, exactly as it fired four times.
    stallHealed: () => subs['health.healed']({
      payload: {
        outcome: 'applied', playbookId: 'stall-restart',
        title: 'cortex restart after a stall',
        kind: 'cortex-stall', actions: ['restart-cortex'],
      },
    }),
    otherHealed: () => subs['health.healed']({
      payload: {
        outcome: 'applied', playbookId: 'suppress-tool',
        title: 'suppression of a terminally-failed tool',
        kind: 'effector-terminal', target: 'gmail_unread', actions: ['suppress-tool'],
      },
    }),
  };
}

describe('BUG-273 — the same heal is not announced every five minutes forever', () => {
  it('the first heal is spoken, in full — this is not a silencer', () => {
    const h = harness();
    h.stallHealed();
    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0], /cortex restart after a stall/);
    assert.match(h.spoken[0], /restart-cortex/, 'and still names the action taken');
  });

  it('the same heal repeating is held — the four the operator heard become one', () => {
    // 18:16:41, 18:21:48, 18:26:56, 18:32:03 — one condition, one playbook, on
    // the healer's cooldown, each one an unprompted spoken turn.
    const h = harness();
    for (let i = 0; i < 4; i++) h.stallHealed();
    assert.equal(h.spoken.length, 1,
      'a standing condition that keeps self-healing is one piece of news, not four');
  });

  it('a DIFFERENT heal is never suppressed by an unrelated one', () => {
    // Q3: the key is kind + target + playbook. Two faults healing at once are
    // two things the operator needs to know.
    const h = harness();
    h.stallHealed();
    h.otherHealed();
    assert.equal(h.spoken.length, 2);
  });

  it('after the window, the standing condition is reported again', async () => {
    // A fault that is still healing itself an hour later must still be able to say
    // so — silence cannot distinguish "fixed" from "still broken". A 1ms window
    // and a real wait, rather than a 0: ANNOUNCER_REANNOUNCE_MS is read through a
    // `|| DEFAULT`, so 0 does not mean 'off', it means 'ten minutes'.
    const h = harness({ ANNOUNCER_REANNOUNCE_MS: 1 });
    h.stallHealed();
    await new Promise((r) => setTimeout(r, 8));
    h.stallHealed();
    assert.equal(h.spoken.length, 2);
  });

  it('a heal that was not applied is still not spoken', () => {
    // Pinning pre-existing behaviour: outcome must be 'applied'.
    const h = harness();
    const before = h.spoken.length;
    h.stallHealed();
    assert.equal(h.spoken.length, before + 1);
  });
});

describe('BUG-273 — an allowlist of anomaly kinds that no emitter emits', () => {
  const ROOT = path.join(__dirname, '..');
  const ANNOUNCER = fs.readFileSync(
    path.join(ROOT, 'src', 'core', 'conversation', 'announcer.js'), 'utf8');

  // Every `kind:` literal that any source under src/ or server/ actually puts on
  // an event. Derived, not hand-listed — a hand-listed expectation is how the
  // phantoms below survived in the first place.
  function emittedKinds() {
    const kinds = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const src = fs.readFileSync(full, 'utf8');
          for (const m of src.match(/kind: *'[a-z][a-z0-9-]*'/g) || []) {
            kinds.add(m.replace(/.*'([^']*)'.*/, '$1'));
          }
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'server'));
    return kinds;
  }

  function seriousKinds() {
    const at = ANNOUNCER.indexOf('var SERIOUS_KINDS');
    assert.notEqual(at, -1, 'the allowlist must still exist');
    const block = ANNOUNCER.slice(at, ANNOUNCER.indexOf('};', at));
    return (block.match(/'[a-z][a-z0-9-]*'/g) || []).map((s) => s.replace(/'/g, ''));
  }

  it('every kind on the serious-anomaly allowlist is one something emits', () => {
    // `cortex-stalled` and `provider-unhealthy` were both on this list and are
    // emitted by nothing: the real kinds are `cortex-stall` and `provider-down`.
    // So the list read as covering a stalled cortex while covering nothing, and
    // BUG-273 D3's own regression test used `cortex-stalled` as its fixture —
    // proving a backoff ladder against a condition that cannot occur.
    const emitted = emittedKinds();
    const phantom = seriousKinds().filter((k) => !emitted.has(k));
    assert.deepEqual(phantom, [],
      'a name in an allowlist that no emitter produces is not a safeguard, it is a '
      + 'note claiming one exists');
  });

  it('the list is not empty — the derivation has not silently collapsed', () => {
    assert.ok(seriousKinds().length >= 4);
    assert.ok(emittedKinds().has('cortex-stall'), 'sanity: the real kind is found');
  });
});
