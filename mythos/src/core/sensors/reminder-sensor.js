'use strict';
// reminder-sensor.js — polls calendar.fireDueReminders() every 30s.
// Pattern mirrors timer.js: generation token + unref to avoid keeping process alive.
function createReminderSensor(ctx) {
  var calendar = ctx.calendar;
  var bus = ctx.bus;
  var generation = 0;
  var timer = null;

  function start() {
    generation++;
    var myGen = generation;
    timer = setInterval(function () {
      if (generation !== myGen) return;
      try {
        if (calendar && typeof calendar.fireDueReminders === 'function') {
          calendar.fireDueReminders();
        }
      } catch (_) { /* best-effort */ }
    }, 30000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop };
}
module.exports = { createReminderSensor };
