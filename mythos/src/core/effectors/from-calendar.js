'use strict';

// from-calendar.js — Calendar + reminders effector.
// Vault-backed local reminder store (zero external deps) plus a real,
// read-only Google Calendar "upcoming events" tool (§7.6). This file used to
// claim an "optional Google Calendar layer... when env keys are present"
// while no such layer existed anywhere in the codebase — exactly the
// undocumented-gap-vs-marketing-claim pattern this whole plan exists to
// avoid. Fixed by actually building the read side rather than deleting the
// claim: scripts/google-auth.js has requested the 'calendar.readonly' scope
// alongside Gmail's since BUG-024, so any refresh token minted after that
// fix already covers it — genuinely "scope, not new auth" reuse of the
// existing adapters/google adapter, same lazy-construct/clean-error pattern
// as from-gmail.js. Write-side (creating/editing events) is still not built
// — calendar_upcoming only reads.

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
      fired: false,
      // Task 5 (step 5, alarms/timers) — a timer is a reminder with this flag
      // set; server/index.js's reminder.due handler plays a bundled alert
      // tone before speaking when it's true. Plain reminder_add calls never
      // set it (defaults false), so existing reminder behavior is unchanged.
      alertSound: Boolean(opts.alertSound)
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
        if (bus) bus.emit('reminder.due', { id: fired[j].id, text: fired[j].text, alertSound: Boolean(fired[j].alertSound) });
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

// §7.6 — lazy Google adapter for the read-only Calendar tool. Same shape as
// from-gmail.js's ensureAdapter: construct on first use (never block boot on
// DNS/OAuth), and only cache a *ready* adapter — caching the not-ready
// sentinel would make every later call bypass the `if (!a)` guard below.
var _googleAdapter = null;
function ensureGoogleAdapter(logger) {
  if (_googleAdapter && _googleAdapter.ready) return _googleAdapter;
  var { createGoogleAdapter } = require('../../../adapters/google');
  _googleAdapter = createGoogleAdapter({ logger: logger || { warn: function() {} } });
  if (!_googleAdapter.ready) return null;
  return _googleAdapter;
}

async function calendarUpcoming(args, ctx) {
  var logger = (ctx && ctx.logger) || { warn: function() {} };
  var a = ensureGoogleAdapter(logger);
  if (!a) {
    return { ok: false, result: { error: 'Google Calendar is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.' } };
  }
  var max = (args && args.max) || 10;
  try {
    var events = await a.listUpcomingEvents(max);
    return { ok: true, result: { events: events } };
  } catch (err) {
    return { ok: false, result: { error: 'Calendar fetch failed: ' + err.message } };
  }
}

function buildCalendarTools(ctx) {
  var cal = createCalendarEffector(ctx);
  return [
    { name: 'reminder_add', description: 'Set a reminder with a time. The time can be a relative phrase like "in 10 minutes" or "tomorrow at 9am", or an ISO date string. Returns the reminder ID.', params: { text: 'string', when: 'string' }, danger: false, fn: async function(args) { return cal.addReminder(args); } },
    { name: 'reminder_list', description: 'List upcoming reminders. Shows all pending reminders with their scheduled times and text.', params: {}, danger: false, fn: async function(args) { return cal.listReminders(args); }, needs_result: true },
    { name: 'reminder_cancel', description: 'Cancel a pending reminder by its ID or text match.', params: { query: 'string' }, danger: false, fn: async function(args) { return cal.cancelReminder(args); } },
    { name: 'timer_add', description: 'Set a timer that rings an audible alert when it goes off (in addition to speaking). Use for "set a timer for N minutes" style requests, not date-based reminders.', params: { minutes: 'number', label: 'string (optional)' }, danger: false, fn: async function(args) { return cal.addReminder({ text: (args && args.label) || 'Timer', when: 'in ' + ((args && args.minutes) || 0) + ' minutes', alertSound: true }); } },
    { name: 'timer_cancel', description: 'Cancel a pending timer by its label/text match.', params: { query: 'string' }, danger: false, fn: async function(args) { return cal.cancelReminder(args); } },
    { name: 'calendar_upcoming', description: 'List upcoming events from the connected Google Calendar (read-only). Requires GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN to be configured — degrades honestly with a clear setup message otherwise.', params: { max: 'number (optional) - max events to return, default 10' }, danger: false, fn: async function(args) { return calendarUpcoming(args, ctx); }, needs_result: true },
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
