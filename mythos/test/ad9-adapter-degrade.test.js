'use strict';

// test/ad9-adapter-degrade.test.js — AD-9 cross-adapter degrade harness
// (spine §1): "optional binaries degrade, never crash boot." Force the
// binary absent and boot must still complete, with status honestly
// reporting OFFLINE plus an install hint.
//
// GAP THIS CLOSES: test/cua-driver-adapter.test.js only *observes* whatever
// the real machine happens to have — on a box WITH cua-driver installed
// (this one, cua-driver-rs 0.8.3) it never actually exercises the ENOENT
// path. pc-child, browser-agent, and android-child had no equivalent
// coverage at all. This file *injects* a forced ENOENT via the shared
// harness in test/helpers/mock-spawn-enoent.js so every adapter's degrade
// path is exercised deterministically, regardless of what happens to be
// installed on the machine running the suite.
//
// STATUS-SHAPE MISMATCH ACROSS THE FOUR ADAPTERS (the actual work here):
//   pc-child:      { state, hint, queueDepth }            — STARTING exists
//   cua-driver:    { state, hint, queueDepth }             — STARTING exists
//   android-child: { state, hint, devices, queueDepth }    — no STARTING
//                  (spawnSync probe settles synchronously)
//   browser-agent: { state, mode, hint, cdpUrl, pageCount } — CONNECTING
//                  instead of STARTING; no queueDepth; adds mode/pageCount
// Each adapter below is asserted against its OWN shape, not a shared one.
//
// RED-FIRST EVIDENCE (see report): before this file was written, a scratch
// test asserted `status.state === 'ONLINE'` for cua-driver under this exact
// harness and FAILED with actual 'OFFLINE' — proving the injection is real:
// this machine has cua-driver genuinely installed, so a no-op harness would
// have let that (deliberately wrong) assertion pass by observing the real
// environment's ONLINE state instead.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { requireFreshUnderEnoentMock } = require('./helpers/mock-spawn-enoent');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

async function pollUntilSettled(getStatus, isTerminal, deadlineMs) {
  let status = getStatus();
  const deadline = Date.now() + deadlineMs;
  while (!isTerminal(status) && Date.now() < deadline) {
    await sleep(100);
    status = getStatus();
  }
  return status;
}

function assertHintExplainsFailure(hint) {
  assert.ok(hint, 'must carry a hint explaining why it is offline');
  const lower = hint.toLowerCase();
  assert.ok(
    lower.indexOf('not found') !== -1 ||
    lower.indexOf('failed') !== -1 ||
    lower.indexOf('timed out') !== -1 ||
    lower.indexOf('enoent') !== -1 ||
    lower.indexOf('install') !== -1 ||
    lower.indexOf("doesn't exist") !== -1,
    'hint should explain the failure, got: ' + hint
  );
}

describe('AD-9 cross-adapter degrade harness — forced ENOENT', function() {

  it('pc-child: forced powershell.exe ENOENT -> boot completes, OFFLINE, hint present', async function() {
    const { module: pcChild, cleanup } = requireFreshUnderEnoentMock(require.resolve('../adapters/pc-child'));
    try {
      assert.doesNotThrow(function() { pcChild.startPcChild(); }, 'startPcChild() must never throw even when its child binary is missing');

      const status = await pollUntilSettled(
        pcChild.getStatus,
        function(s) { return s.state !== 'STARTING'; },
        5000
      );

      assert.equal(status.state, 'OFFLINE', 'must settle OFFLINE, never crash boot');
      assertHintExplainsFailure(status.hint);
      assert.equal(status.queueDepth, 0);

      assert.doesNotThrow(function() { pcChild.shutdownPcChild(); });
    } finally {
      cleanup();
    }
  });

  it('cua-driver: forced cua-driver(.exe) ENOENT -> boot completes, OFFLINE, hint present', async function() {
    const { module: cuaDriver, cleanup } = requireFreshUnderEnoentMock(require.resolve('../adapters/cua-driver'));
    try {
      assert.doesNotThrow(function() { cuaDriver.startCuaDriver(); });

      const status = await pollUntilSettled(
        cuaDriver.getStatus,
        function(s) { return s.state !== 'STARTING'; },
        5000
      );

      assert.equal(status.state, 'OFFLINE', 'must settle OFFLINE, never crash boot');
      assertHintExplainsFailure(status.hint);
      assert.ok(
        status.hint.toLowerCase().indexOf('not found on path') !== -1,
        'cua-driver hint should explicitly say the binary is not on PATH, got: ' + status.hint
      );
      assert.equal(status.queueDepth, 0);

      // invoke() must also degrade, never throw, while OFFLINE.
      const result = await cuaDriver.invoke('click_at_uia_hittest', { x: 1, y: 2 });
      assert.equal(result.ok, false);

      assert.doesNotThrow(function() { cuaDriver.shutdownCuaDriver(); });
    } finally {
      cleanup();
    }
  });

  it('android-child: forced adb ENOENT (spawnSync) -> boot completes synchronously, OFFLINE, install hint present', function() {
    // No STARTING state exists for this adapter (spawnSync probe settles
    // before startAndroidChild() even returns) — different status shape
    // from pc-child/cua-driver, asserted directly with no polling needed.
    const { module: androidChild, cleanup } = requireFreshUnderEnoentMock(require.resolve('../adapters/android-child'));
    try {
      assert.doesNotThrow(function() { androidChild.startAndroidChild(); });

      const status = androidChild.getStatus();
      assert.equal(status.state, 'OFFLINE', 'must settle OFFLINE synchronously, never crash boot');
      assertHintExplainsFailure(status.hint);
      assert.ok(
        status.hint.indexOf('setup-android.js --install') !== -1,
        'android-child hint should name the install script, got: ' + status.hint
      );
      assert.deepEqual(status.devices, [], 'no devices can be enumerated while adb is absent');
      assert.equal(status.queueDepth, 0);

      assert.doesNotThrow(function() { androidChild.shutdownAndroidChild(); });
    } finally {
      cleanup();
    }
  });

  describe('browser-agent — boundary mock (see note on why child_process-level ENOENT cannot reach it)', function() {
    // browser-agent never calls child_process.spawn/spawnSync for its own
    // "optional binary" (a local Chrome/Edge). It delegates entirely to
    // playwright-core, whose launcher preflight-checks the executable path
    // with fs.existsSync BEFORE ever calling spawn, and throws its own
    // friendly "Executable doesn't exist ... npx playwright install" Error
    // instead of letting a raw ENOENT propagate. Confirmed by reading
    // node_modules/playwright-core/lib/coreBundle.js, which contains that
    // exact message. So mock-spawn-enoent.js's child_process-level injection
    // has nothing to intercept here — there is no spawn call for a missing
    // browser to fail. Also, per src/main.js's actual boot sequence,
    // browser-agent's boot-time call is connect() (CDP, a network dial to
    // an already-running debug Chrome), not launchLocal() (which spawns a
    // browser) — launchLocal only runs when an effector explicitly asks for
    // it. The faithful equivalent test therefore mocks one layer up, at the
    // playwright-core boundary itself, reusing the exact interception
    // pattern test/browser-auto-connect-poller.test.js already established
    // for this adapter (Module.prototype.require override + cache-clear).
    const originalRequire = Module.prototype.require;
    const ADAPTER_PATH = path.resolve(__dirname, '../adapters/browser-agent/index.js');

    function withMockedPlaywright(mockChromium, fn) {
      Module.prototype.require = function(id) {
        if (id === 'playwright-core') return { chromium: mockChromium };
        return originalRequire.apply(this, arguments);
      };
      delete require.cache[ADAPTER_PATH];
      try {
        return fn(require(ADAPTER_PATH));
      } finally {
        Module.prototype.require = originalRequire;
        delete require.cache[ADAPTER_PATH];
      }
    }

    it('launchLocal(): forced "Executable doesn\'t exist" (playwright\'s real shape for a missing browser binary) -> boot completes, OFFLINE, install hint present', async function() {
      // Mirrors playwright-core's real error text verbatim (confirmed in
      // coreBundle.js) so the adapter's plain `hint = 'launchLocal failed: '
      // + err.message` naturally carries playwright's own install
      // instructions through to the operator.
      const enoentLikeError = new Error(
        "browserType.launchPersistentContext: Executable doesn't exist at " +
        'C:\\fake\\path\\chrome.exe\nLooking to install a supported browser? ' +
        'Run "npx playwright install chrome"'
      );

      const mockChromium = {
        launchPersistentContext: function() { return Promise.reject(enoentLikeError); },
      };

      await withMockedPlaywright(mockChromium, async function(browserAgent) {
        let ok;
        await assert.doesNotReject(async function() {
          ok = await browserAgent.launchLocal('C:\\fake\\user-data-dir');
        }, 'launchLocal() must never throw even when the browser binary is missing');

        assert.equal(ok, false);

        const status = browserAgent.getStatus();
        assert.equal(status.state, 'OFFLINE', 'must settle OFFLINE, never crash boot');
        assertHintExplainsFailure(status.hint);
        assert.ok(
          status.hint.indexOf("doesn't exist") !== -1 && status.hint.indexOf('playwright install') !== -1,
          'browser-agent hint should carry the missing-binary + install instructions through verbatim, got: ' + status.hint
        );
      });
    });
  });
});
