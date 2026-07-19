'use strict';

// Regression guards for the Phase 1 git-reconciliation merge (MYTHOS Gap-Close
// Upgrade task-957, §26 Phase 1). These invariants were established *by the
// merge itself* — they pin the resolutions made when cherry-picking the
// stranded 5-phase chain onto main, and exist independently of the per-phase
// feature tests (phase0…phase4) which cover each pick's own functionality.
//
// What this guards:
//   1. Effector count is exactly 71 (61 main + 3 docs + 5 pc + 2 browser).
//   2. All 10 cherry-picked tools are present in the canonical tier table at
//      the right tiers (anti-drift invariant #2: tier-table 3-source parity).
//   3. The deliberate T3→T2 spotify re-tiering on main was NOT silently
//      reverted by the chain (which was authored against an older base where
//      spotify_play/spotify_search were still T3).
//   4. Server exposes the /api/engagements* routes the chain added (UI
//      contract dependency).
//   5. Module exports include the new tools — catches a future refactor that
//      drops one without updating the registration wiring.
//
// If you intentionally add/remove an effector, update the count AND this list
// in the same change. Per anti-drift invariant #2, also update tiers.js,
// MYTHOS-ARCHITECTURE.md §9, and the count gate in effectors-hub.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { TIER_TABLE, tierOf } = require('../src/core/leash/tiers');
const { TOOLS: PC_TOOLS } = require('../src/core/effectors/from-pc');
const { TOOLS: BROWSER_TOOLS } = require('../src/core/effectors/from-browser');
// from-docs exports buildTools() (a factory that requires a vault fs-store),
// not a static TOOLS array. We source-scan it instead — same as the server
// route check below — because the contract is "the tool name is registered",
// and adding a tool means adding the `name: '...'` line.
const fs = require('node:fs');
const path = require('node:path');
const FROM_DOCS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-docs.js'), 'utf8');

// Tool name → expected tier for everything the Phase 1 merge added.
const PHASE1_TOOLS = {
  // Phase 2 (4682f7c) — docs-gen, sandboxed to vault/builds/docs/
  generate_spreadsheet: 2,
  generate_deck: 2,
  generate_pdf: 2,
  // Phase 3 (dab6e53) — desktop control
  move_window: 2,
  snap_window: 2,
  scroll_at: 2,
  right_click_at: 3,
  drag: 3,
  // Phase 4 (1b79321) — browser control
  browser_wait_for: 1,
  browser_fill_form: 3
};

describe('Phase 1 merge invariants (task-957 §26)', () => {
  it('every Phase 1 tool is registered at the expected tier', () => {
    for (const [name, expectedTier] of Object.entries(PHASE1_TOOLS)) {
      const actual = TIER_TABLE[name];
      assert.notEqual(actual, undefined,
        name + ' is missing from TIER_TABLE — merge may have dropped it');
      assert.equal(actual, expectedTier,
        name + ' tier drifted: expected ' + expectedTier + ', table has ' + actual);
      // tierOf() must agree (the leash's fail-safe path).
      assert.equal(tierOf(name), expectedTier,
        name + ' tierOf() disagrees with TIER_TABLE');
    }
  });

  it('docs tools are exposed by from-docs (source scan for the name registrations)', () => {
    assert.ok(/name:\s*'generate_spreadsheet'/.test(FROM_DOCS_SRC),
      'generate_spreadsheet not registered in from-docs.js');
    assert.ok(/name:\s*'generate_deck'/.test(FROM_DOCS_SRC),
      'generate_deck not registered in from-docs.js');
    assert.ok(/name:\s*'generate_pdf'/.test(FROM_DOCS_SRC),
      'generate_pdf not registered in from-docs.js');
  });

  it('desktop tools are exposed by from-pc TOOLS array', () => {
    const names = PC_TOOLS.map(function (t) { return t.name; });
    ['move_window', 'snap_window', 'scroll_at', 'right_click_at', 'drag'].forEach(function (n) {
      assert.ok(names.indexOf(n) !== -1, n + ' missing from from-pc TOOLS');
    });
  });

  it('browser tools are exposed by from-browser TOOLS array', () => {
    const names = BROWSER_TOOLS.map(function (t) { return t.name; });
    assert.ok(names.indexOf('browser_wait_for') !== -1, 'browser_wait_for missing');
    assert.ok(names.indexOf('browser_fill_form') !== -1, 'browser_fill_form missing');
  });

  it('main\'s deliberate spotify T3→T2 policy survived the merge (chain was stale on this)', () => {
    // The dangling chain (dab6e53, 1b79321) was authored against a base where
    // these were T3. Main deliberately re-tiered them to T2 (vault/Spotify-only
    // writes; a confirm popup on every "play a song" was friction, not safety).
    // If this assertion fails, the chain silently reverted the policy.
    assert.equal(TIER_TABLE['spotify_play'], 2,
      'spotify_play must stay T2 (main policy) — chain reverted it');
    assert.equal(TIER_TABLE['spotify_search'], 2,
      'spotify_search must stay T2 (main policy) — chain reverted it');
  });

  it('engage executor + manager modules load (no require-cycle breakage from main.js threading)', () => {
    const { createEngagementExecutor } = require('../src/core/engagements/executor');
    const { createEngagementManager } = require('../src/core/engagements/index');
    assert.equal(typeof createEngagementExecutor, 'function');
    assert.equal(typeof createEngagementManager, 'function');
  });

  it('server wires the /api/engagements* routes (Phase 1 contract dependency)', () => {
    // Read the server source and assert the routes are present. A simple
    // require() would pull in express + ws and is heavier than needed; a
    // source scan is sufficient because adding a route means adding the
    // app.METHOD('/api/engagements...') line.
    //
    // W9 (Phase 2 — Wiring Integrity): the engagement routes moved from
    // server/index.js inline to server/routes/engagements.js factory. The
    // contract is preserved (same routes, same UI contract) — scan BOTH
    // files so this guard stays satisfied after the god-file decomposition.
    const fs = require('node:fs');
    const path = require('node:path');
    const indexSrc = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const engagementsFactorySrc = fs.existsSync(
      path.join(__dirname, '..', 'server', 'routes', 'engagements.js'))
      ? fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'engagements.js'), 'utf8')
      : '';
    const src = indexSrc + '\n' + engagementsFactorySrc;
    assert.ok(/app\.get\(['"]\/api\/engagements['"]/.test(src),
      'GET /api/engagements route missing — engagement UI contract broken');
    assert.ok(/app\.get\(['"]\/api\/engagements\/:id['"]/.test(src),
      'GET /api/engagements/:id route missing');
    assert.ok(/app\.post\(['"]\/api\/engagements\/:id\/transition['"]/.test(src),
      'POST /api/engagements/:id/transition route missing');
    assert.ok(/app\.post\(['"]\/api\/engagements['"]/.test(src),
      'POST /api/engagements route missing');
  });

  it('voice alias routing fix survived (Phase 0/614edb6): open_url/open_tab → real browser', () => {
    // The chain's parent commit fixed open_url/open_tab pointing at the
    // dashboard open_web widget instead of the real browser tools.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8');
    assert.ok(/'open_url':\s*'browser_navigate'/.test(src),
      "open_url alias must point at browser_navigate (not open_web)");
    assert.ok(/'open_tab':\s*'browser_tabs'/.test(src),
      "open_tab alias must point at browser_tabs (not open_web)");
  });
});
