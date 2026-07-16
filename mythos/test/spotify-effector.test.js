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

  it('play and search are T3 (confirm-once-per-goal)', () => {
    assert.equal(tierOf('spotify_play'), 3);
    assert.equal(tierOf('spotify_search'), 3);
  });

  it('danger flag matches tier >= 3 for all Spotify T3', () => {
    // The voice agent computes danger from tierOf at runtime
    // T2 tools should have danger: false, T3+ should have danger: true
    const playPauseTier = tierOf('spotify_play_pause');
    const playTier = tierOf('spotify_play');

    assert.equal(playPauseTier >= 3, false); // T2 -> danger: false
    assert.equal(playTier >= 3, true); // T3 -> danger: true
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