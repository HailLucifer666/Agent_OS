'use strict';

// test/phase0-routing-repair.test.js — Phase 0 intent-routing fix.
// Regression for BUG-037-era "open a browser tab opens a dashboard widget" bug:
// open_url/open_tab aliases must route to the REAL browser tools (not open_web),
// the suggestion must carry sane default args, and open_web must fail loud on a
// missing/bad type instead of silently rendering a search widget.
//
// Pure unit tests — no brain/network/browser. The live oracle ("open a browser
// tab" by voice opens the real debug-profile Chrome, not a widget) is exercised
// manually; this file pins the routing mechanics the oracle depends on.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fakeBus } = require('./helpers');
const { buildTools } = require('../src/core/effectors/from-dashboard');

// suggestTool is not exported from voice-agent.js (which only exports
// createVoiceAgent). Read the source and exercise the alias/default-arg maps
// directly by re-implementing nothing — instead we assert the source-level
// contract (alias table contents) plus the runtime contract through the
// exported open_web effector. The executeAction remap path is covered by the
// alias contents test + the open_web type-gating test together.
describe('Phase 0 — intent routing: alias table points browser intents at real browser tools', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'),
    'utf8'
  );

  it('TOOL_ALIASES routes open_url -> browser_navigate (NOT open_web)', () => {
    // Extract the TOOL_ALIASES object body and assert the two key lines.
    assert.match(src, /['"]open_url['"]\s*:\s*['"]browser_navigate['"]/,
      'open_url must alias to browser_navigate, not open_web');
    assert.ok(!/['"]open_url['"]\s*:\s*['"]open_web['"]/.test(src),
      'open_url must NOT alias to open_web (that was the bug)');
  });

  it('TOOL_ALIASES routes open_tab -> browser_tabs (NOT open_web)', () => {
    assert.match(src, /['"]open_tab['"]\s*:\s*['"]browser_tabs['"]/,
      'open_tab must alias to browser_tabs, not open_web');
    assert.ok(!/['"]open_tab['"]\s*:\s*['"]open_web['"]/.test(src),
      'open_tab must NOT alias to open_web (that was the bug)');
  });

  it('ALIAS_DEFAULT_ARGS provides browser_tabs default action:new', () => {
    // The default-args applier for browser_tabs must default action to 'new'
    // so "open a browser tab" opens a NEW tab rather than falling through to
    // the list action.
    assert.match(src, /ALIAS_DEFAULT_ARGS\s*=/, 'ALIAS_DEFAULT_ARGS map must exist');
    assert.match(src, /browser_tabs[\s\S]{0,200}action:\s*args\.action\s*\|\|\s*['"]new['"]/,
      'browser_tabs alias-default must default action to "new"');
  });

  it('ALIAS_DEFAULT_ARGS for browser_navigate fails honest when no URL given', () => {
    // Without a URL and no query/target fallback, the applier must return a
    // __fail marker rather than firing an empty navigate call.
    assert.match(src, /browser_navigate[\s\S]{0,400}__fail/,
      'browser_navigate alias-default must surface __fail when no URL can be derived');
  });

  it('BROWSER CONTROL RULE counterweight exists in the system prompt', () => {
    // The asymmetric prompt weight (WEB PANEL RULE pushes open_web; nothing
    // pushed browser_*) is balanced by an explicit BROWSER CONTROL RULE.
    assert.match(src, /BROWSER CONTROL RULE/,
      'BROWSER CONTROL RULE prompt paragraph must exist to counterweight WEB PANEL RULE');
    // It must name the real browser tools.
    assert.match(src, /BROWSER CONTROL RULE[\s\S]{0,800}browser_tabs/);
    assert.match(src, /BROWSER CONTROL RULE[\s\S]{0,800}browser_navigate/);
    // It must NOT reference a non-existent browser_launch_debug tool.
    assert.ok(!/browser_launch_debug/.test(src),
      'prompt must not reference non-existent browser_launch_debug tool');
  });

  it('WEB PANEL RULE preserved (no over-correction — weather/YouTube still widgets)', () => {
    assert.match(src, /WEB PANEL RULE/);
    assert.match(src, /WEB PANEL RULE[\s\S]{0,800}type:"weather"/);
    assert.match(src, /WEB PANEL RULE[\s\S]{0,800}type:"youtube"/);
  });
});

describe('Phase 0 — open_web fails loud on missing/bad type', () => {
  // buildTools returns { TOOLS, setAskAgentDispatch, setCameraFrameProvider }.
  // We exercise the open_web fn directly with a stub web_search (no network).
  function makeOpenWeb() {
    const bus = fakeBus();
    const built = buildTools({ bus: bus, config: {} });
    const tool = built.TOOLS.find((t) => t.name === 'open_web');
    if (!tool) throw new Error('open_web tool not found in from-dashboard buildTools');
    return { fn: tool.fn, desc: tool.description, bus };
  }

  it('open_web description disclaims: not the real browser', () => {
    const { desc } = makeOpenWeb();
    assert.match(desc, /dashboard/i);
    assert.match(desc, /NOT the user.?s real/i,
      'description must disclaim that open_web renders inside the dashboard, not the real browser');
    assert.match(desc, /browser_navigate|browser_tabs/,
      'description must point users to browser_navigate / browser_tabs for real-browser control');
  });

  it('open_web with a missing type fails (no silent search widget)', async () => {
    const { fn } = makeOpenWeb();
    const result = await fn({ query: 'cats' }); // no type
    assert.equal(result.ok, false, 'missing type must fail, not default to search');
    assert.match(String(result.result), /type/i);
  });

  it('open_web with an unrecognized type fails', async () => {
    const { fn } = makeOpenWeb();
    const result = await fn({ type: 'newtab', query: 'cats' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /youtube|weather|search|flights|image|web/);
  });

  it('open_web still accepts a valid type (weather, with no location, fails honestly)', async () => {
    // 'weather' is valid so it passes the type gate, then fails on missing
    // location — proving the gate isn't over-rejecting valid types.
    const { fn } = makeOpenWeb();
    const result = await fn({ type: 'weather' });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /location/i);
  });
});
