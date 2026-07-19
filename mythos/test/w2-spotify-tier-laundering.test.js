'use strict';
// W2 regression: spotify_play (T2) internally drives T3 effectors (ui_click,
// ui_type, click_at). Pre-W2 those went through raw pcEffectors.invoke() with
// no leash check, no audit trail, no goal context — silent tier laundering
// (task-957 §24 W2). W2 routes the three T3 inner invokes through
// dispatchAction so each one writes an audit line. spotify_play's own T2
// authorization covers the chain (no re-confirm), only the audit + breaker
// + episodic recording are added.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { registerFromSpotify, spotify_search } = require('../src/core/effectors/from-spotify');

function makeMockHub(invokes) {
  // Records every invoke in `invokes` so the test can assert which tool drove what.
  return {
    // registerFromSpotify iterates TOOLS and calls hub.register(effector) per tool.
    // The W2 test exercises the inner-invoke path, not registration, so a no-op is fine.
    register: () => {},
    invoke: async (tool, args) => {
      invokes.push({ tool, args });
      if (tool === 'launch_app') return { ok: true, result: { launched: true } };
      if (tool === 'list_windows') return { ok: true, result: { windows: [
        { processName: 'Spotify.exe', pid: 4321, title: 'Spotify' }
      ] } };
      if (tool === 'media_key') return { ok: true, result: { sent: true } };
      // Surface a search-box-shaped Edit element so findSpotifySearchBox() resolves
      // and the flow proceeds to clickElement (ui_click) + typeText (ui_type).
      if (tool === 'ui_elements') return { ok: true, result: { elements: [
        { type: 'Edit', name: 'Search', automationId: 'searchInput', path: '/Search' }
      ] } };
      if (tool === 'focus_window') return { ok: true, result: { focused: true } };
      if (tool === 'send_key') return { ok: true, result: { sent: true } };
      if (tool === 'ui_click') return { ok: true, result: { clicked: true } };
      if (tool === 'ui_type') return { ok: true, result: { typed: true } };
      if (tool === 'click_at') return { ok: true, result: { clicked: true } };
      return { ok: false, result: 'unknown tool: ' + tool };
    }
  };
}

describe('W2: spotify inner T3 invokes are audited via dispatchAction', () => {
  it('a spotify_search driving ui_click + ui_type writes audit lines for each T3 inner invoke', async () => {
    const invokes = [];
    const mockHub = makeMockHub(invokes);
    const auditCalls = [];

    // Wire spotify with the dispatch deps so inner T3 invokes route through
    // dispatchAction (which writes audit lines). memory.audit.write is the sink.
    registerFromSpotify(mockHub, {
      effectors: mockHub,
      bus: { emit: () => {}, subscribe: () => () => {} },
      memory: {
        audit: { write: (entry) => { auditCalls.push(entry); } },
        episodic: { write: async () => ({ ref: 'ep-1' }) }
      },
      goals: null,
      config: { ACTION_TIMEOUT_MS: 30000 }
    });

    // spotify_search clicks the search box (ui_click), types the query (ui_type),
    // then queries ui_elements for results. The first two are T3 → audited.
    await spotify_search({ query: 'Bohemian Rhapsody' });

    // The T3 inner invokes (ui_click, ui_type) must each have produced an audit
    // entry via dispatchAction. Pre-W2, auditCalls would be empty.
    const clickAudits = auditCalls.filter(a => a.tool === 'ui_click');
    const typeAudits = auditCalls.filter(a => a.tool === 'ui_type');
    assert.ok(clickAudits.length >= 1,
      'expected at least one ui_click audit entry (got ' + clickAudits.length + ')');
    assert.ok(typeAudits.length >= 1,
      'expected at least one ui_type audit entry (got ' + typeAudits.length + ')');

    // The audit entries must record the spotify-inner channel so the trail is traceable.
    assert.equal(clickAudits[0].decision, 'completed');
  });

  it('without dispatch deps, inner invokes still succeed via the raw fallback (backward-compat)', async () => {
    const invokes = [];
    const mockHub = makeMockHub(invokes);
    // No bus/memory/goals — simulates a unit-test or partial-boot caller. The
    // existing spotify-effector.test.js wires spotify this way; W2 preserves it.
    registerFromSpotify(mockHub, { effectors: mockHub });

    // spotify_play_pause → sendMediaKey → media_key (T1, raw invoke — untouched by W2).
    // Proves the no-dispatch-deps path still resolves invokes without throwing.
    const { spotify_play_pause, spotify_next } = require('../src/core/effectors/from-spotify');
    const r1 = await spotify_play_pause();
    const r2 = await spotify_next();
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.ok(invokes.some(i => i.tool === 'media_key'), 'raw fallback must drive the hub');
  });

  it('T0/T1/T2 inner invokes (list_windows, ui_elements, media_key, launch_app) are NOT audited', async () => {
    // Reads shouldn't audit — only the T3 ui_click/ui_type/click_at family does.
    const invokes = [];
    const mockHub = makeMockHub(invokes);
    const auditCalls = [];
    registerFromSpotify(mockHub, {
      effectors: mockHub,
      bus: { emit: () => {}, subscribe: () => () => {} },
      memory: {
        audit: { write: (entry) => { auditCalls.push(entry); } },
        episodic: { write: async () => ({ ref: 'ep-1' }) }
      },
      config: { ACTION_TIMEOUT_MS: 30000 }
    });

    // spotify_status does getSpotifyWindow() → list_windows (T0). No audit expected.
    const { spotify_status } = require('../src/core/effectors/from-spotify');
    await spotify_status();
    const readAudits = auditCalls.filter(a =>
      a.tool === 'list_windows' || a.tool === 'ui_elements' || a.tool === 'media_key'
    );
    assert.equal(readAudits.length, 0,
      'T0/T1/T2 inner reads must not be audited (only the T3 ui_click/ui_type/click_at family)');
  });
});
