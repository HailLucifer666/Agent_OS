'use strict';

// test/tool-effect-classification.test.js — operator decision D10, 2026-10-06.
//
// THE DECISION. Read-only tools stay on the fast (Live) lane, and "read-only" is
// its own question — "does this change anything?" — asked of every tool. The
// leash tiers stay exactly as they are. Tier 0 is headed "T0 — READ ONLY" in
// src/core/leash/tiers.js, and that label is false for several of its entries:
// remember writes permanent memory, reminder_add / timer_add / log_incident /
// incident_status write state, okf_import imports, open_web opens a browser,
// navigate and close_panel change the HUD. A rule built on the tier would put
// `remember` on the fast lane and reopen BUG-464.
//
// WHY A GUARD, AND WHY IT IS DERIVED (gate D). The classification itself is a
// human judgement per tool and lives in src/core/voice/tool-effect.js. What must
// never be hand-kept is the SET it has to cover: this test derives that set from
// the leash's tier table (which test/tier-table-conformance.test.js already pins
// to every registered effector, in both directions) plus the Live catalog's own
// allowlist. A new tool therefore turns this file red until somebody decides
// whether it changes anything.
//
// RED FIRST, 2026-10-06, against 323fba62: the whole file failed at require()
// ("Cannot find module '../src/core/voice/tool-effect'").
//
// MUTATIONS, 2026-10-06 — three probes, each applied once, confirmed applied by
// `git diff --no-index` against a copy, run against this file (7 tests),
// restored from the copy and hash-verified. All three were green BEFORE the
// probe; each turned red:
//   (m1) add `brand_new_tool: 0` to TIER_TABLE (1+/1-) ........... red: (a)
//   (m2) add `remember` to READS as well (1+/1-) .................. red: (a) (c)
//   (m3) changesAnything() true only for CHANGES members (1+/1-) .. red: (d)
// Adjacent cases that kept passing: (b) get_time / read_status / web_search stay
// reads, and (e) the tier table itself is untouched by this decision.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
const effect = require('../src/core/voice/tool-effect');

// Derived, never typed: every tool the leash can gate plus every tool Live can
// be offered.
function everyTool() {
  return [...new Set([...Object.keys(TIER_TABLE), ...DEFAULT_ALLOWLIST])].sort();
}

describe('D10: every tool answers "does this change anything?"', () => {
  test('(a) every tool in the tier table and the Live catalog is classified exactly once', () => {
    const tools = everyTool();
    assert.ok(tools.length >= 150, 'the derived set is the real catalog, not an empty one: ' + tools.length);
    assert.deepEqual(effect.unclassifiedTools(tools), [],
      'classify each of these in src/core/voice/tool-effect.js (READS if it changes nothing, CHANGES with the reason if it does)');
    const both = effect.READS.filter((t) => Object.prototype.hasOwnProperty.call(effect.CHANGES, t));
    assert.deepEqual(both, [], 'a tool cannot be both');
  });

  test('(a2) the guard can fail: an unclassified name is reported', () => {
    assert.deepEqual(effect.unclassifiedTools([...everyTool(), 'brand_new_tool']), ['brand_new_tool']);
  });

  test('(a3) no stale entries: everything classified is a real tool', () => {
    const real = new Set(everyTool());
    const stale = [...effect.READS, ...Object.keys(effect.CHANGES)].filter((t) => !real.has(t));
    assert.deepEqual(stale, [], 'remove these from tool-effect.js');
  });

  test('(b) reads that change nothing are reads', () => {
    for (const t of ['get_time', 'read_status', 'system_status', 'list_windows', 'media_status', 'web_search']) {
      assert.equal(effect.changesAnything(t), false, t);
    }
  });

  test('(c) the tier-0 tools that DO change something are classified as changing, each with its reason', () => {
    for (const t of ['remember', 'reminder_add', 'timer_add', 'log_incident', 'incident_status', 'okf_import', 'open_web', 'navigate', 'close_panel']) {
      assert.equal(TIER_TABLE[t], 0, t + ' is tier 0 (the premise of this test)');
      assert.equal(effect.changesAnything(t), true, t);
    }
    for (const [tool, reason] of Object.entries(effect.CHANGES)) {
      assert.ok(typeof reason === 'string' && reason.trim().length > 0, tool + ' needs a reason');
    }
  });

  test('(d) an unknown tool is treated as changing something (fail closed)', () => {
    assert.equal(effect.changesAnything('no_such_tool_ever'), true);
    assert.equal(effect.changesAnything(undefined), true);
  });

  test('(e) the leash tiers are unchanged by this decision', () => {
    assert.equal(TIER_TABLE.remember, 0);
    assert.equal(TIER_TABLE.open_web, 0);
    assert.ok(Object.isFrozen(effect.CHANGES) && Object.isFrozen(effect.READS), 'shared constants are frozen');
  });
});
