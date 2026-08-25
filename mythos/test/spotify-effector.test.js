'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

const { TOOLS: SPOTIFY_TOOLS } = require('../src/core/effectors/from-spotify');
const { registerFromSpotify } = require('../src/core/effectors/from-spotify');

describe('effectors/from-spotify: Spotify effector registration', () => {
  let dir, fs, hub, bus;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    // Mock PC effectors for delegation
    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') return { ok: true, result: { windows: [] } };
        if (tool === 'media_key') return { ok: true, result: { sent: true } };
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        if (tool === 'ui_click') return { ok: true, result: { clicked: true } };
        if (tool === 'ui_type') return { ok: true, result: { typed: true } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('registers all 7 Spotify tools', () => {
    assert.equal(SPOTIFY_TOOLS.length, 7);
    const names = SPOTIFY_TOOLS.map(t => t.name);
    assert.deepEqual(names.sort(), [
      'spotify_play',
      'spotify_play_pause',
      'spotify_previous',
      'spotify_next',
      'spotify_search',
      'spotify_status',
      'spotify_volume'
    ].sort());
  });

  it('all tools have required fields', () => {
    for (const tool of SPOTIFY_TOOLS) {
      assert.ok(tool.name, 'tool has name');
      assert.ok(tool.description, 'tool has description');
      assert.ok(typeof tool.fn === 'function', 'tool has fn');
      assert.ok(typeof tool.danger === 'boolean', 'tool has danger boolean');
    }
  });

  it('hub.count() includes Spotify tools', () => {
    // We registered 7 tools from Spotify + whatever else was registered before
    // The test hub only has Spotify tools registered
    assert.equal(hub.count(), 7);
  });

  it('hub.get() returns registered Spotify effectors', () => {
    for (const tool of SPOTIFY_TOOLS) {
      const effector = hub.get(tool.name);
      assert.ok(effector, `effector ${tool.name} registered`);
      assert.equal(effector.id, tool.name);
      assert.ok(typeof effector.invoke === 'function', 'effector has invoke');
    }
  });
});

describe('gate: Spotify tier mapping', () => {
  it('media controls (play_pause, next, previous, volume) are T2', () => {
    assert.equal(tierOf('spotify_play_pause'), 2);
    assert.equal(tierOf('spotify_next'), 2);
    assert.equal(tierOf('spotify_previous'), 2);
    assert.equal(tierOf('spotify_volume'), 2);
  });

  it('status check is T2', () => {
    assert.equal(tierOf('spotify_status'), 2);
  });

  it('play and search are T2 (re-tiered from T3 — confirmation-policy pass)', () => {
    // Was T3 confirm-once-per-goal; local Spotify playback carries no
    // destructive/outward-facing risk, so a confirm popup on "play a song"
    // was pure friction. See leash/tiers.js's T2 block comment.
    assert.equal(tierOf('spotify_play'), 2);
    assert.equal(tierOf('spotify_search'), 2);
  });

  it('no Spotify tool requires a T3+ confirm anymore', () => {
    // The voice agent computes danger from tierOf at runtime — every
    // Spotify tool (transport controls, play, search, status) is now T2.
    const spotifyToolNames = [
      'spotify_play_pause', 'spotify_next', 'spotify_previous',
      'spotify_volume', 'spotify_status', 'spotify_play', 'spotify_search',
    ];
    for (const name of spotifyToolNames) {
      assert.equal(tierOf(name) >= 3, false, `${name} should no longer require a confirm`);
    }
  });
});

describe('Spotify tool parameter validation', () => {
  let dir, fs, hub, bus, mockPcEffectors;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        // Non-empty so spotify_status resolves on the first getSpotifyWindow()
        // attempt — an empty windows:[] here would now retry 4x with real
        // backoff delays (Phase 2a's cold-launch retry loop), needlessly
        // slowing this param-validation suite, which isn't testing the
        // not-found/retry path at all.
        if (tool === 'list_windows') return { ok: true, result: { windows: [{ pid: 1, processName: 'Spotify.exe', title: 'Spotify' }] } };
        if (tool === 'media_key') return { ok: true, result: { sent: true } };
        if (tool === 'set_volume') return { ok: true, result: { level: args && args.level } };
        // BUG-127: the level path is per-app now (Spotify's own Core Audio
        // session), so the delegate it reaches for changed under this test.
        if (tool === 'set_app_volume') return { ok: true, result: { level: args && args.level, count: 1 } };
        // BUG-161: direction is per-app too — read current, step, read back;
        // mute drives the session's own flag.
        if (tool === 'get_app_volume') return { ok: true, result: { level: 50, muted: false, count: 1 } };
        if (tool === 'set_app_mute') return { ok: true, result: { muted: !!(args && args.mute), count: 1 } };
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        if (tool === 'ui_click') return { ok: true, result: { clicked: true } };
        if (tool === 'ui_type') return { ok: true, result: { typed: true } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('spotify_volume requires direction parameter', async () => {
    const result = await hub.invoke('spotify_volume', {}, {});
    assert.equal(result.ok, false);
    assert.ok(result.result.toLowerCase().includes('direction'));
  });

  it('spotify_volume accepts up/down/mute', async () => {
    for (const dir of ['up', 'down', 'mute']) {
      const result = await hub.invoke('spotify_volume', { direction: dir }, {});
      assert.equal(result.ok, true);
    }
  });

  it('spotify_volume rejects invalid direction', async () => {
    const result = await hub.invoke('spotify_volume', { direction: 'sideways' }, {});
    assert.equal(result.ok, false);
  });

  // REMEDIATION P1-8: "reduce the volume to 20%" is now expressible via level.
  // Ordered before the out-of-range test below: 3 consecutive failures on the
  // same tool trips the effector hub's circuit breaker, which would otherwise
  // short-circuit ("circuit-open") these still-valid calls.
  it('spotify_volume with level routes to set_app_volume (per-app), with an exact target', async () => {
    const result = await hub.invoke('spotify_volume', { level: 20 }, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.level, 20);
  });

  it('spotify_volume prefers level over direction when both are given', async () => {
    const result = await hub.invoke('spotify_volume', { level: 35, direction: 'up' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.level, 35);
  });

  it('spotify_volume rejects an out-of-range level', async () => {
    for (const bad of [-1, 101, 150]) {
      const result = await hub.invoke('spotify_volume', { level: bad }, {});
      assert.equal(result.ok, false);
    }
  });

  it('spotify_play requires query or trackId', async () => {
    const result = await hub.invoke('spotify_play', {}, {});
    assert.equal(result.ok, false);
    assert.ok(result.result.includes('required'));
  });

  it('spotify_search requires query', async () => {
    const result = await hub.invoke('spotify_search', {}, {});
    assert.equal(result.ok, false);
    assert.ok(result.result.includes('required'));
  });

  it('spotify_status takes no required params', async () => {
    const result = await hub.invoke('spotify_status', {}, {});
    assert.equal(result.ok, true);
  });
});

describe('spotify_status: playing derived from window-title oracle', () => {
  function makeStatusHub(title) {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    const mockPcEffectors = {
      invoke: async (tool) => {
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title }] } };
        }
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };
    registerFromSpotify(hub, { effectors: mockPcEffectors });
    return { hub, dir };
  }

  it('title "Artist - Track" reports playing:true', async () => {
    const { hub, dir } = makeStatusHub('Radiohead - Karma Police');
    const result = await hub.invoke('spotify_status', {}, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.running, true);
    assert.equal(result.result.playing, true);
    cleanupVaultDir(dir);
  });

  it('title "Spotify" (idle) reports playing:false', async () => {
    const { hub, dir } = makeStatusHub('Spotify');
    const result = await hub.invoke('spotify_status', {}, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.running, true);
    assert.equal(result.result.playing, false);
    cleanupVaultDir(dir);
  });

  it('title "Spotify Premium" (idle) reports playing:false', async () => {
    const { hub, dir } = makeStatusHub('Spotify Premium');
    const result = await hub.invoke('spotify_status', {}, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.running, true);
    assert.equal(result.result.playing, false);
    cleanupVaultDir(dir);
  });

  // Empty windows:[] triggers getSpotifyWindow's real 4x cold-launch retry
  // with backoff (see the comment on the param-validation suite above) — this
  // one case is unavoidably ~5s slower than the others to exercise the actual
  // not-running path honestly.
  it('Spotify not running reports running:false, playing:false', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    const mockPcEffectors = {
      invoke: async (tool) => {
        if (tool === 'list_windows') return { ok: true, result: { windows: [] } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };
    registerFromSpotify(hub, { effectors: mockPcEffectors });
    const result = await hub.invoke('spotify_status', {}, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.running, false);
    assert.equal(result.result.playing, false);
    cleanupVaultDir(dir);
  });
});

describe('Spotify effector integration with tier table', () => {
  it('all Spotify tool names exist in TIER_TABLE', () => {
    const spotifyToolNames = [
      'spotify_play_pause',
      'spotify_next',
      'spotify_previous',
      'spotify_volume',
      'spotify_status',
      'spotify_play',
      'spotify_search'
    ];

    for (const name of spotifyToolNames) {
      assert.ok(name in TIER_TABLE, `${name} must be in TIER_TABLE`);
      assert.ok(typeof TIER_TABLE[name] === 'number', `${name} tier must be a number`);
      assert.ok(TIER_TABLE[name] >= 0 && TIER_TABLE[name] <= 4, `${name} tier must be 0-4`);
    }
  });

  it('no duplicate tier entries', () => {
    // Verify our edit didn't create duplicates
    const allKeys = Object.keys(TIER_TABLE);
    const uniqueKeys = new Set(allKeys);
    assert.equal(allKeys.length, uniqueKeys.size, 'TIER_TABLE has duplicate keys');
  });
});

describe('BUG-001: spotify_play focuses the Spotify window before send_key', () => {
  let dir, fs, hub, bus, callOrder;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    callOrder = [];

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        callOrder.push(tool);
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        // No identifiable play control -- forces the click_at path to bail
        // and fall back to the keystroke path this test is asserting on.
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        if (tool === 'send_key') return { ok: true, result: { sent: true } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('invokes focus_window (with the matched pid) before send_key', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody' }, {});
    assert.equal(result.ok, true);

    const focusIdx = callOrder.indexOf('focus_window');
    const sendKeyIdx = callOrder.indexOf('send_key');
    assert.ok(focusIdx !== -1, 'focus_window was invoked');
    assert.ok(sendKeyIdx !== -1, 'send_key was invoked');
    assert.ok(focusIdx < sendKeyIdx, 'focus_window must be invoked before send_key');
  });
});

describe('BUG-026: spotify_play sends Tab before Enter (focus-shift off the search box)', () => {
  // NOTE ON VERIFICATION: this is a call-order/call-args regression guard only.
  // BUG-026 itself was a *previous* call-order-only mock "passing" while real
  // playback still failed (Enter was landing in the search box, not a result
  // tile) -- a mock like this one cannot detect that class of failure. This
  // test only guards against the Tab-before-Enter code path regressing; it is
  // NOT a substitute for live verification against the real Spotify client.
  let dir, fs, hub, bus, sendKeyCalls;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    sendKeyCalls = [];

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'send_key') sendKeyCalls.push(args.key);
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        // No identifiable play control -- forces the click_at path to bail
        // and fall back to the keystroke path this test is asserting on.
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('sends tab, then enter (in that order) after focusing the window', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Moods Mild Oranges' }, {});
    assert.equal(result.ok, true);
    assert.deepEqual(sendKeyCalls, ['tab', 'enter'], 'must send tab before enter, not enter alone');
  });
});

describe('BUG-026 (3rd attempt): spotify_play clicks the play control via click_at when ui_elements finds one', () => {
  let dir, fs, hub, bus, callOrder, clickAtArgs;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    callOrder = [];
    clickAtArgs = null;

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        callOrder.push(tool);
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return {
            ok: true,
            result: {
              elements: [
                {
                  name: 'Play',
                  type: 'ControlType.Button',
                  automationId: 'play-button',
                  rect: { x: 100, y: 200, width: 40, height: 40 }
                }
              ]
            }
          };
        }
        if (tool === 'click_at') {
          clickAtArgs = args;
          return { ok: true, result: { clicked: true, x: args.x, y: args.y } };
        }
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('computes the play control center and calls click_at instead of send_key', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody' }, {});
    assert.equal(result.ok, true);
    assert.ok(clickAtArgs, 'click_at was invoked');
    assert.equal(clickAtArgs.x, 120, 'center x = rect.x + rect.width/2');
    assert.equal(clickAtArgs.y, 220, 'center y = rect.y + rect.height/2');
    assert.ok(!callOrder.includes('send_key'), 'send_key must not be used when click_at succeeds');
  });
});

// Wave 3 (2026-08-13): a REAL play control was located this time — the failure
// mode this guards is different from "no play control was found" below.
// click_at is a real SendInput mouse click at a physical screen coordinate
// (Handle-ClickAt -> Click-AtScreenCoords), not a background-posted click like
// cua-driver's — there is no foreground delivery mode to retry into. When that
// real click fails, falling back to a blind Tab+Enter keystroke guess (the
// exact unreliable behavior BUG-026's 3rd-attempt comment already explains)
// is worse than an honest failure naming the real click error.
describe('Wave 3: spotify_play fails honestly when click_at fails on a LOCATED play control (no blind keystroke fallback)', () => {
  let dir, fs, hub, bus, callOrder;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    callOrder = [];

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        callOrder.push(tool);
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return {
            ok: true,
            result: {
              elements: [
                { name: 'Play', type: 'ControlType.Button', automationId: 'play-button',
                  rect: { x: 100, y: 200, width: 40, height: 40 } },
              ],
            },
          };
        }
        if (tool === 'click_at') return { ok: false, result: 'Click failed: input blocked by UIPI' };
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      },
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('fails honestly and never calls send_key when a located play control could not be clicked', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody' }, {});
    assert.equal(result.ok, false);
    assert.match(String(result.result), /click_at failed on the located play control/);
    assert.match(String(result.result), /input blocked by UIPI/, 'the real click error must reach the caller');
    assert.ok(!callOrder.includes('send_key'), 'a real click target was found and failed — guessing via keystrokes must not run');
  });
});

describe('BUG-026 (3rd attempt): spotify_play falls back to the keystroke path when ui_elements finds no play control', () => {
  let dir, fs, hub, bus, sendKeyCalls, clickAtCalled;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    sendKeyCalls = [];
    clickAtCalled = false;

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'send_key') sendKeyCalls.push(args.key);
        if (tool === 'click_at') clickAtCalled = true;
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        // Empty tree -- no name/automationId contains "play" or "pause".
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('does not fail outright -- falls back to send_key(tab) then send_key(enter)', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Moods Mild Oranges' }, {});
    assert.equal(result.ok, true);
    assert.equal(clickAtCalled, false, 'click_at must not be called when no play control was found');
    assert.deepEqual(sendKeyCalls, ['tab', 'enter']);
  });
});

describe('BUG-026 (5th attempt): spotify_play prefers the cua-driver element-addressed path when the adapter is online', () => {
  let dir, fs, hub, bus, callOrder, cuaDriver, originalGetStatus, originalInvoke, cuaCalls;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    callOrder = [];
    cuaCalls = [];

    // The cua-driver adapter is a singleton required directly by from-spotify.js
    // (not ctx-injected — matches from-pc.js's own pcChild require style), so we
    // stub its exported methods in place rather than re-requiring a mock module.
    // The stub mirrors cua-driver-rs 0.8.3's real MCP result shape
    // ({ content, structuredContent, isError }) as confirmed by live probe.
    cuaDriver = require('../adapters/cua-driver');
    originalGetStatus = cuaDriver.getStatus;
    originalInvoke = cuaDriver.invoke;
    cuaDriver.getStatus = () => ({ state: 'ONLINE', hint: null, queueDepth: 0 });
    let clickHappened = false;
    cuaDriver.invoke = async (toolName, args) => {
      cuaCalls.push({ toolName, args });
      if (toolName === 'list_windows') {
        // Window title flips to "Artist - Track" after the click — mirrors the
        // real playback oracle cuaPlayViaDriver verifies against.
        return { ok: true, result: { structuredContent: { windows: [
          { app_name: 'Spotify.exe', pid: 4242, window_id: 987, title: clickHappened ? 'Queen - Bohemian Rhapsody' : 'Spotify Premium', minimized: false }
        ] } } };
      }
      if (toolName === 'bring_to_front') return { ok: true, result: { content: [] } };
      if (toolName === 'get_window_state') {
        return { ok: true, result: { structuredContent: { elements: [
          ...Array.from({ length: 30 }, (_, i) => ({ element_index: i, role: 'Text', label: `filler ${i}` })),
          { element_index: 30, role: 'Button', label: 'Play Bohemian Rhapsody by Queen' },
          { element_index: 31, role: 'Button', label: 'Play' }
        ] } } };
      }
      if (toolName === 'click') {
        clickHappened = true;
        return { ok: true, result: { content: [], structuredContent: { verified: true, effect: 'invoked' } } };
      }
      return { ok: false, result: `unexpected cua tool: ${toolName}` };
    };

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        callOrder.push(tool);
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return {
            ok: true,
            result: {
              elements: [
                {
                  name: 'Play',
                  type: 'ControlType.Button',
                  automationId: 'play-button',
                  rect: { x: 100, y: 200, width: 40, height: 40 }
                }
              ]
            }
          };
        }
        // click_at/send_key must never fire once cua-driver succeeds.
        if (tool === 'click_at') return { ok: true, result: { clicked: true, x: args.x, y: args.y } };
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
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

  it('clicks the matching track play button by element_index and reports method: cua-driver, skipping click_at/send_key', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.method, 'cua-driver');
    const clickCall = cuaCalls.find(c => c.toolName === 'click');
    assert.ok(clickCall, 'cua-driver click was called');
    assert.equal(clickCall.args.element_index, 30, 'clicks the query-matched track play button, not the bare transport Play');
    assert.equal(clickCall.args.pid, 4242);
    assert.equal(clickCall.args.window_id, 987);
    assert.equal(result.result.clickedElement, 'Play Bohemian Rhapsody by Queen');
    assert.equal(result.result.verified, true, 'window-title oracle confirmed playback');
    assert.equal(result.result.nowPlaying, 'Queen - Bohemian Rhapsody');
    assert.ok(!callOrder.includes('click_at'), 'click_at must not be used when cua-driver succeeds');
    assert.ok(!callOrder.includes('send_key'), 'send_key must not be used when cua-driver succeeds');
  });
});

describe('BUG-026 (4th attempt) part B: spotify_play falls back to click_at when cua-driver is offline (regression — default/unmodified adapter)', () => {
  let dir, fs, hub, bus, clickAtArgs;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    clickAtArgs = null;

    // Deliberately does NOT stub adapters/cua-driver — the real singleton's
    // getStatus() stays OFFLINE (side-effect-free require, start() never
    // called in the test process), so this exercises the untouched fallback.
    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') {
          return {
            ok: true,
            result: {
              elements: [
                { name: 'Play', type: 'ControlType.Button', automationId: 'play-button', rect: { x: 100, y: 200, width: 40, height: 40 } }
              ]
            }
          };
        }
        if (tool === 'click_at') {
          clickAtArgs = args;
          return { ok: true, result: { clicked: true, x: args.x, y: args.y } };
        }
        if (tool === 'send_key') return { ok: true, result: { sent: true, key: args.key } };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('uses click_at with method: click_at when cua-driver is unavailable', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Bohemian Rhapsody' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.result.method, 'click_at');
    assert.ok(clickAtArgs, 'click_at was invoked as the fallback');
  });
});

describe('BUG-007 discipline: spotify_play does not fabricate success when every path fails', () => {
  let dir, fs, hub, bus;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    const mockPcEffectors = {
      invoke: async (tool, args) => {
        if (tool === 'launch_app') return { ok: true, result: { launched: true } };
        if (tool === 'list_windows') {
          return { ok: true, result: { windows: [{ pid: 4242, processName: 'Spotify.exe', title: 'Spotify' }] } };
        }
        if (tool === 'focus_window') return { ok: true, result: { focused: true, pid: args.pid } };
        if (tool === 'ui_elements') return { ok: true, result: { elements: [] } };
        // Both keystroke steps fail too -- the tool must surface ok:false,
        // never fabricate a success.
        if (tool === 'send_key') return { ok: false, result: `send_key(${args.key}) failed: no target window` };
        return { ok: false, result: `unknown tool: ${tool}` };
      }
    };

    registerFromSpotify(hub, { effectors: mockPcEffectors });
  });

  after(() => cleanupVaultDir(dir));

  it('returns ok:false rather than claiming playback started', async () => {
    const result = await hub.invoke('spotify_play', { query: 'Moods Mild Oranges' }, {});
    assert.equal(result.ok, false);
  });
});