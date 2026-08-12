'use strict';

// test/actions-widget-glyph.test.js — the Agent Actions feed rendered `✗ ?` for
// every denial and every breaker block.
//
// THE INCIDENT (reported 2026-08-12): operator saw rows like `✗ ?` in the
// dashboard's Agent Actions widget. Root cause was two independent defects in
// the same relay/widget pair:
//   1. glyphFor() only knew `!p.ok` -> failed. `action.denied` and
//      `action.blocked` events carry no `ok` field at all (only
//      `action.completed` does), so `!p.ok` was true for a REFUSAL and painted
//      the same glyph as a genuine failure — a tool the leash correctly denied
//      looked identical to a tool that ran and broke.
//   2. The relay in server/index.js spread `{tool, ok, goalId, reason,
//      unverified}` off whatever the emitting decision object happened to
//      contain. Denial/block payloads that were not `{tool, args}`-shaped
//      produced no `tool` field at all, so the row builder's `p.tool || '?'`
//      fallback fired and the row printed a literal `?` — no way to tell which
//      tool was refused.
//
// Fixed by relaying an explicit `state` derived from e.type ('completed' |
// 'denied' | 'blocked') and by giving `glyphFor` a fourth, dedicated state so
// "refused" (nothing was attempted, not a failure) is never confused with
// "failed" (attempted and did not work). Uses the dynamic-import idiom the
// other ui/public/js model tests use (see component-health-model.test.js,
// auth-gate-state.test.js) since actions.js is an ES module and cannot be
// required.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let glyphFor;

before(async () => {
  const mod = await import(pathToFileURL(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'actions.js'),
  ).href);
  glyphFor = mod.glyphFor;
});

describe('glyphFor (Agent Actions feed glyph selection)', () => {
  it('a denial gets its own glyph, not the failure one', () => {
    const g = glyphFor({ state: 'denied', tool: 'media_key', reason: 'tier-2-requires-confirm' });
    assert.equal(g.mark, '⊘');
    assert.equal(g.label, 'refused');
  });

  it('a blocked action gets the same refused glyph as a denial', () => {
    const g = glyphFor({ state: 'blocked', tool: 'gmail_send', reason: 'breaker-open' });
    assert.equal(g.mark, '⊘');
    assert.equal(g.label, 'refused');
  });

  it('a real failure still reads as failed', () => {
    const g = glyphFor({ state: 'completed', ok: false, tool: 'gmail_unread' });
    assert.equal(g.mark, '✗');
    assert.equal(g.label, 'failed');
  });

  it('an unverified success is still the middle state', () => {
    const g = glyphFor({ state: 'completed', ok: true, unverified: true, tool: 'ui_type' });
    assert.equal(g.mark, '~');
    assert.equal(g.label, 'attempted, not confirmed');
  });

  it('a verified success is unchanged', () => {
    const g = glyphFor({ state: 'completed', ok: true, tool: 'whatsapp_send' });
    assert.equal(g.mark, '✓');
    assert.equal(g.label, 'verified');
  });

  it('a payload with no state key at all still reads as failed (backward-compatible fallback)', () => {
    const g = glyphFor({ ok: false, tool: 'x' });
    assert.equal(g.mark, '✗');
    assert.equal(g.label, 'failed');
  });
});

// Contract test (deferred Task 3 review item): the relay's `state` whitelist
// in server/index.js and glyphFor()'s branches in actions.js must agree on
// the outcome-state vocabulary. Today it is exactly 'completed' | 'denied' |
// 'blocked'. Nothing else pins the two sides together, so the server could
// grow a fourth outcome state that the widget silently paints as a generic
// failure — the exact bug class this branch exists to fix (see the file
// header). This is a static scan in the spirit of
// test/event-name-conformance.test.js: cheap, no shared-constant plumbing
// across the CJS server and the browser ES module, but it fails loudly the
// moment either side's literal set changes without the other.
describe('action outcome-state vocabulary contract (relay <-> widget)', () => {
  const serverSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'index.js'), 'utf8',
  );
  const widgetSrc = fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'actions.js'), 'utf8',
  );

  it("the relay's state whitelist is exactly {completed, denied, blocked}", () => {
    const m = serverSrc.match(
      /if\s*\(state !== '(\w+)' && state !== '(\w+)' && state !== '(\w+)'\) return;/,
    );
    assert.ok(m, 'expected to find the action-relay state whitelist guard in server/index.js');
    const relayStates = [m[1], m[2], m[3]].sort();
    assert.deepEqual(relayStates, ['blocked', 'completed', 'denied']);
  });

  it("glyphFor's refused branch is exactly {denied, blocked} — the relay's whitelist minus 'completed'", () => {
    const m = widgetSrc.match(
      /p\.state === '(\w+)' \|\| p\.state === '(\w+)'/,
    );
    assert.ok(m, "expected to find glyphFor's denied/blocked refused-state check in actions.js");
    const refusedStates = [m[1], m[2]].sort();
    assert.deepEqual(refusedStates, ['blocked', 'denied']);
  });
});
