'use strict';

// Phase-2 Jarvis upgrade: manage_widget — voice hide/show of boot HUD widgets.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { fakeBus } = require('./helpers');
const { buildTools } = require('../src/core/effectors/from-widgets');

describe('manage_widget', () => {
  let bus, tool;

  beforeEach(() => {
    bus = fakeBus();
    const built = buildTools({ bus });
    tool = built.TOOLS.find((t) => t.name === 'manage_widget');
    assert.ok(tool, 'manage_widget must be registered');
  });

  function lastCommand() {
    const events = bus._emitted().filter((e) => e.type === 'ui.widget-command');
    return events.length ? events[events.length - 1].payload : null;
  }

  it('close resolves synonyms ("now playing" → media) and emits ui.widget-command', () => {
    const res = tool.fn({ action: 'close', name: 'now playing' });
    assert.equal(res.ok, true);
    assert.deepEqual(lastCommand(), { mode: 'close', targets: ['media'] });
  });

  it('hide/show verb synonyms map to close/open', () => {
    tool.fn({ action: 'hide', name: 'news' });
    assert.deepEqual(lastCommand(), { mode: 'close', targets: ['news'] });
    tool.fn({ action: 'show', name: 'news' });
    assert.deepEqual(lastCommand(), { mode: 'open', targets: ['news'] });
  });

  it('declutter hides the telemetry set without needing a name', () => {
    const res = tool.fn({ action: 'declutter' });
    assert.equal(res.ok, true);
    const cmd = lastCommand();
    assert.equal(cmd.mode, 'close');
    assert.deepEqual(cmd.targets.sort(), ['agents', 'breakers', 'spend', 'tick-rate', 'tokens', 'wip'].sort());
  });

  it('open all restores every boot widget', () => {
    tool.fn({ action: 'open', name: 'all' });
    const cmd = lastCommand();
    assert.equal(cmd.mode, 'open');
    // Boot-widget registry count. Changelog: 10 -> 11 when the VOICE LATENCY
    // tile joined ui/public/js/widgets/widget-registry.js (surfacing
    // /api/status's previously-unread voiceLatency); 11 -> 18 when the seven
    // widgets ported from design/mythos-living-core.html landed (SYSTEM,
    // CORES, GPU, SENSORS, VOICE, MEMORY, TERMINAL); 18 -> 19 when the
    // Aether-BLE NEAREST DEVICE tile landed (opt-in, defaultHidden). Keep in
    // step with BOOT_WIDGET_IDS in src/core/effectors/from-widgets.js.
    //
    // "open all" covering the new seven is load-bearing, not incidental: they
    // ship defaultHidden, so voice is how they get on screen at all.
    assert.equal(cmd.targets.length, 19);
  });

  it('solo keeps only the named widget', () => {
    tool.fn({ action: 'solo', name: 'clock' });
    assert.deepEqual(lastCommand(), { mode: 'solo', targets: ['clock'] });
  });

  it('unknown widget or action fails honestly, emits nothing', () => {
    const before = bus._emitted().filter((e) => e.type === 'ui.widget-command').length;
    assert.equal(tool.fn({ action: 'close', name: 'flux capacitor' }).ok, false);
    assert.equal(tool.fn({ action: 'explode', name: 'clock' }).ok, false);
    assert.equal(tool.fn({ action: 'solo', name: 'all' }).ok, false);
    const after = bus._emitted().filter((e) => e.type === 'ui.widget-command').length;
    assert.equal(after, before);
  });
});
