'use strict';

// BUG-065 (Stage 3 of 7) — "stop laundering unverified into it worked".
//
// Proof this was live: vault/Audit/2026-07-31.jsonl record aud-9696f4641ba2
// records {"tool":"spotify_play","outcome":"ok"} with NO `unverified` field,
// while the episodic result in the same second says
// "verified":false,"note":"clicked a play control but the playing title did
// not match the query". The detection logic in cuaPlayViaDriver was already
// correct (it calls evidence.unverified() internally) — the bug is one stack
// frame up in spotify_play, which spread only the inner .result and re-wrapped
// it in a bare ok(), throwing the top-level unverified flag away before
// dispatch-action.js ever got to read it.
//
// Two sub-defects covered here:
//   1. spotify_play's cua-driver caller propagates unverified instead of
//      re-wrapping ok() (the fix in from-spotify.js's cuaResult handling).
//   2. click_at and the keystroke fallback previously ran NO now-playing
//      check at all — bare ok() unconditionally. They now share the same
//      window-title oracle (verifyPlaybackAgainstQuery / titleSatisfiesQuery).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
const evidence = require('../src/core/effectors/evidence');

describe('BUG-065a: spotify_play propagates unverified from the cua-driver path instead of re-wrapping ok()', () => {
  let dir, fs, hub, bus, cuaDriver, originalGetStatus, originalInvoke;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    cuaDriver = require('../adapters/cua-driver');
    originalGetStatus = cuaDriver.getStatus;
    originalInvoke = cuaDriver.invoke;
    cuaDriver.getStatus = () => ({ state: 'ONLINE', hint: null, queueDepth: 0 });
    cuaDriver.invoke = async (toolName) => {
      if (toolName === 'list_windows') {
        // Title never becomes "Artist - Track" for the requested query — a
        // click lands, but on the wrong thing (mirrors the recorded case).
        return { ok: true, result: { structuredContent: { windows: [
          { app_name: 'Spotify.exe', pid: 4242, window_id: 987, title: 'The Kid LAROI - BACK 2 LOVE', minimized: false }
        ] } } };
      }
      if (toolName === 'bring_to_front') return { ok: true, result: { content: [] } };
      if (toolName === 'get_window_state') {
        return { ok: true, result: { structuredContent: { elements: [
          { element_index: 0, role: 'Button', label: 'Play Down by The Kid LAROI' }
        ] } } };
      }
      if (toolName === 'click') {
        return { ok: true, result: { content: [], structuredContent: { verified: true, effect: 'invoked' } } };
      }
      return { ok: false, result: `unexpected cua tool: ${toolName}` };
    };

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };
    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => {
    cuaDriver.getStatus = originalGetStatus;
    cuaDriver.invoke = originalInvoke;
    cleanupVaultDir(dir);
  });

  it('surfaces unverified:true and the honest reason at the top level, not a bare ok:true', async () => {
    const result = await hub.invoke('spotify_play', { query: 'The Kid LAROI Down' }, {});
    assert.equal(result.ok, true, 'a click did land, so this is not a failure');
    assert.equal(result.unverified, true,
      'the OLD bug: this flag was dropped when spotify_play re-wrapped cuaResult.result in a bare ok()');
    assert.match(result.reason, /BACK 2 LOVE/, 'the honest reason must name what is actually playing');
    assert.match(result.reason, /not what was asked for/);
    assert.equal(evidence.isVerified(result), false);
    assert.equal(result.result.method, 'cua-driver');
    assert.equal(result.result.nowPlaying, 'The Kid LAROI - BACK 2 LOVE');
  });
});

describe('BUG-065b: click_at fallback runs the now-playing oracle instead of a bare ok()', () => {
  function makeHub(finalTitle) {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    let listWindowsCalls = 0;
    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          listWindowsCalls++;
          // First call (getSpotifyWindow before click) sees the idle title;
          // the post-click verify call sees whatever the test wants to prove.
          const title = listWindowsCalls === 1 ? 'Spotify' : finalTitle;
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return { ok: true, result: { elements: [
            { name: 'Play', type: 'ControlType.Button', automationId: 'play-button', rect: { x: 100, y: 200, width: 40, height: 40 } }
          ] } };
        }
        if (tool === 'click_at') return { ok: true, result: { clicked: true, x: args.x, y: args.y } };
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };
    registerFromSpotify(hub, { effectors: mockPcEffectors });
    return { dir, hub };
  }

  it('reports unverified:true (never a bare ok:true) when the title never matches the query', async () => {
    const { dir, hub } = makeHub('Spotify Premium'); // never starts playing
    try {
      const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody Queen' }, {});
      assert.equal(result.ok, true, 'click_at itself succeeded');
      assert.equal(result.unverified, true, 'OLD bug: click_at was a bare ok() with no oracle at all');
      assert.equal(result.result.method, 'click_at');
      assert.ok(result.reason, 'must carry a spoken-usable reason');
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('reports a verified ok (window-title oracle, unverified:false) when the title matches', async () => {
    const { dir, hub } = makeHub('Queen - Bohemian Rhapsody');
    try {
      const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody Queen' }, {});
      assert.equal(result.ok, true);
      assert.equal(result.unverified, false);
      assert.equal(evidence.isVerified(result), true);
      assert.equal(result.evidence.oracle, 'window-title');
      assert.equal(result.result.method, 'click_at');
    } finally {
      cleanupVaultDir(dir);
    }
  });
});
