'use strict';

// diff-gate.js — SPEAK ONLY WHEN SOMETHING CHANGED.
//
// Both cortex's mull() and planner/daily.js's runCheckin() run unprompted, on
// their own existing timers (cortex's tick loop; daily.js's 60s scheduler —
// see those files' own headers for why no new timer belongs here). Neither
// checked whether what they were about to say was NEW: mull() emitted
// 'cortex.thought' every time the brain returned a non-'low'-priority
// thought, even the byte-identical nudge from the last mull pass; daily.js's
// runCheckin() emitted 'plan.checkin' every fire even when the exact same
// goals were already reported stalled last time. This is the shared gate that
// closes that: a watcher declares what it's watching (a key) and the value it
// just probed, and the gate reports whether that value actually moved since
// the last time THIS key checked in — the comparison a watcher needs, with no
// new scheduler/timer/process of its own.
//
// Per-process, in-memory (Map) — both consumers already run for the process
// lifetime on unref'd timers, so there is no restart-durability need here;
// that would be a real feature (disk persistence) nobody asked for.

function createDiffGate() {
  var lastByKey = new Map();

  // hasChanged(key, value) -> boolean. `value` is compared by JSON identity,
  // which is enough for the plain strings/arrays/objects the two callers
  // above pass. Records `value` as the new "last" only when it differs, so a
  // watcher calling this every tick without a real change never drifts.
  function hasChanged(key, value) {
    var serialized = JSON.stringify(value === undefined ? null : value);
    if (lastByKey.get(key) === serialized) return false;
    lastByKey.set(key, serialized);
    return true;
  }

  function reset(key) {
    if (key === undefined) lastByKey.clear();
    else lastByKey.delete(key);
  }

  return { hasChanged: hasChanged, reset: reset };
}

module.exports = { createDiffGate: createDiffGate };
