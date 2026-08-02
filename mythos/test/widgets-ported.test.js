'use strict';
// test/widgets-ported.test.js — pure coverage for the widgets ported from
// design/mythos-living-core.html.
//
// The mockup those widgets came from fed all 20 of its panels from one
// hardcoded SIM object that random-walks itself to fake liveness. The port
// dropped every field with no real source. THIS FILE IS THE GUARD ON THAT
// DECISION: nearly every assertion below checks that a missing reading renders
// the word "unavailable" rather than a 0, a dash, or a plausible number.
// README's honest-inert contract is the reason, and a regression here would be
// invisible in the browser — a fabricated 0% CPU looks exactly like an idle
// machine.
//
// The widget modules are browser ESM under ui/public/, imported via file URL
// the same way test/voice-latency-format.test.js reaches latency-format.js.
// Only their pure exports are exercised; mount() needs a DOM and is covered by
// live verification instead.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { cpuDeltaPercent, average } = require('../server/routes/system');

const kindUrl = (file) => pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', file)
).href;

let sensors, gpu, terminal, voice, system, memoryWidget;

before(async () => {
  sensors = await import(kindUrl('sensors.js'));
  gpu = await import(kindUrl('gpu.js'));
  terminal = await import(kindUrl('terminal.js'));
  voice = await import(kindUrl('voice.js'));
  system = await import(kindUrl('system.js'));
  memoryWidget = await import(kindUrl('memory-widget.js'));
});

describe('system route — cpuDeltaPercent', () => {
  const sample = (idle, user) => [{ times: { user, nice: 0, sys: 0, irq: 0, idle } }];

  it('reports busy percent from the delta between two samples', () => {
    // 100 ticks elapsed, 25 of them idle -> 75% busy.
    assert.deepEqual(cpuDeltaPercent(sample(0, 0), sample(25, 75)), [75]);
  });

  it('measures only the window between the two samples, not since boot', () => {
    // The bug this exists to prevent: a single os.cpus() read gives
    // average-since-boot, which barely moves on a long-running process and
    // looks entirely convincing. Same absolute counters, busy recent window.
    assert.deepEqual(cpuDeltaPercent(sample(1000, 1000), sample(1100, 1900)), [90]);
  });

  it('returns null for a core with no elapsed time rather than 0%', () => {
    // Two requests in the same tick. 0% here would be a claim of idleness.
    assert.deepEqual(cpuDeltaPercent(sample(50, 50), sample(50, 50)), [null]);
  });

  it('returns null when the samples cannot be compared', () => {
    assert.equal(cpuDeltaPercent(null, sample(1, 1)), null);
    assert.equal(cpuDeltaPercent(sample(1, 1), null), null);
    assert.equal(cpuDeltaPercent([], sample(1, 1)), null, 'differing core counts');
  });

  it('average ignores unmeasurable cores and returns null when none are measurable', () => {
    assert.equal(average([50, null, 100]), 75);
    assert.equal(average([null, null]), null);
    assert.equal(average([]), null);
  });
});

describe('sensors — absent browser APIs never become numbers', () => {
  it('reads real navigator values when present', () => {
    const rows = sensors.readSensors(
      { hardwareConcurrency: 16, deviceMemory: 8, connection: { effectiveType: '4g', downlink: 10 } },
      { devicePixelRatio: 2, innerWidth: 1920, innerHeight: 1080 },
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(by.cores, '16');
    assert.equal(by.memory, '~8 GB', 'deviceMemory is a coarse bucket and must be marked approximate');
    assert.equal(by.network, '4g · 10 Mb/s');
    assert.equal(by.viewport, '1920×1080');
  });

  it('says unavailable for every API the browser withholds', () => {
    const rows = sensors.readSensors({}, {});
    for (const row of rows) {
      assert.equal(row.value, 'unavailable', `${row.key} must not fabricate a value`);
      assert.doesNotMatch(row.value, /\d/, `${row.key} must contain no digits when unknown`);
    }
  });

  it('formats battery only when the reading is real', () => {
    assert.equal(sensors.formatBattery({ level: 0.42, charging: false }), '42%');
    assert.equal(sensors.formatBattery({ level: 1, charging: true }), '100% · charging');
    assert.equal(sensors.formatBattery(null), 'unavailable');
    assert.equal(sensors.formatBattery({ charging: true }), 'unavailable', 'charging without a level is not a level');
  });
});

describe('gpu — renderer string or nothing', () => {
  it('returns the unmasked renderer when the extension is available', () => {
    const stub = {
      getExtension: (n) => (n === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 } : null),
      getParameter: (p) => (p === 1 ? 'NVIDIA GeForce RTX 4090' : 'NVIDIA'),
    };
    assert.deepEqual(gpu.readRenderer(stub), {
      renderer: 'NVIDIA GeForce RTX 4090', vendor: 'NVIDIA', reason: null,
    });
  });

  it('does NOT fall back to the masked strings when the extension is withheld', () => {
    // Firefox and locked-down Chromium hide the extension. The masked values
    // ("ANGLE", "WebKit WebGL") name the abstraction layer, not the hardware —
    // reporting them would read as an answer while saying nothing.
    const out = gpu.readRenderer({ getExtension: () => null, getParameter: () => 'ANGLE' });
    assert.equal(out.renderer, 'unavailable');
    assert.match(out.reason, /withheld/);
  });

  it('says unavailable when there is no context at all', () => {
    assert.equal(gpu.readRenderer(null).renderer, 'unavailable');
    assert.equal(gpu.readRenderer({}).renderer, 'unavailable');
  });
});

describe('terminal — log line normalisation', () => {
  it('keeps the message and a short time', () => {
    const line = terminal.normalizeLogLine({ ts: '2026-08-02T10:20:30.000Z', level: 'warn', msg: 'disk slow' }, 0);
    assert.equal(line.level, 'warn');
    assert.equal(line.msg, 'disk slow');
    assert.match(line.time, /^\d{2}:\d{2}:\d{2}$/);
  });

  it('defaults an unknown level to info rather than dropping the line', () => {
    assert.equal(terminal.normalizeLogLine({ msg: 'x', level: 'catastrophe' }, 0).level, 'info');
    assert.equal(terminal.normalizeLogLine({ msg: 'x' }, 0).level, 'info');
  });

  it('gives every line a distinct key even within the same millisecond', () => {
    const ts = '2026-08-02T10:20:30.000Z';
    const a = terminal.normalizeLogLine({ ts, msg: 'a' }, 0);
    const b = terminal.normalizeLogLine({ ts, msg: 'b' }, 1);
    assert.notEqual(a.key, b.key, 'a shared key would make keyedList drop one of the two lines');
  });

  it('survives a malformed payload', () => {
    assert.equal(terminal.normalizeLogLine(null, 0).msg, '');
    assert.equal(terminal.normalizeLogLine({ msg: null }, 0).msg, '');
    assert.equal(terminal.normalizeLogLine({ ts: 'not-a-date', msg: 'x' }, 0).time, '');
  });
});

describe('voice — capabilities are read, never assumed', () => {
  it('detects both engines, including the webkit prefix', () => {
    assert.deepEqual(voice.readVoiceCapabilities({ SpeechRecognition: {}, speechSynthesis: {} }),
      { recognition: 'available', synthesis: 'available' });
    assert.equal(voice.readVoiceCapabilities({ webkitSpeechRecognition: {} }).recognition, 'available');
  });

  it('reports unavailable in a browser with neither', () => {
    assert.deepEqual(voice.readVoiceCapabilities({}),
      { recognition: 'unavailable', synthesis: 'unavailable' });
  });

  it('clamps an unknown state to idle', () => {
    assert.equal(voice.normalizeState('listening'), 'listening');
    assert.equal(voice.normalizeState('speaking'), 'speaking');
    assert.equal(voice.normalizeState('nonsense'), 'idle');
    assert.equal(voice.normalizeState(undefined), 'idle');
  });
});

describe('system widget — byte and uptime formatting', () => {
  it('formats bytes at sensible scales', () => {
    assert.equal(system.formatBytes(512), '512 B');
    assert.equal(system.formatBytes(1024), '1.0 KB');
    assert.equal(system.formatBytes(16 * 1024 ** 3), '16 GB');
  });

  it('refuses to format a non-number', () => {
    assert.equal(system.formatBytes(null), 'unavailable');
    assert.equal(system.formatBytes(NaN), 'unavailable');
    assert.equal(system.formatBytes(-1), 'unavailable');
  });

  it('formats uptime and refuses garbage', () => {
    assert.equal(system.formatUptime(90), '1m');
    assert.equal(system.formatUptime(3700), '1h 1m');
    assert.equal(system.formatUptime(200000), '2d 7h');
    assert.equal(system.formatUptime(null), 'unavailable');
  });
});

describe('memory widget — ranking', () => {
  it('sorts newest first and caps the list', () => {
    const ranked = memoryWidget.rankMemories([
      { summary: 'old', ts: '2026-01-01T00:00:00Z' },
      { summary: 'new', ts: '2026-08-01T00:00:00Z' },
      { summary: 'mid', ts: '2026-04-01T00:00:00Z' },
    ], 2);
    assert.deepEqual(ranked.map((r) => r.summary), ['new', 'mid']);
  });

  it('keeps undated entries, sorted last', () => {
    const ranked = memoryWidget.rankMemories([
      { summary: 'undated' },
      { summary: 'dated', ts: '2026-01-01T00:00:00Z' },
    ], 10);
    assert.deepEqual(ranked.map((r) => r.summary), ['dated', 'undated']);
  });

  it('drops entries with no summary and tolerates a non-array', () => {
    assert.equal(memoryWidget.rankMemories([{ ts: '2026-01-01T00:00:00Z' }, null], 10).length, 0);
    assert.equal(memoryWidget.rankMemories(null, 10).length, 0);
  });
});

describe('memory route — the degenerate empty-query score stays hidden', () => {
  // Regression guard for a trap that already caught this port once. The route
  // browses with recall(''), and an empty query is NOT zero terms:
  // ''.split(/\s+/) === ['']. semantic.js therefore computes matched=1 over
  // terms.length=1 for every entry, i.e. a constant 1.0. Exposing it would let
  // a widget draw a full "recall strength" bar on every row and present a
  // constant as a measurement.
  it('an empty query splits to [""], not [], which is why every entry scores 1', () => {
    const terms = ''.split(/\s+/);
    assert.deepEqual(terms, ['']);
    assert.equal(terms.length, 1, 'the length that makes the score denominator 1');
    assert.equal('any content at all'.includes(''), true, 'so matched is always 1');
  });

  it('the route does not forward score to the client', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'memory.js'), 'utf8');
    assert.doesNotMatch(src, /^\s*score:/m,
      'routes/memory.js must not emit a score field — it is a constant on the browse path');
  });
});
