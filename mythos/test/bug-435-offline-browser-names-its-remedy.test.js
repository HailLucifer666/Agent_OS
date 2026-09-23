'use strict';

// test/bug-435-offline-browser-names-its-remedy.test.js
//
// WHY THIS PATH IS SUDDENLY WORTH A TEST. Until 2026-09-11 the browser capability
// rule WITHHELD every browser tool from the Live model whenever the adapter was
// down, so the spoken surface could not reach requireOnline()'s refusal at all.
// Making that rule selfHealing (so a launch inside the session is usable in the
// same session) declared those tools — and thereby made a previously unreachable
// failure path reachable. Widening a surface makes its failure paths part of the
// change.
//
// MEASURED BEFORE THE FIX, with the adapter stubbed OFFLINE and ensureOnline made
// to throw so nothing launched a real browser:
//   calls  : getStatus, getStatus, ensureOnline, getStatus   (BUG-011 bring-up ran)
//   ok     : false
//   result : "Browser automation is OFFLINE. Run setup-chrome-debug.ps1 first."
// Honest about the cause, silent about the way out — and its fallback told the
// model to run a PowerShell script it cannot execute. That is BUG-099 / BUG-107
// inverted: not an unreachable tool named, but no tool named at all.
//
// MUTATION RUN 2026-09-11, each verified applied and restored sha256-identical:
//   drop `remedy:` from browserOfflineRefusal        -> (b) red
//   drop the tool name from its sentence             -> (a) red
//   return the bare hint again (pre-fix behaviour)   -> (a) and (b) red
//   stop passing status.hint through                 -> (c) red
//
// THE NEGATIVE CONTROL IS (e): an ONLINE adapter must produce NO refusal at all.
// Without it this file would pass just as happily against a build that refused
// every browser call unconditionally.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { browserOfflineRefusal } = require('../src/core/effectors/browser-intent-remedy');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

describe('BUG-435 — an offline browser tool names the tool that fixes it', () => {
  test('(a) the sentence names browser_launch_debug, because prose is what the model reads', () => {
    const out = browserOfflineRefusal({ state: 'OFFLINE', hint: 'Run setup-chrome-debug.ps1 first.' });
    assert.equal(out.ok, false);
    assert.match(out.result, /browser_launch_debug/,
      'the 2026-09-10 incident was a refusal whose tools lived only in structured fields; '
      + 'the model acted on none of them');
    assert.match(out.result, /OFFLINE/, 'and it still says what state it found');
  });

  test('(b) it carries a structured remedy whose tool the spoken path can actually reach', () => {
    const out = browserOfflineRefusal({ state: 'OFFLINE' });
    assert.ok(out.remedy, 'live-tool-adapter.js forwards a remedy on a failed dispatch — supply one');
    assert.equal(out.remedy.tool, 'browser_launch_debug');
    assert.ok(out.remedy.why, 'remedy() requires a reason and the model is shown it');
    // The two channels that can make a named tool unreachable, both asserted:
    // remedy() itself validates against TIER_TABLE, and the allowlist decides
    // whether voice can call it. A tool passing one and failing the other is
    // exactly the BUG-099 defect.
    assert.ok(Object.prototype.hasOwnProperty.call(TIER_TABLE, out.remedy.tool), 'must be a real tool');
    assert.ok(DEFAULT_ALLOWLIST.includes(out.remedy.tool), 'and one the spoken path is allowed to call');
  });

  test('(c) the caller\'s hint survives verbatim — bug-011 pins that contract', () => {
    const out = browserOfflineRefusal({ state: 'OFFLINE', hint: 'Run setup-chrome-debug.ps1 first.' });
    assert.match(out.result, /Run setup-chrome-debug\.ps1 first\./,
      'bug-011-browser-auto-connect.test.js asserts an adapter-supplied hint reaches the caller');
  });

  test('(d) no hint is not "undefined", and never a double space', () => {
    // The old line interpolated `${status.hint || fallback}` and could not express
    // "no hint at all". This one can, so it has to do it without leaking the gap.
    const out = browserOfflineRefusal({ state: 'CONNECTING' });
    assert.doesNotMatch(out.result, /undefined|null/);
    assert.doesNotMatch(out.result, /  /, 'a hole where the hint was is still a hole');
    assert.match(out.result, /CONNECTING/, 'and the real state is reported, not flattened to OFFLINE');
  });

  test('(e) NEGATIVE CONTROL: an ONLINE adapter produces no refusal from the real effector', async () => {
    // Asserted through the real requireOnline() path, not the pure builder, so
    // this cannot pass against a build that refuses unconditionally. Also proves
    // the wiring: a builder nothing calls would satisfy (a)-(d) forever.
    const browserAgent = require('../adapters/browser-agent');
    const realStatus = browserAgent.getStatus;
    const realEnsure = browserAgent.ensureOnline;
    const seen = [];
    try {
      browserAgent.getStatus = () => ({ state: 'OFFLINE', hint: 'stub' });
      // Throws so the probe can never launch a browser as a side effect of running.
      browserAgent.ensureOnline = async () => { seen.push('ensureOnline'); throw new Error('stubbed'); };
      const { registerFromBrowser } = require('../src/core/effectors/from-browser');
      const tools = new Map();
      registerFromBrowser({ register: (e) => tools.set(e.id, e) },
        { config: {}, bus: { emit() {} }, logger: { info() {}, warn() {}, error() {} } });

      const offline = await tools.get('browser_navigate').invoke({ url: 'https://example.test' }, {});
      assert.equal(offline.ok, false, 'offline must fail');
      assert.match(offline.result, /browser_launch_debug/, 'and name the way out, through the real effector');
      assert.equal(offline.remedy.tool, 'browser_launch_debug');
      assert.deepEqual(seen, ['ensureOnline'], 'BUG-011 lazy bring-up must still be attempted before refusing');

      // Now the control. ONLINE: requireOnline returns null and nothing refuses.
      browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'attached' });
      const { browserOfflineRefusal: builder } = require('../src/core/effectors/browser-intent-remedy');
      assert.equal(typeof builder, 'function');
      const online = await tools.get('browser_get_title').invoke({}, {});
      assert.ok(!(online && online.ok === false && /browser_launch_debug/.test(String(online.result))),
        'an ONLINE adapter must not produce the offline refusal — got: ' + JSON.stringify(online).slice(0, 200));
    } finally {
      browserAgent.getStatus = realStatus;
      browserAgent.ensureOnline = realEnsure;
    }
  });
});
