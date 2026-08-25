'use strict';

// test/timer-countdown-widget.test.js
//
// Operator request, 2026-08-21: "add a timer widget when asked for a countdown
// / timer". Setting a timer rang and spoke but put nothing on screen —
// timer_add is a thin wrapper over addReminder({alertSound:true}) and the HUD
// had no countdown of any kind.
//
// WHAT IS TESTED WHERE, and why it is split that way. This codebase has no
// DOM/jsdom harness — dynamic-widget-spec-validation.test.js says so outright
// and treats client rendering as code-review-verified. Rather than accept that
// for a feature whose entire job is arithmetic over time, the countdown's logic
// was extracted into two pure, dependency-injected exports (countdownText,
// startCountdown) which ARE tested here against a fake clock and fake timers.
// What remains unverified by the suite is only the markup assembly, which is
// the same status every other widget kind has.
//
// The frozen-clock trap is deliberately avoided: startCountdown takes `now` and
// the timer functions as injected deps, so the test advances time itself. A
// clock the test cannot move would make every interval-driven branch invisible,
// which is a lesson this repo has already paid for.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { fakeBus } = require('./helpers');
const { buildTools } = require('../src/core/effectors/from-widgets');

let countdownText, startCountdown;

before(async () => {
  // ui/public/js is browser ESM; import it by URL the way the ws.js test does.
  const url = pathToFileURL(
    path.resolve(__dirname, '../ui/public/js/widgets/kinds/dynamic.js')
  ).href;
  ({ countdownText, startCountdown } = await import(url));
});

describe('countdownText — the arithmetic the widget shows', () => {
  it('renders minutes and seconds under an hour', () => {
    assert.equal(countdownText(30 * 1000), '0:30');
    assert.equal(countdownText(90 * 1000), '1:30');
    assert.equal(countdownText(9 * 60 * 1000 + 5 * 1000), '9:05');
  });

  it('renders hours when there are hours', () => {
    assert.equal(countdownText(3600 * 1000), '1:00:00');
    assert.equal(countdownText(3661 * 1000), '1:01:01');
  });

  it('says so once the deadline passes, and never counts negative', () => {
    // A widget left open overnight must not read "-7:41:12".
    assert.equal(countdownText(0), "Time's up");
    assert.equal(countdownText(-1), "Time's up");
    assert.equal(countdownText(-9999999), "Time's up");
  });

  it('is robust to a missing or non-numeric deadline', () => {
    assert.equal(countdownText(undefined), "Time's up");
    assert.equal(countdownText(NaN), "Time's up");
    assert.equal(countdownText('nonsense'), "Time's up");
  });

  it('rounds UP, so a timer never shows 0:00 while still running', () => {
    // 1ms left is still "1 second showing", not a finished timer.
    assert.equal(countdownText(1), '0:01');
    assert.equal(countdownText(999), '0:01');
    assert.equal(countdownText(1001), '0:02');
  });
});

describe('startCountdown — ticking and teardown', () => {
  function harness(endsAtMs, startNow) {
    const el = { textContent: null };
    let current = startNow;
    let tickFn = null;
    let cleared = 0;
    const deps = {
      now: () => current,
      setInterval: (fn) => { tickFn = fn; return 'HANDLE'; },
      clearInterval: (h) => { if (h === 'HANDLE') cleared++; },
    };
    const stop = startCountdown(el, endsAtMs, deps);
    return {
      el, stop,
      advance(ms) { current += ms; if (tickFn) tickFn(); },
      get cleared() { return cleared; },
      get ticking() { return tickFn !== null; },
    };
  }

  it('paints immediately, before the first tick arrives', () => {
    // Without this the widget shows its placeholder for a full second.
    const h = harness(1000 * 60, 0);
    assert.equal(h.el.textContent, '1:00');
  });

  it('counts down as time passes', () => {
    const h = harness(1000 * 60, 0);
    h.advance(1000);
    assert.equal(h.el.textContent, '0:59');
    h.advance(29 * 1000);
    assert.equal(h.el.textContent, '0:30');
  });

  it('stops itself at zero rather than ticking forever', () => {
    const h = harness(2000, 0);
    h.advance(2000);
    assert.equal(h.el.textContent, "Time's up");
    assert.equal(h.cleared, 1, 'the interval must be cleared when the timer finishes');
  });

  it('the returned cleanup stops the interval — no widget outlives its card', () => {
    const h = harness(1000 * 60, 0);
    assert.equal(h.ticking, true, 'it must actually have started an interval (negative control)');
    h.stop();
    assert.equal(h.cleared, 1, 'teardown must clear the interval');
  });

  it('an already-expired deadline never starts an interval at all', () => {
    const h = harness(-5000, 0);
    assert.equal(h.el.textContent, "Time's up");
    assert.equal(h.ticking, false, 'nothing to count down — do not arm a timer');
  });
});

describe('spawn_widget accepts the countdown layout', () => {
  function makeSpawnWidget() {
    const bus = fakeBus();
    const built = buildTools({ bus: bus });
    return { fn: built.TOOLS.find((t) => t.name === 'spawn_widget').fn, bus: bus };
  }

  it('emits a countdown payload carrying the deadline', () => {
    const { fn, bus } = makeSpawnWidget();
    const endsAt = 1787000000000;
    const res = fn({ title: 'Timer', layout: 'countdown', endsAt: endsAt, items: [{ label: 'Pasta', value: '' }] });
    assert.equal(res.ok, true, JSON.stringify(res));
    // bus._emitted() is this repo's fakeBus accessor — the shape matters, and
    // guessing it wrong is how an assertion reads green against undefined.
    const emitted = bus._emitted().filter((e) => e.type === 'ui.open-web');
    assert.equal(emitted.length, 1, 'must reach the HUD');
    assert.equal(emitted[0].payload.layout, 'countdown');
    assert.equal(emitted[0].payload.endsAt, endsAt, 'the deadline is the whole payload — it must survive');
  });

  it('refuses a countdown with no usable deadline rather than rendering a dead widget', () => {
    const { fn, bus } = makeSpawnWidget();
    const res = fn({ title: 'Timer', layout: 'countdown', items: [{ label: 'x', value: '' }] });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /endsAt/i);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0,
      'nothing may reach the HUD when the spec is invalid');
  });

  it('still refuses an unknown layout — the enum did not become a free-for-all', () => {
    const { fn } = makeSpawnWidget();
    const res = fn({ title: 'x', layout: 'marquee', items: [{ label: 'a', value: 'b' }] });
    assert.equal(res.ok, false);
  });
});

describe('timer_add puts the countdown on screen', () => {
  const os = require('os');
  const fsNative = require('fs');
  const { buildCalendarTools } = require('../src/core/effectors/from-calendar');

  function makeTimerAdd() {
    // A minimal vault fs: the calendar only reads/writes its reminders file.
    const store = {};
    const vaultFs = {
      readJSON: (p, fb) => (Object.prototype.hasOwnProperty.call(store, p) ? store[p] : fb),
      readJSONStrict: (p, fb) => (Object.prototype.hasOwnProperty.call(store, p) ? store[p] : fb),
      writeJSON: (p, v) => { store[p] = v; return true; },
      readText: (p, fb) => fb,
      writeText: () => true,
      exists: () => false,
    };
    const bus = fakeBus();
    const tools = buildCalendarTools({ fs: vaultFs, bus: bus });
    return { fn: tools.find((t) => t.name === 'timer_add').fn, bus };
  }

  it('emits a countdown widget whose deadline matches the timer', async () => {
    const { fn, bus } = makeTimerAdd();
    const before = Date.now();
    const res = await fn({ minutes: 5, label: 'Pasta' });
    const after = Date.now();
    assert.equal(res.ok, true, JSON.stringify(res));

    const widget = bus._emitted().find((e) => e.type === 'ui.open-web');
    assert.ok(widget, 'setting a timer must put something on screen — that was the whole request');
    assert.equal(widget.payload.layout, 'countdown');

    // The deadline must be the TIMER's deadline, not an invented one. Bracket
    // it against real elapsed time rather than pinning an exact value: a fake
    // frozen clock here would pass no matter what the code computed.
    const expectedLow = before + 5 * 60 * 1000 - 2000;
    const expectedHigh = after + 5 * 60 * 1000 + 2000;
    assert.ok(
      widget.payload.endsAt >= expectedLow && widget.payload.endsAt <= expectedHigh,
      'endsAt ' + widget.payload.endsAt + ' must fall inside [' + expectedLow + ',' + expectedHigh + ']'
    );
  });

  it('carries the timer label so two timers are tellable apart', async () => {
    const { fn, bus } = makeTimerAdd();
    await fn({ minutes: 1, label: 'Pasta' });
    const widget = bus._emitted().find((e) => e.type === 'ui.open-web');
    assert.match(JSON.stringify(widget.payload), /Pasta/);
  });

  it('a sub-minute timer still gets a widget (the 0.5-minute case from the live log)', async () => {
    // The operator's real 30-second timer arrived as minutes:0.5.
    const { fn, bus } = makeTimerAdd();
    const res = await fn({ minutes: 0.5 });
    assert.equal(res.ok, true, JSON.stringify(res));
    const widget = bus._emitted().find((e) => e.type === 'ui.open-web');
    assert.ok(widget, 'a 30-second timer is still a timer');
    assert.ok(widget.payload.endsAt > Date.now(), 'its deadline must still be in the future');
  });

  it('reminder_add does NOT spawn a countdown — it is silent by contract', async () => {
    // Q1: what else matches this? reminder_add and timer_add share addReminder.
    // Only the ringing one is a countdown; a silent reminder that threw a timer
    // face on screen would be a new failure mode, not a feature.
    const store = {};
    const vaultFs = {
      readJSON: (p, fb) => (Object.prototype.hasOwnProperty.call(store, p) ? store[p] : fb),
      readJSONStrict: (p, fb) => (Object.prototype.hasOwnProperty.call(store, p) ? store[p] : fb),
      writeJSON: (p, v) => { store[p] = v; return true; },
      readText: (p, fb) => fb, writeText: () => true, exists: () => false,
    };
    const bus = fakeBus();
    const tools = buildCalendarTools({ fs: vaultFs, bus: bus });
    const reminderAdd = tools.find((t) => t.name === 'reminder_add').fn;
    await reminderAdd({ text: 'call the dentist', when: 'in 10 minutes' });
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0,
      'a silent reminder must not put a countdown on screen');
  });
});

describe('mountDynamicWidget assembles the countdown markup', () => {
  // The repo has no jsdom, but mountDynamicWidget only needs `innerHTML` and a
  // `querySelector` that finds the tick target. A hand-rolled element stub
  // covers the assembly step that would otherwise be code-review-only, and it
  // is honest about being a stub: it is NOT a DOM, so this asserts the HTML
  // string and the wiring, not layout or styling.
  let mountDynamicWidget;
  before(async () => {
    const url = pathToFileURL(
      path.resolve(__dirname, '../ui/public/js/widgets/kinds/dynamic.js')
    ).href;
    ({ mountDynamicWidget } = await import(url));
  });

  function stubEl() {
    const tick = { textContent: null };
    return {
      innerHTML: '',
      querySelector(sel) { return sel === '[data-countdown]' ? tick : null; },
      _tick: tick,
    };
  }

  const deps = (nowMs) => ({
    now: () => nowMs,
    setInterval: () => 'H',
    clearInterval: () => {},
  });

  it('renders a tick target and paints it immediately', () => {
    const el = stubEl();
    mountDynamicWidget(el, {
      widgetType: 'dynamic', layout: 'countdown', title: 'Timer',
      endsAt: 90 * 1000, items: [{ label: 'Pasta' }],
      __countdownDeps: deps(0),
    });
    assert.match(el.innerHTML, /data-countdown/, 'the tick target must exist for startCountdown to paint');
    assert.match(el.innerHTML, /Pasta/, 'the label must be shown');
    assert.equal(el._tick.textContent, '1:30', 'it must be painted before the first interval fires');
  });

  it('returns the cleanup so the host can stop the interval', () => {
    const el = stubEl();
    const cleanup = mountDynamicWidget(el, {
      widgetType: 'dynamic', layout: 'countdown', title: 'Timer',
      endsAt: 90 * 1000, items: [{ label: 'Pasta' }],
      __countdownDeps: deps(0),
    });
    assert.equal(typeof cleanup, 'function',
      'widget-host pushes this into teardown — without it the interval outlives the card');
  });

  it('escapes the label like every other item field', () => {
    // The countdown branch writes the label through innerHTML, so it is on the
    // same footing as every other renderer in this file and must escape.
    const el = stubEl();
    mountDynamicWidget(el, {
      widgetType: 'dynamic', layout: 'countdown', title: 'Timer',
      endsAt: 90 * 1000, items: [{ label: '<img src=x onerror=alert(1)>' }],
      __countdownDeps: deps(0),
    });
    assert.ok(!/<img/.test(el.innerHTML), 'raw markup must never survive: ' + el.innerHTML);
    assert.match(el.innerHTML, /&lt;img/, 'it must be escaped, not stripped');
  });

  it('an unknown layout is still refused (the enum guard survived the addition)', () => {
    const el = stubEl();
    mountDynamicWidget(el, { widgetType: 'dynamic', layout: 'marquee', items: [] });
    assert.match(el.innerHTML, /Unknown layout/);
  });
});
