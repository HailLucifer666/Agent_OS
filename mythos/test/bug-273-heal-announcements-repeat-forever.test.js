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

// 2026-09-23, BUG-447 (operator decision D5): the dedup this suite pinned held a
// REPEAT of a spoken heal to once per ten minutes. The heal is now not spoken at
// all — immune/announcer.js is deleted, and with it the dedup map. What the four
// "Self-healed: cortex restart after a stall" lines became is pinned here as the
// strongest form of the same promise: zero, not one. The vault and HUD records
// (Q2 above) are unchanged; they never depended on the speaker.
const { createBus } = require('../src/core/bus');
const { createHealer } = require('../src/core/immune/healer');

describe('BUG-273 — the same heal is not announced every five minutes forever', () => {
  it('the stall heal that was spoken four times in sixteen minutes is now spoken zero times', async () => {
    const spoken = [];
    const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
    const emit = bus.emit.bind(bus);
    bus.emit = (type, payload) => { if (type === 'action.speak-requested') spoken.push(payload.text); return emit(type, payload); };
    const healer = createHealer({ bus, config: {}, memory: null, getCortex: () => ({ stop() {}, start() {} }) });
    healer.start();
    for (let i = 0; i < 4; i++) bus.emit('health.healed', { outcome: 'applied', playbookId: 'stall-restart', title: 'cortex restart after a stall', kind: 'cortex-stall', actions: ['restart-cortex'] });
    await new Promise((r) => setTimeout(r, 50));
    healer.stop();
    assert.deepEqual(spoken, [], 'a successful heal is never spoken, however often it recurs');
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'core', 'immune', 'announcer.js')), false);
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
