'use strict';

// bug-276-f1-browser-recovery-tool-survives-offline.test.js — BUG-276 F1, regression pin.
//
// BUG-276 F1 recorded 13 browser tools withheld from a whole Live session because no
// debuggable browser was on port 9222 (`ECONNREFUSED 127.0.0.1:9222` x6, then
// `browser-automation.standby`), and the 2026-08-20 session audit hit the identical shape.
// F1's verdict — environment, not code — is correct, and tool-capability.js already gets
// the important part right: the LAUNCHER is exempt from the rule that withholds the rest.
//
// This file exists because that exemption had NO test. Withholding browser_launch_debug
// along with the other 13 would withdraw the ladder together with the rungs: the repo's
// documented failure mode is that a withheld tool is not "declined" by the model, it is
// silently substituted with the nearest reachable one and the result is narrated. The
// exemption is one `except:` clause and a future capability refactor could drop it without
// a single test going red — which is exactly how the audit's 13-tool outage would become
// permanent instead of recoverable.
//
// Q3 — WHO ACTUALLY READS THIS? Two consumers, and both are asserted here rather than
// assumed: live-tools.js builds the model's declaration list from checkToolCapability, and
// from-browser.js:908 writes the failure text a model sees when a browser action fails
// while OFFLINE. A capability rule that names a remedy the model cannot reach is BUG-099's
// shape; a failure message that names no remedy at all is the same defect one layer up.
//
// Q8 — PIN THE DISPOSITION. Deliberately NOT changed here: the capability snapshot stays
// frozen for the life of a Live session (live-tools.js:452-456, the known BUG-046/136
// shape), so a browser that comes online mid-session does not restore the other 12 tools
// until the session rotates. That is a real limitation and it is filed, not fixed — the
// refresh-on-reconnect path touches the frozen Gemini Live wire protocol's rotation
// handling (V2 spine §3 / AD-1) and is an operator-sized decision, not a drive-by. What
// this file guarantees is the weaker but sufficient property: the operator always has one
// declared tool that can end the outage.
//
// Run: cd mythos && node --test test/bug-276-f1-browser-recovery-tool-survives-offline.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildFunctionDeclarations, DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
const { buildCapabilitySnapshot, checkToolCapability } = require('../src/core/voice/tool-capability');

function fakeHub(entries) {
  return { catalog: () => entries };
}

// The 13 tools BUG-276 F1 actually lost, verbatim from its log excerpt, plus the two
// recovery tools. Built from the incident, not from the rule.
const WITHHELD_IN_F1 = [
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_get_title', 'browser_get_text', 'browser_tabs', 'browser_dismiss_overlays',
  'browser_check_captcha', 'browser_upload_file', 'browser_select_option',
  'browser_press_key', 'browser_hover',
];
const RECOVERY_TOOLS = ['browser_launch_debug', 'browser_switch'];

function entry(name) {
  return { name: name, description: 'd', params: {}, danger: false, fn: () => {} };
}

// An adapter reporting the exact state of the incident: OFFLINE, because nothing is
// listening on 9222. Not a hand-written `{browserOnline:false}` — the snapshot builder is
// part of what must keep working, and it resolves an unreadable adapter to `true`, so a
// fixture that skipped it could pass while the real path never withheld anything.
const OFFLINE_BROWSER = { browser: { getStatus: () => ({ state: 'OFFLINE' }) } };

describe('BUG-276 F1 — the browser recovery tool must survive the outage it recovers from', () => {
  test('the snapshot really does report the browser as offline', () => {
    // The negative control for every assertion below: if this were true, the tools would
    // all be declared and the tests would pass while proving nothing.
    const snap = buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER });
    assert.equal(snap.browserOnline, false,
      'an adapter reporting OFFLINE must produce browserOnline:false, or nothing here is exercised');
  });

  test('all 13 tools from the incident are withheld, and the 2 recovery tools are not', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER });

    for (const name of WITHHELD_IN_F1) {
      assert.equal(checkToolCapability(name, snap).ok, false, name + ' must be withheld while offline');
    }
    for (const name of RECOVERY_TOOLS) {
      assert.equal(checkToolCapability(name, snap).ok, true,
        name + ' is what makes a browser available — gating it on a browser being available is a deadlock');
    }
  });

  test('the declaration list handed to the model still contains browser_launch_debug', () => {
    // The property that actually matters, asserted at the layer the model sees. A tool
    // that is exempt in the rule but dropped while assembling declarations would be just
    // as unreachable.
    const hub = fakeHub(WITHHELD_IN_F1.concat(RECOVERY_TOOLS).map(entry));
    const { declarations, unavailable } = buildFunctionDeclarations(hub, {
      allowlist: WITHHELD_IN_F1.concat(RECOVERY_TOOLS),
      capability: buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER }),
    });

    const declaredNames = declarations.map((d) => d.name);
    assert.ok(declaredNames.includes('browser_launch_debug'),
      'with every other browser tool withheld this is the only way out of the outage');
    assert.equal(unavailable.length, WITHHELD_IN_F1.length,
      'exactly the incident 13 — a count that drifts means the exemption widened or narrowed');
    assert.ok(!declaredNames.includes('browser_navigate'),
      'and the tools that genuinely cannot work are still withheld');
  });

  test('browser_launch_debug is reachable from the real Live allowlist, not just a test one', () => {
    // A tool exempt from the capability rule but absent from DEFAULT_ALLOWLIST would be
    // withheld one step earlier, by curation, and the exemption would be decorative.
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_launch_debug'));
  });

  test('the withheld reason names the remedy, so the outage is self-describing', () => {
    const snap = buildCapabilitySnapshot({ config: {}, adapters: OFFLINE_BROWSER });
    const cap = checkToolCapability('browser_navigate', snap);

    assert.equal(cap.ok, false);
    assert.match(cap.reason, /browser_launch_debug/,
      'this string is what the log and the model both get; without the remedy in it the '
      + 'model improvises with the nearest reachable tool and narrates the result');
  });
});
