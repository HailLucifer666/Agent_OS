'use strict';

// from-calendar.js — Calendar + reminders effector.
// Vault-backed local reminder store (zero external deps).
// Optional Google Calendar layer rides on top when env keys are present.

var FILE = 'Calendar/reminders.json';

function createCalendarEffector({ fs, bus }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function') {
    throw new Error('createCalendarEffector requires a vault fs-store with readJSON/writeJSON');
  }

  function load() {
    try { return fs.readJSON(FILE, []); } catch (_) { return []; }
  }

  function save(reminders) {
    try { fs.ensureDir('Calendar'); } catch (_) {}
    fs.writeJSON(FILE, reminders);
  }

  function nextId() {
    return 'rem-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  }

  // ---- tools ----

  function addReminder(opts) {
    var text = (opts && opts.text) || '';
    if (!text.trim()) return { ok: false, error: 'text required' };

    var when = parseWhen(opts.when || opts.due || '');
    if (!when) return { ok: false, error: 'Could not parse that time. Try ISO date, "in 20 minutes", "tomorrow 9am", or "HH:MM".' };

    var reminders = load();
    var record = {
      id: nextId(),
      text: text.trim(),
      dueAt: when,
      createdAt: Date.now(),
      fired: false
    };
    reminders.push(record);
    save(reminders);
    return { ok: true, result: { reminder: record } };
  }

  function listReminders() {
    return { ok: true, result: { reminders: load() } };
  }

  function cancelReminder(opts) {
    var query = (opts && opts.query) || '';
    if (!query.trim()) return { ok: false, error: 'query required to cancel' };

    var reminders = load();
    var ql = query.toLowerCase();
    var matched = -1;
    for (var i = reminders.length - 1; i >= 0; i--) {
      if (reminders[i].text.toLowerCase().indexOf(ql) !== -1) { matched = i; break; }
    }
    if (matched === -1) return { ok: false, error: 'No reminder matching "' + query + '"' };

    var removed = reminders.splice(matched, 1)[0];
    save(reminders);
    return { ok: true, result: { cancelled: removed } };
  }

  function fireDueReminders() {
    var now = Date.now();
    var reminders = load();
    var fired = [];
    for (var i = 0; i < reminders.length; i++) {
      if (reminders[i].fired || reminders[i].dueAt > now) continue;
      reminders[i].fired = true;
      fired.push(reminders[i]);
    }
    if (fired.length > 0) {
      save(reminders);
      for (var j = 0; j < fired.length; j++) {
        if (bus) bus.emit('reminder.due', { id: fired[j].id, text: fired[j].text });
      }
    }
    return fired;
  }

  // ---- time parser ----

  function parseWhen(str, now) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim().toLowerCase();
    now = now || Date.now();
    var d = new Date(now);

    // ISO datetime: 2026-07-12T15:30:00 or 2026-07-12 15:30
    var iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})/);
    if (iso) {
      d.setFullYear(+iso[1], +iso[2] - 1, +iso[3]);
      d.setHours(+iso[4], +iso[5], 0, 0);
      if (d.getTime() > now) return d.getTime();
    }

    // "in N minutes/hours/days"
    var rel = str.match(/^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/);
    if (rel) {
      var n = +rel[1];
      var unit = rel[2];
      if (unit.indexOf('minute') === 0) return now + n * 60000;
      if (unit.indexOf('hour') === 0) return now + n * 3600000;
      if (unit.indexOf('day') === 0) return now + n * 86400000;
    }

    // "today HH:MM" or "tomorrow HH:MM" or "tomorrow HH:MMam/pm"
    // also "today 9am" / "tomorrow 3pm" (no minutes)
    var dayTime = str.match(/^(today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (dayTime) {
      if (dayTime[1] === 'tomorrow') d.setDate(d.getDate() + 1);
      var h = +dayTime[2];
      var m = +(dayTime[3] || 0);
      var ampm = dayTime[4];
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
      if (d.getTime() > now) return d.getTime();
    }

    // bare "HH:MM" or "HH:MMam/pm" — next occurrence
    var bare = str.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (bare) {
      var bh = +bare[1];
      var bm = +bare[2];
      var bampm = bare[3];
      if (bampm === 'pm' && bh < 12) bh += 12;
      if (bampm === 'am' && bh === 12) bh = 0;
      d.setHours(bh, bm, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    // "tomorrow" alone → tomorrow 9am
    if (str === 'tomorrow') {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }

    return null;
  }

  return {
    addReminder: addReminder,
    listReminders: listReminders,
    cancelReminder: cancelReminder,
    fireDueReminders: fireDueReminders,
    parseWhen: parseWhen
  };
}

function buildCalendarTools(ctx) {
  var cal = createCalendarEffector(ctx);
  return [
    { name: 'reminder_add', description: 'Set a reminder with a time. The time can be a relative phrase like "in 10 minutes" or "tomorrow at 9am", or an ISO date string. Returns the reminder ID.', params: { text: 'string', when: 'string' }, danger: false, fn: async function(args) { return cal.addReminder(args); } },
    { name: 'reminder_list', description: 'List upcoming reminders. Shows all pending reminders with their scheduled times and text.', params: {}, danger: false, fn: async function(args) { return cal.listReminders(args); }, needs_result: true },
    { name: 'reminder_cancel', description: 'Cancel a pending reminder by its ID or text match.', params: { query: 'string' }, danger: false, fn: async function(args) { return cal.cancelReminder(args); } },
  ];
}

function registerFromCalendar(hub, ctx) {
  var effectorFromTool = require('./adapter').effectorFromTool;
  var tools = buildCalendarTools(ctx);
  for (var i = 0; i < tools.length; i++) {
    hub.register(effectorFromTool(tools[i]));
  }
  return { count: tools.length, calendar: createCalendarEffector(ctx) };
}

module.exports = { createCalendarEffector, buildCalendarTools, registerFromCalendar };
