'use strict';

// sensors/window-sensor.js — V8 (Phase 4) opt-in active-window perception sensor.
//
// Distinct from screen-sensor.js (which periodically captures a screenshot,
// hashes it, and asks the vision lane for a one-sentence description). This
// sensor reads the FOREGROUND window's app/title via the pc-child
// 'active_window' command — no screenshot, no vision call, no image bytes.
// Structured perception.window events feed the OODA loop so the cortex can
// reason about what the operator is doing right now ("the operator is in VS
// Code editing src/main.js" → mull might suggest a relevant goal).
//
// Hash-gated on `${pid}|${title}`: unchanged focus = zero perception emit
// (cost control + keeps the OODA queue clean). Mirrors screen-sensor's
// generation token + unref pattern.
//
// Opt-in (WINDOW_AWARENESS_ENABLED, default false) — same privacy surface as
// screen-sensor (reads foreground window title at intervals). Off by default.

var crypto = require('crypto');

function createWindowSensor(ctx) {
  var pcChild = ctx.pcChild;
  var bus = ctx.bus;
  var config = ctx.config || {};
  var logger = ctx.logger || { info: function () {}, warn: function () {} };
  var generation = 0;
  var timer = null;
  var running = false;
  var lastHash = null;

  async function poll(myGen) {
    if (generation !== myGen || !running) return;
    if (!pcChild || typeof pcChild.sendCommand !== 'function') return;
    try {
      var resp = await pcChild.sendCommand({ cmd: 'active_window' });
      if (generation !== myGen) return;   // stale — race with stop()
      if (!resp || !resp.ok || !resp.result) return;
      var r = resp.result;
      var app = String(r.app || '').trim();
      var title = String(r.title || '').trim();
      var pid = Number(r.pid) || 0;
      // Skip empty windows (no foreground — e.g. focus on the desktop)
      if (!app && !title) { lastHash = null; return; }
      // Hash-gate: skip emit when focus is unchanged
      var hash = crypto.createHash('sha1').update(pid + '|' + title).digest('hex');
      if (hash === lastHash) return;
      lastHash = hash;
      var salience = (typeof config.WINDOW_AWARENESS_SALIENCE === 'number')
        ? config.WINDOW_AWARENESS_SALIENCE : 0.3;
      var summary = app && title
        ? 'Active window: ' + app + ' — ' + title
        : (app || title || 'unknown window');
      bus.emit('perception.window', {
        ts: Date.now(),
        kind: 'window',
        channel: 'window',
        summary: summary.slice(0, 200),
        salience: salience,
        detail: { app: app, title: title, pid: pid }
      });
    } catch (_) {
      // Sensor is best-effort — pc-child crashes / ENOENT must not propagate.
    }
  }

  function start() {
    if (running) return;
    running = true;
    generation++;
    var myGen = generation;
    var pollMs = (typeof config.WINDOW_AWARENESS_POLL_MS === 'number')
      ? config.WINDOW_AWARENESS_POLL_MS : 30000;
    timer = setInterval(function () { poll(myGen); }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isRunning() { return running; }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
    _internal: { poll: poll, gen: function () { return generation; }, _resetHash: function () { lastHash = null; } }
  };
}

module.exports = { createWindowSensor };
