'use strict';

// BUG-063 (Stage 3 of 7) — a slow tool's in-progress "started" marker must
// not render as a failure.
//
// Proof this was live: a real session.json recorded the literal narration
// "spotify_play FAILED: spotify_play started" — a straight contradiction.
// live-tool-adapter.js's SLOW_TOOLS branch commits
// { tool, ok:false, started:true, summary:'spotify_play started — outcome
// pending.' } so the turn doesn't block on a 5-10s cua-driver click; the OLD
// summarizeActionsForResult read only `a.ok`, so `started:true` rendered
// exactly like a real failure the instant it was recorded, before the real
// outcome (delivered later via reportLateOutcome) ever arrived.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

describe('BUG-063: a started (in-progress) action is not narrated as FAILED', () => {
  it('THE RECORDED CASE: spotify_play started must not read as "FAILED: ... started"', () => {
    const note = summarizeActionsForResult([
      { tool: 'spotify_play', ok: false, started: true, summary: 'spotify_play started — outcome pending.' },
    ]);
    assert.ok(note, 'a started action still produces a note (the operator did hear "started")');
    assert.doesNotMatch(note, /FAILED/, 'must never render as a failure');
    assert.match(note, /spotify_play started \(outcome pending\)/);
  });

  it('a genuine failure (ok:false, no started flag) still reads as FAILED', () => {
    const note = summarizeActionsForResult([
      { tool: 'ui_type', ok: false, summary: 'no target window' },
    ]);
    assert.match(note, /ui_type FAILED: no target window/);
  });

  it('a genuine success still reads as succeeded', () => {
    const note = summarizeActionsForResult([
      { tool: 'spotify_next', ok: true, summary: 'spotify_next done.' },
    ]);
    assert.match(note, /spotify_next succeeded: spotify_next done\./);
  });

  it('a confirmPending action is still skipped (unaffected by this fix)', () => {
    const note = summarizeActionsForResult([
      { tool: 'run_command', ok: false, confirmPending: true, summary: 'Voice: run_command' },
    ]);
    assert.equal(note, null);
  });

  it('a mix of started + real outcomes in one turn renders both correctly', () => {
    const note = summarizeActionsForResult([
      { tool: 'spotify_play', ok: false, started: true, summary: 'spotify_play started — outcome pending.' },
      { tool: 'spotify_volume', ok: true, summary: 'spotify_volume done.' },
    ]);
    assert.match(note, /spotify_play started \(outcome pending\)/);
    assert.match(note, /spotify_volume succeeded/);
    assert.doesNotMatch(note, /FAILED/);
  });

  it('no actions produces no note', () => {
    assert.equal(summarizeActionsForResult([]), null);
    assert.equal(summarizeActionsForResult(null), null);
  });

  it('unverified Live and legacy outcomes are neither failures nor proven successes', () => {
    for (const ok of [false, true]) {
      const note = summarizeActionsForResult([{ tool: 'open_web', ok, unverified: true, summary: 'handed URL to the browser' }]);
      assert.match(note, /open_web NOT CONFIRMED/);
      assert.doesNotMatch(note, /FAILED|succeeded/);
      assert.match(note, /handed URL to the browser/);
    }
  });
});
