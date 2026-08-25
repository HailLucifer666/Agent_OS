'use strict';

// util/day-key.js — THE date basis for every dated file under vault/.
//
// F11 (2026-08-15). The 2026-08-14 session wrote Audit/2026-08-14.jsonl and
// Incidents/2026-08-14.jsonl alongside Episodic/2026-08-15.jsonl for events
// minutes apart: Audit and Incidents built their filename from
// `toISOString().slice(0,10)` (UTC), Episodic from a local-components helper.
// Any investigation spanning local midnight then has to know which store uses
// which clock, and working that out cost real time during this RCA.
//
// LOCAL, and not arbitrarily: episodic recall() computes its `since`/`until`
// window from LOCAL date components, so a UTC-named file is not merely
// inconsistent — it can fall outside a window that should contain it and
// silently drop a day of history. The operator also asks questions in local
// time ("what happened last night"); a store whose day boundary is 05:30 local
// answers a different question than the one being asked.
//
// A PLAIN MODULE, NOT A METHOD ON THE FS STORE. It was first added to
// createFsStore and every hand-written fake fs store in the test suite promptly
// broke with `fs.dayKey is not a function` — which is the correct signal, badly
// placed: this is a pure function of a timestamp with no filesystem in it, so
// making it an injected dependency buys nothing and costs every test double a
// method it has no reason to implement.
//
// Do not build a dated vault filename from toISOString() anywhere. A second
// date basis is exactly how the two clocks diverged.
function dayKey(ts) {
  const d = (ts === undefined || ts === null) ? new Date() : new Date(ts);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

module.exports = { dayKey };
