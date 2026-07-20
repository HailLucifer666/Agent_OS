'use strict';

// sensors/calendar-upcoming-sensor.js — V8 (Phase 4) calendar upcoming-event
// perception sensor.
//
// Distinct from reminder-sensor.js, which polls fireDueReminders() and only
// emits 'reminder.due' for events that are ALREADY overdue (bypasses the OODA
// loop entirely — fires straight to proactive speech).
//
// This sensor reads the unfired reminders directly + emits perception.calendar
// for events coming up within CALENDAR_UPCOMING_LEAD_MS (default 15min). Those
// perceptions enter the cortex OODA loop, where orient→recall + decide can
// act on them (mull a goal, dispatch a tool, surface to the operator).
//
// Mirrors reminder-sensor.js's polling pattern: setInterval + generation
// token + unref, best-effort (never throws).
//
// Future Google Calendar integration: the calendarWiring.calendar object is
// the same handle reminder-sensor uses. When a real Google Calendar adapter
// lands (the from-calendar.js:5 comment promises one), this sensor picks up
// upcoming events from it with no other changes — just add a listUpcoming()
// method next to listReminders.

function createCalendarUpcomingSensor(ctx) {
  var calendar = ctx.calendar;
  var bus = ctx.bus;
  var config = ctx.config || {};
  var logger = ctx.logger || { info: function () {}, warn: function () {} };
  var generation = 0;
  var timer = null;
  // Track which event IDs we've already emitted for so we don't re-perceive
  // the same upcoming event every poll cycle (would flood the OODA queue).
  var emitted = new Set();

  function poll(myGen) {
    if (generation !== myGen) return;
    try {
      if (!calendar || typeof calendar.listReminders !== 'function') return;
      var resp = calendar.listReminders();
      var reminders = (resp && resp.result && resp.result.reminders) || [];
      var now = Date.now();
      var leadMs = (typeof config.CALENDAR_UPCOMING_LEAD_MS === 'number')
        ? config.CALENDAR_UPCOMING_LEAD_MS : 900000;   // 15min
      var minSalience = (typeof config.CALENDAR_UPCOMING_SALIENCE === 'number')
        ? config.CALENDAR_UPCOMING_SALIENCE : 0.6;
      var emittedNow = 0;
      for (var i = 0; i < reminders.length; i++) {
        var r = reminders[i];
        if (r.fired) continue;                       // already-fired reminders are reminder-sensor's domain
        var dueAt = typeof r.dueAt === 'number' ? r.dueAt : Date.parse(r.dueAt || '');
        if (!isFinite(dueAt)) continue;
        var delta = dueAt - now;
        // Only perceive events in the upcoming window: future, but within lead time.
        // Past-due unfired reminders (delta < 0) are picked up by fireDueReminders
        // in the reminder-sensor, not here — avoids double-perception.
        if (delta < 0 || delta > leadMs) continue;
        if (emitted.has(r.id)) continue;             // one perception per event
        emitted.add(r.id);
        var minutes = Math.max(1, Math.round(delta / 60000));
        bus.emit('perception.calendar', {
          ts: now,
          kind: 'calendar',
          channel: 'calendar',
          summary: 'Upcoming event in ' + minutes + 'min: ' + (r.text || '').slice(0, 120),
          salience: minSalience,
          detail: { id: r.id, text: r.text, dueAt: dueAt, leadMs: delta }
        });
        emittedNow++;
      }
      // Opportunistic cleanup: drop emitted IDs whose reminders have been
      // cancelled or fired since the last poll. Keeps the Set bounded.
      if (emitted.size > 100) {
        var liveIds = new Set(reminders.map(function (r) { return r.id; }));
        emitted.forEach(function (id) { if (!liveIds.has(id)) emitted.delete(id); });
      }
      if (emittedNow > 0) logger.info('sensors.calendar.upcoming', { emitted: emittedNow });
    } catch (_) {
      // Sensor is best-effort — never crash the host process.
    }
  }

  function start() {
    generation++;
    var myGen = generation;
    var pollMs = (typeof config.CALENDAR_UPCOMING_POLL_MS === 'number')
      ? config.CALENDAR_UPCOMING_POLL_MS : 60000;
    timer = setInterval(function () { poll(myGen); }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start: start,
    stop: stop,
    // _internal.poll is the test hook — it accepts the generation token so
    // tests can drive a single poll synchronously. Tests pass the current
    // generation via _internal.gen() (or just call start() first, which
    // bumps generation to 1, then _internal.poll(1)).
    _internal: { poll: poll, emitted: emitted, gen: function () { return generation; } }
  };
}

module.exports = { createCalendarUpcomingSensor };
