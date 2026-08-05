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
var READ_FAILED = 'Could not read the reminder store (it may be locked by another process) — refusing to overwrite it. Try again in a moment.';

function createCalendarEffector({ fs, bus, goals }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function') {
    throw new Error('createCalendarEffector requires a vault fs-store with readJSON/writeJSON');
  }
  // Track B5 — goals is a SOFT dependency (main.js passes it; the
  // tier-table-conformance test's mirrored boot does not). Reminders whose
  // action is < T3 never need it. Reminders whose action IS T3+ cannot be
  // approved without it — addReminder() reports that honestly instead of
  // throwing, matching this file's existing degrade-honestly style.
  var tiers = require('../leash/tiers');

  // load() returns the reminder array, or NULL meaning "could not read" —
  // which is NOT the same as [] meaning "confirmed empty".
  //
  // SILENT DATA LOSS FIX: this used to be `catch (_) { return []; }`. fs-store's
  // readJSON already absorbs both legitimate empty cases itself (missing file →
  // fallback; unparseable JSON → 'json-corrupt' anomaly + fallback), so anything
  // that throws out of it is a real read failure — typically a transient Windows
  // EBUSY/EPERM lock from antivirus or the search indexer. Fabricating [] there
  // made the very next save() write that empty array back over reminders.json,
  // permanently deleting every other pending reminder and timer while still
  // returning ok:true. Callers must now check for null and refuse to write.
  function load() {
    try {
      // Strict: a corrupt reminders.json must reach the catch below, not arrive
      // as an empty list that the next save() then writes over the top of.
      return fs.readJSONStrict(FILE, []);
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'reminders-read-failed', path: FILE, error: err.message });
      return null;
    }
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

    // Track B5 — fire-action field. `action` is optional: {tool, args} to run
    // when the reminder fires (e.g. phone_whatsapp_send/whatsapp_send at 9am).
    // Validated here, not trusted structurally later.
    var action = null;
    var goalId = null;
    var actionApproved = true;
    // BUG-100: an action object with NO keys means "no action" — the Live model
    // fills the optional `action` slot with `{}` (or `[]`) rather than omitting
    // it, and treating that as a malformed action rejected plain reminders
    // outright. A non-empty action object missing `tool` is still an error.
    var hasAction = Boolean(opts && opts.action && typeof opts.action === 'object'
      && Object.keys(opts.action).length > 0);
    if (hasAction) {
      var actionTool = opts.action.tool;
      if (typeof actionTool !== 'string' || !actionTool.trim()) {
        return { ok: false, error: 'action.tool required (string) when action is given' };
      }
      action = { tool: actionTool.trim(), args: (opts.action.args && typeof opts.action.args === 'object') ? opts.action.args : {} };

      // T3+ outward-facing/destructive actions need a standing, tool-scoped
      // grant before fire time can dispatch them unattended — see
      // reminder_approve_action below. Anchored on a real goal record (the
      // SAME array-of-tool-names mechanism leash-grant-scope.test.js proves
      // safe for build plans) rather than inventing a parallel grant shape.
      if (tiers.tierOf(action.tool) >= 3) {
        actionApproved = false;
        if (goals && typeof goals.create === 'function') {
          // status:'proposed' (not 'active') — this goal exists ONLY as a
          // grant anchor for goals.grantTier()/leash.check()'s goalId lookup.
          // getActiveGoals() (goals/index.js) filters on status:'active' for
          // the autonomous arbiter/planner, so 'proposed' keeps this inert:
          // cortex never tries to "work on" a reminder's grant record.
          var actionGoal = goals.create({
            title: 'Reminder action: ' + action.tool,
            drive: 'user-service',
            status: 'proposed'
          });
          goalId = actionGoal.id;
        } else if (bus) {
          bus.emit('health.anomaly', { kind: 'reminder-action-no-goals', evidence: { tool: action.tool } });
        }
      }
    }

    var reminders = load();
    if (reminders === null) return { ok: false, error: READ_FAILED };
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
      alertSound: Boolean(opts.alertSound),
      // Track B5 — null for plain reminders (default, unchanged behavior).
      action: action,
      goalId: goalId,
      actionApproved: actionApproved
    };
    reminders.push(record);
    save(reminders);
    var result = { reminder: record };
    if (action && !actionApproved) {
      result.needsApproval = true;
      result.approvalNote = goalId
        ? 'This reminder\'s action (' + action.tool + ') needs one-time approval — use reminder_approve_action before it can fire.'
        : 'This reminder\'s action (' + action.tool + ') cannot be approved: no goal system available.';
    }
    return { ok: true, result: result };
  }

  // Track B5 — the ONE confirm the operator sees for a scheduled outward
  // action. reminder_approve_action is T3 in TIER_TABLE, so leash.check()
  // always requires a human confirm for THIS call (it never carries a prior
  // grant for itself). Once confirmed, this grants the reminder's own action
  // tool — and ONLY that tool — for the reminder's companion goal, so fire
  // time never re-prompts. Mirrors checkpoints.js's plan-approval grant, but
  // the tool list is the one the human actually approved here, not a
  // hardcoded build-tool allowlist.
  function approveReminderAction(opts) {
    var query = (opts && opts.query) || '';
    if (!query.trim()) return { ok: false, error: 'query required to approve' };

    var reminders = load();
    if (reminders === null) return { ok: false, error: READ_FAILED };
    var ql = query.toLowerCase();
    var rec = null;
    for (var i = reminders.length - 1; i >= 0; i--) {
      if (reminders[i].id === query || reminders[i].text.toLowerCase().indexOf(ql) !== -1) { rec = reminders[i]; break; }
    }
    if (!rec) return { ok: false, error: 'No reminder matching "' + query + '"' };
    if (!rec.action) return { ok: false, error: 'That reminder has no action to approve' };
    if (rec.actionApproved) {
      return { ok: true, result: { reminder: rec }, evidence: { alreadyApproved: true } };
    }
    if (!rec.goalId) {
      return { ok: false, error: 'That reminder has no linked goal — it could not be granted when created (goals system was unavailable)' };
    }
    if (!goals || typeof goals.grantTier !== 'function') {
      return { ok: false, error: 'Goals system unavailable — cannot grant this action' };
    }

    goals.grantTier(rec.goalId, 3, [rec.action.tool]);
    rec.actionApproved = true;
    save(reminders);
    // Oracle-backed evidence: the grant array actually written on the goal
    // record, not a bare claim.
    var goal = typeof goals.get === 'function' ? goals.get(rec.goalId) : null;
    var granted = (goal && goal.grants && Array.isArray(goal.grants['3'])) ? goal.grants['3'] : null;
    return {
      ok: true,
      result: { reminder: rec },
      evidence: { goalId: rec.goalId, grantedTool: rec.action.tool, grants: granted }
    };
  }

  function listReminders() {
    var reminders = load();
    if (reminders === null) return { ok: false, error: READ_FAILED };
    return { ok: true, result: { reminders: reminders } };
  }

  function cancelReminder(opts) {
    var query = (opts && opts.query) || '';
    if (!query.trim()) return { ok: false, error: 'query required to cancel' };

    var reminders = load();
    if (reminders === null) return { ok: false, error: READ_FAILED };
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
    // Read failed: fire nothing this tick rather than marking an empty list
    // fired and saving it back. load() already emitted the anomaly; the sensor
    // polls again in 30s, by which time a transient lock will have cleared.
    if (reminders === null) return [];
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
    // BUG-100: `str` was lowercased two lines up, so an uppercase-only `[T ]`
    // separator class never matched a real ISO string — every ISO `when` the
    // voice model produced fell through to `return null` and the operator heard
    // a bare "Failed". Match the lowercased form (and a bare space).
    var iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[t ](\d{1,2}):(\d{1,2})/);
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
    approveReminderAction: approveReminderAction,
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
    { name: 'reminder_add', description: 'Set a reminder with a time. The time can be a relative phrase like "in 10 minutes" or "tomorrow at 9am", or an ISO date string. Optionally carries an action ({tool, args}) to run when it fires (e.g. sending a WhatsApp message) — outward-facing actions need a one-time approval via reminder_approve_action before they can fire. Returns the reminder ID.', params: { text: 'string', when: 'string', action: 'object (optional) - {tool, args} to run when the reminder fires. OMIT this entirely for a plain reminder; do not pass an empty object' }, danger: false, fn: async function(args) { return cal.addReminder(args); } },
    { name: 'reminder_list', description: 'List upcoming reminders. Shows all pending reminders with their scheduled times and text.', params: {}, danger: false, fn: async function(args) { return cal.listReminders(args); }, needs_result: true },
    { name: 'reminder_cancel', description: 'Cancel a pending reminder by its ID or text match.', params: { query: 'string' }, danger: false, fn: async function(args) { return cal.cancelReminder(args); } },
    { name: 'reminder_approve_action', description: 'Approve, once, the outward-facing action attached to a reminder (e.g. a scheduled WhatsApp send) so it can fire later without asking again. Match by reminder ID or text.', params: { query: 'string' }, danger: false, fn: async function(args) { return cal.approveReminderAction(args); } },
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

// ---- BUG-113: commitment ledger ----
//
// Twice in one session MYTHOS said it would do something ("let me check on
// that", "I'll look into the ad thing"), the turn ended, and nothing was
// ever recorded — goals, reminders and the build pipeline all exist as
// mechanisms, but none of them fire on the ASSISTANT'S OWN spoken text.
// This section is a self-contained primitive: detect a spoken commitment,
// log it as an inert goal anchor (same status:'proposed' shape the T3
// reminder-action goal above already uses), and list what's still open.
// Call-site wiring (turn-completion in server/index.js + live-tool-
// adapter.js, and from-dashboard.js's read_status) is deliberately NOT part
// of this file — a separate pass wires these exports in afterward.
//
// Operator decision (final): EXPLICIT-ONLY detection. A missed commitment
// is merely today's behaviour; a FALSE entry teaches the operator to
// distrust the ledger, which is worse than not having one. So this stays a
// small, readable pattern list — never a generic NLP classifier — and each
// pattern is commented with exactly what it catches and why.
var COMMITMENT_TITLE_PREFIX = 'Commitment: ';

var COMMITMENT_PATTERNS = [
  {
    // "I'll check X", "I will look into Y", "I'll get those", "I'll follow
    // up on Z", "I'll take care of it" — the canonical first-person FUTURE
    // commitment shape. Requires "i'll"/"i will" directly followed by one of
    // a small, closed list of action verbs — NOT a bare "I will be ..." or
    // any other generic future-tense sentence.
    regex: /\bi\s*(?:'ll|will)\s+(check|look into|follow up on|follow up with|take care of|handle|find out|dig into|sort out|get|pull up|review|investigate|work on|fix|reach out to|circle back on)\b/i
  },
  {
    // "Let me check on that", "Let me get those numbers for you" — "let me"
    // used as an immediate promise to act. "know"/"see"/"think" are
    // deliberately excluded from the verb list so "let me know if..." /
    // "let me think about it" (permission requests, not commitments) never
    // match.
    regex: /\blet\s+me\s+(check|look into|get|find out|pull up|grab|dig up|follow up on|sort out)\b/i
  }
];

// Hedges that turn an apparent commitment back into a non-commitment. Kept
// separate from the verb list above so that list stays readable.
function isHedgedCommitment(fullText, matchIndex, clause) {
  // "I'll check X if you like/want" — a conditional offer, not a stated
  // intent. (This is also how a bare "I can check X if you like" is
  // excluded, though that case never matches the verb list above at all.)
  if (/\bif\b/i.test(clause)) return true;
  // "I don't think I'll check..." / "not sure I'll..." — negation BEFORE
  // the matched phrase that the verb-anchored regexes above can't see on
  // their own (they only look forward from "i'll"/"let me").
  var before = fullText.slice(Math.max(0, matchIndex - 30), matchIndex).toLowerCase();
  if (/\b(don't think|doesn't think|not sure|doubt)\s*$/.test(before)) return true;
  return false;
}

// detectCommitment(text) — returns the matched commitment phrase (a string,
// trimmed to its clause) if the assistant's turn text contains an explicit
// first-person future commitment, or null if it doesn't. Never throws.
function detectCommitment(text) {
  if (!text || typeof text !== 'string') return null;
  for (var i = 0; i < COMMITMENT_PATTERNS.length; i++) {
    var m = COMMITMENT_PATTERNS[i].regex.exec(text);
    if (!m) continue;
    var rest = text.slice(m.index);
    var stop = rest.search(/[.!?\n]/);
    var clause = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    if (!clause) continue;
    if (isHedgedCommitment(text, m.index, clause)) continue;
    return clause;
  }
  return null;
}

// logCommitmentIfPresent(text, {goals}) — if detectCommitment(text) matches,
// writes ONE inert commitment-ledger entry via goals.create({status:
// 'proposed', ...}): the same anchor shape addReminder() already uses for a
// T3 confirm-gate goal (see near the top of this file) — a real, queryable
// goal record that getActiveGoals() (goals/index.js, filters strictly on
// status:'active') never picks up, so the autonomous arbiter/planner never
// tries to "work on" a commitment record. Returns the created goal, or null
// if nothing was logged (no match, or no usable goals system — degrades
// honestly rather than throwing).
function logCommitmentIfPresent(text, opts) {
  var goals = opts && opts.goals;
  var phrase = detectCommitment(text);
  if (!phrase) return null;
  if (!goals || typeof goals.create !== 'function') return null;
  return goals.create({
    title: COMMITMENT_TITLE_PREFIX + phrase,
    drive: 'user-service',
    status: 'proposed',
    reason: text
  });
}

// listOpenCommitments(goals) — every currently-open commitment-ledger entry:
// status:'proposed' goals created by logCommitmentIfPresent specifically
// (identified by the COMMITMENT_TITLE_PREFIX title prefix), not every
// proposed goal in the system (e.g. the T3 reminder-action anchor above
// carries a different, non-colliding title prefix). Shape is the plain goal
// record — easy for read_status to consume once wired in. Returns [] if no
// usable goals system is given.
function listOpenCommitments(goals) {
  if (!goals || typeof goals.list !== 'function') return [];
  var proposed = goals.list({ status: 'proposed' }) || [];
  return proposed.filter(function(g) {
    return g && typeof g.title === 'string' && g.title.indexOf(COMMITMENT_TITLE_PREFIX) === 0;
  });
}

module.exports = {
  createCalendarEffector, buildCalendarTools, registerFromCalendar,
  detectCommitment, logCommitmentIfPresent, listOpenCommitments
};
