'use strict';
// browser-task-wiring.test.js — every seam browser_task plugs into, asserted through the
// real modules (a real leash, the real allowlist, the real capability rules, the real
// location resolver on a temp dir), not through source text.
//
// Mutation probes, 2026-09-08 (each applied, seen to fail the named test, restored):
//   (a) tiers.js: delete the browser_task row -> "browser_task is tier 3" fails.
//   (b) leash/index.js: delete browser_task from OPERATOR_TRUSTED_DEFAULT -> "a spoken
//       browser_task is hands-free; the autonomous loop still is not" fails.
//   (c) live-tools.js: delete 'browser_task' from DEFAULT_ALLOWLIST -> "Live can declare it" fails.
//   (d) tool-capability.js: delete the browser-task rule -> "withheld with the install hint
//       when the runner is missing" fails.
//   (e) browser-use-location.js: `version !== BROWSER_USE_PINNED_VERSION` -> `false` ->
//       "a wrong installed version is refused with the pin named" fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { TIER_TABLE } = require('../src/core/leash/tiers');
const { makeLeash } = require('./helpers/leash-fixture');
const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
const { buildCapabilitySnapshot, checkToolCapability } = require('../src/core/voice/tool-capability');
const loc = require('../src/core/browser-use-location');
const { STEPS } = require('../scripts/golden-path');
const { SCHEMA } = require('../src/core/config/schema');

test('browser_task is tier 3, the class of browser_click and browser_fill_form', () => {
  assert.equal(TIER_TABLE.browser_task, 3);
  assert.equal(TIER_TABLE.browser_task, TIER_TABLE.browser_fill_form);
});

test('a spoken browser_task is hands-free; the autonomous loop still is not', () => {
  const leash = makeLeash();
  const spoken = leash.check({ tool: 'browser_task', args: { task: 'play the second video' } }, { connectionId: 'conn-operator' });
  assert.equal(spoken.allow, true);
  assert.equal(spoken.reason, 'operator-present-trusted');
  const cortex = leash.check({ tool: 'browser_task', args: { task: 'play the second video' } }, { goalId: 'goal-x' });
  assert.notEqual(cortex.reason, 'operator-present-trusted', 'no connectionId, no trust');
  assert.equal(cortex.allow, false);
});

test('Live can declare it', () => {
  assert.ok(DEFAULT_ALLOWLIST.includes('browser_task'));
});

test('withheld with the install hint when the runner is missing; declarable when installed', () => {
  const missing = buildCapabilitySnapshot({ config: {}, adapters: { browserUse: { getStatus: () => ({ state: 'OFFLINE' }) } } });
  const r = checkToolCapability('browser_task', missing);
  assert.equal(r.ok, false);
  assert.match(r.reason, /setup-browser-use\.js --install/);
  const installed = buildCapabilitySnapshot({ config: {}, adapters: { browserUse: { getStatus: () => ({ state: 'ONLINE' }) } } });
  assert.equal(checkToolCapability('browser_task', installed).ok, true);
  // Sibling rule untouched: a browser_* tool is still gated on the browser, not on the runner.
  assert.equal(checkToolCapability('browser_click', buildCapabilitySnapshot({ config: {}, adapters: { browser: { getStatus: () => ({ state: 'OFFLINE' }) } } })).ok, false);
});

function fakeInstall(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-loc-'));
  const python = loc.pythonPath(home);
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  if (version) fs.mkdirSync(path.join(loc.venvDir(home), 'Lib', 'site-packages', 'browser_use-' + version + '.dist-info'), { recursive: true });
  return home;
}

test('a wrong installed version is refused with the pin named; the pinned one is accepted; nothing installed says so', () => {
  const wrong = loc.findInstalled({ MYTHOS_BROWSER_USE_INSTALL_DIR: fakeInstall('0.0.1') });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, new RegExp('0\\.0\\.1 is installed but ' + loc.BROWSER_USE_PINNED_VERSION.replace(/\./g, '\\.') + ' is pinned'));
  const right = loc.findInstalled({ MYTHOS_BROWSER_USE_INSTALL_DIR: fakeInstall(loc.BROWSER_USE_PINNED_VERSION) });
  assert.equal(right.ok, true);
  assert.equal(right.version, loc.BROWSER_USE_PINNED_VERSION);
  const none = loc.findInstalled({ MYTHOS_BROWSER_USE_INSTALL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bu-none-')) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /not installed/);
});

test('setup-browser-use.js --check exits 1 on a version mismatch and 0 on the pin', () => {
  const script = path.join(__dirname, '..', 'scripts', 'setup-browser-use.js');
  const run = (home) => spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, MYTHOS_BROWSER_USE_INSTALL_DIR: home } });
  assert.equal(run(fakeInstall('0.0.1')).status, 1);
  assert.equal(run(fakeInstall(loc.BROWSER_USE_PINNED_VERSION)).status, 0);
});

test('the golden path accepts browser_task as proof for open and next, and the model is told to use it', () => {
  assert.ok(STEPS.find((s) => s.id === 'open').anyOf.includes('browser_task'));
  assert.ok(STEPS.find((s) => s.id === 'next').anyOf.includes('browser_task'));
  const { RULES } = require('../src/core/voice/voice-agent');
  assert.match(String(RULES), /call browser_task once/);
  assert.equal(SCHEMA.BROWSER_USE_MODEL.default, 'google/gemini-3.6-flash');
});
