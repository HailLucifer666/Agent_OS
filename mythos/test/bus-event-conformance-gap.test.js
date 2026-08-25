'use strict';

// test/bus-event-conformance-gap.test.js — GAP-ANALYSIS-2026-08-24 Section 4's
// durable action, made real. Classifies every statically-emitted bus event:
//
//   subscribed      -> has an in-process bus.subscribe consumer
//   ui-referenced   -> relayed/rendered by the HUD under its own name
//   multi-referenced-> appears 2+ times in src/server (relay mapping, audit,
//                      dynamic-prefix families like engagement.<verb>.<id>)
//   TELEMETRY       -> emit-only. Deliberately allowed: observability-grade
//                      emissions with no consumer yet. This list is the debt —
//                      it may only SHRINK. Adding a name requires deciding
//                      whether it is telemetry or a missing consumer.
//
// The point is not to forbid emissions; it is to make "emitted into the void"
// a decision someone writes down instead of an accident nobody notices.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function walk(dir, out) {
  let entries = []; try { entries = fs.readdirSync(dir); } catch (_) { return out; }
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    let st; try { st = fs.statSync(fp); } catch (_) { continue; }
    if (st.isDirectory()) { if (!/node_modules/.test(fp)) walk(fp, out); }
    else if (/\.js$/.test(entry)) out.push(fp);
  }
  return out;
}

const SRC_FILES = walk(path.join(ROOT, 'src'), []).concat(walk(path.join(ROOT, 'server'), []));
const UI_DIR = path.join(ROOT, '..', 'ui', 'public');

let corpus = ''; for (const f of SRC_FILES) corpus += fs.readFileSync(f, 'utf8');
let uiCorpus = '';
try { for (const f of walk(UI_DIR, [])) uiCorpus += fs.readFileSync(f, 'utf8'); } catch (_) {}

const emitted = new Set(), subscribed = new Set();
for (const f of SRC_FILES) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/bus\.emit\((['"])([a-z][a-z0-9._-]+)\1/g)) emitted.add(m[2]);
  for (const m of t.matchAll(/bus\.subscribe\((['"])([a-z][a-z0-9._-]+)\1/g)) subscribed.add(m[2]);
}

// Dynamic-prefix emitters: the literal ends at the dot because the rest is
// interpolated. Matched by prefix, never by full name.
const PREFIX_EMITTERS = ['engagement.action.', 'engagement.progress.'];

// Measured emit-only baseline, frozen 2026-08-24. Telemetry-grade: no consumer
// today. Shrink as consumers appear.
const TELEMETRY_BASELINE = [
  'conversation.intent', 'conversation.suppressed', 'cortex.recall',
  'cortex.confirm-suppressed', 'cortex.proposed', 'engagement.deleted',
  'engagement.store.init', 'engagement.saved', 'engagement.removed',
  'goal.tier-granted', 'lifecycle.shutdown.step-failed',
  'memory.checkpoint.saved', 'memory.merged', 'memory.decay',
  'perception.file', 'voice.live.reasoning-filtered', 'voice.live.state',
  'voice.live.toolcancel', 'engagement.immune.hooks.registered',
];
const TELEMETRY = new Set(TELEMETRY_BASELINE);

describe('every emitted bus event is classified', () => {
  it('no emitted event is unclassified (subscribed, UI, multi-ref, or telemetry)', () => {
    const unclassified = [];
    for (const e of emitted) {
      if (subscribed.has(e)) continue;
      if (uiCorpus.includes(e)) continue;
      if (corpus.split(e).length - 1 > 1) continue;
      if (PREFIX_EMITTERS.some((pfx) => e.startsWith(pfx))) continue;
      if (TELEMETRY.has(e)) continue;
      unclassified.push(e);
    }
    assert.deepEqual(unclassified, [],
      'newly emitted bus events must be consumed, relayed, or added to TELEMETRY_BASELINE with a reason:\n'
      + unclassified.join('\n'));
  });

  it('negative control: the scanner actually sees the well-known wired events', () => {
    // If this fails, the scan went blind (regex/paths changed) and the green
    // result above means nothing.
    assert.ok(emitted.has('action.completed'), 'scanner must see action.completed');
    assert.ok(subscribed.has('health.anomaly') || corpus.includes("'health.anomaly'"),
      'scanner must see health.anomaly on the subscribe side');
    assert.ok(emitted.size > 50, 'expected ~90 emitted events, saw ' + emitted.size);
  });
});
