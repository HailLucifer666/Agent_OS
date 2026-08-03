'use strict';

const { createDiffGate } = require('../cortex/diff-gate');

// planner/daily.js — daily planning + accountability (Phase 3, Jarvis upgrade).
// Morning brief / stall check-ins / evening review, layered on the existing
// Goals system (goals.arbitrate/list are REUSED here, never reimplemented).
//
// Scheduler: no cron primitive exists anywhere in MYTHOS (verified repo-wide) —
// this mirrors the house sensor pattern instead: an unref'd 60s setInterval
// (generation-tokened, like sensors/timer.js and sensors/screen-sensor.js)
// compares wall-clock hour/minute against PLANNER_MORNING_HOUR/
// PLANNER_EVENING_HOUR every tick.
//
// Idempotence (the most important correctness property in this module):
// fired-flags (morningFiredAt, lastCheckinAt, eveningFiredAt) live INSIDE the
// day file itself (vault/Plans/YYYY-MM-DD.json), never only in memory. A
// mid-day restart re-loads the day file from disk before the scheduler's
// first tick decides anything, so it sees morningFiredAt already set and
// never re-fires the morning brief. runMorning()/runCheckin()/runEvening()
// are exposed directly (for the daily_plan tool's explicit "replan" action
// and for tests) and do NOT themselves guard against re-firing — the guard
// lives in tick()'s scheduling decision, so an explicit re-brief via the tool
// is allowed on purpose while the automatic scheduler never double-fires.

var DAY_DIR = 'Plans';
var BRAIN_TIMEOUT_MS = 12000;
var TICK_MS = 60000;

var CANNED_MORNING = 'Good morning. My reasoning brain is offline right now, so I can\'t compose a full brief, but your plan file is ready — check your active goals when you get a chance.';
var CANNED_CHECKIN = 'Quick check-in: one of your goals looks stalled. My reasoning brain is offline right now, so I can\'t give specifics — take a look when you can.';
var CANNED_EVENING = 'Evening review: my reasoning brain is offline right now, so I can\'t summarize today in detail, but your plan file has been updated.';

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKeyFor(ts) {
  var d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function dayFilePath(dateKey) {
  return DAY_DIR + '/' + dateKey + '.json';
}

function createDailyPlanner({ bus, config, memory, goals, brain, identity, logger, now }) {
  if (!memory || !memory.fs) throw new Error('createDailyPlanner requires memory (with .fs)');
  if (!goals) throw new Error('createDailyPlanner requires goals');

  var fs = memory.fs;
  var nowFn = typeof now === 'function' ? now : Date.now;
  var generation = 0;
  var timer = null;
  var running = false;
  // runCheckin() below nags only when the stalled-goal set actually changed —
  // see diff-gate.js.
  var diffGate = createDiffGate();

  // ---- day-file persistence ----

  function loadDay(dateKey) {
    var data = fs.readJSON(dayFilePath(dateKey), null);
    if (!data) {
      data = {
        date: dateKey, focus: [], checkins: [], review: null,
        morningFiredAt: null, lastCheckinAt: null, eveningFiredAt: null
      };
    }
    return data;
  }

  function saveDay(day) {
    try { fs.ensureDir(DAY_DIR); } catch (_) { /* best-effort, writeJSON below also ensures parent dirs */ }
    try {
      fs.writeJSON(dayFilePath(day.date), day);
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'planner-save-failed', error: err.message });
    }
  }

  // ---- brain composition (12s timeout + canned fallback, mirrors
  // server/index.js's boot-greeting brain-offline pattern exactly) ----

  function brainCompose(promptText, canned, source) {
    if (!brain || typeof brain.think !== 'function') return Promise.resolve(canned);
    return Promise.race([
      brain.think({ lane: 'voice', messages: [{ role: 'user', content: promptText }], source: source }),
      new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(null); }, BRAIN_TIMEOUT_MS);
        if (t.unref) t.unref();
      })
    ]).then(function (result) {
      if (result && !result.offline && result.content) {
        return String(result.content).trim().replace(/^["']+|["']+$/g, '').slice(0, 600);
      }
      return canned;
    }).catch(function (err) {
      if (logger && typeof logger.warn === 'function') logger.warn('planner.brain-failed', { error: err.message, source: source });
      return canned;
    });
  }

  // ---- morning brief ----

  async function runMorning() {
    var ts = nowFn();
    var dateKey = dateKeyFor(ts);
    var day = loadDay(dateKey);

    var top = null;
    try { top = goals.arbitrate([], {}); } catch (_) { /* arbiter unavailable — proceed without a top pick */ }
    var active = [];
    try { active = goals.list({ status: 'active' }); } catch (_) { /* goals unavailable */ }

    var focus = active.map(function (g) {
      return {
        goalId: g.id, title: g.title, priority: g.priority,
        deadline: (g.budget && g.budget.deadline) || null
      };
    });
    // Surface the arbiter's top pick first — reuses arbitrate()'s ranking,
    // never re-implements it.
    if (top) {
      focus.sort(function (a, b) {
        if (a.goalId === top.id) return -1;
        if (b.goalId === top.id) return 1;
        return 0;
      });
    }

    var prompt;
    if (active.length === 0) {
      prompt = 'Compose a short (max 3 sentences) spoken morning briefing for the operator. ' +
        'They have no active goals right now. Say so plainly and suggest they pick one to focus on today. ' +
        'Reply with ONLY the spoken briefing, no markdown, no quotes.';
    } else {
      var topTitle = top ? top.title : active[0].title;
      var others = active.map(function (g) { return g.title; }).filter(function (t) { return t !== topTitle; });
      prompt = 'Compose a short (max 3 sentences) spoken morning briefing for the operator. ' +
        'Their top-priority goal today is: "' + topTitle + '". ' +
        (others.length ? ('Other active goals: ' + others.join('; ') + '. ') : '') +
        'Name the top goal and set a focused tone for the day. ' +
        'Reply with ONLY the spoken briefing, no markdown, no quotes.';
    }
    var text = await brainCompose(prompt, CANNED_MORNING, 'planner:morning');

    day.focus = focus;
    day.morningFiredAt = ts;
    saveDay(day);

    if (bus) bus.emit('plan.morning-brief', { text: text });
    return { text: text, focus: focus };
  }

  // ---- stall check-in ----

  async function runCheckin() {
    var ts = nowFn();
    var dateKey = dateKeyFor(ts);
    var day = loadDay(dateKey);

    var active = [];
    try { active = goals.list({ status: 'active' }); } catch (_) { /* goals unavailable */ }

    var reference = day.lastCheckinAt || day.morningFiredAt || ts;
    var stalled = active.filter(function (g) {
      if (g.lastActionAt) return g.lastActionAt < reference;
      // A goal that has never had any action at all is also stalled once it
      // predates the reference point — otherwise a goal that's never been
      // touched could never trigger a nudge.
      return g.createdAt < reference;
    });

    if (stalled.length === 0) {
      day.lastCheckinAt = ts;
      saveDay(day);
      return null; // all goals progressing — skip silently, no emit
    }

    // Diff-gate: the SAME stalled goals reported last time carry no new
    // information — without this, the operator gets an identical nag every
    // checkinEveryMs (default 3h) for as long as a goal sits untouched. The
    // scheduling cadence itself (tick()'s checkinEveryMs spacing) is untouched;
    // this only gates whether THIS particular fire has anything new to say.
    var stalledTitles = stalled.map(function (g) { return g.title; }).sort();
    if (!diffGate.hasChanged('checkin-stalled', stalledTitles)) {
      day.lastCheckinAt = ts;
      saveDay(day);
      return null;
    }

    var names = stalled.map(function (g) { return g.title; }).join(', ');
    var prompt = 'Compose a short (max 2 sentences) spoken accountability check-in for the operator. ' +
      'These goals look stalled (no recent progress): ' + names + '. Name them by title and nudge toward a next step. ' +
      'Reply with ONLY the spoken nudge, no markdown, no quotes.';
    var text = await brainCompose(prompt, CANNED_CHECKIN, 'planner:checkin');

    day.checkins.push({ ts: ts, note: text });
    day.lastCheckinAt = ts;
    saveDay(day);

    if (bus) bus.emit('plan.checkin', { text: text });
    return { text: text, stalled: stalled.map(function (g) { return g.title; }) };
  }

  // ---- evening review ----

  async function runEvening() {
    var ts = nowFn();
    var dateKey = dateKeyFor(ts);
    var day = loadDay(dateKey);

    var done = [];
    var slipped = [];
    for (var i = 0; i < day.focus.length; i++) {
      var f = day.focus[i];
      var g = null;
      try { g = goals.get(f.goalId); } catch (_) { /* goals unavailable */ }
      if (g && g.status === 'done') done.push(f.title);
      else slipped.push(f.title);
    }

    var prompt = 'Compose a short (max 3 sentences) spoken evening review for the operator. ' +
      'Completed today: ' + (done.length ? done.join(', ') : 'none') + '. ' +
      'Slipped or still open: ' + (slipped.length ? slipped.join(', ') : 'none') + '. ' +
      'Summarize progress honestly and set up tomorrow. ' +
      'Reply with ONLY the spoken review, no markdown, no quotes.';
    var text = await brainCompose(prompt, CANNED_EVENING, 'planner:evening');

    day.review = { summary: text, done: done, slipped: slipped };
    day.eveningFiredAt = ts;
    saveDay(day);

    if (bus) bus.emit('plan.evening-review', { text: text });
    return { text: text, review: day.review };
  }

  // ---- daily_plan tool support ----

  function status() {
    return loadDay(dateKeyFor(nowFn()));
  }

  // Quiet day: mark every fired-flag so the scheduler never fires again today.
  // Not part of the spec's literal { start, stop, runMorning, runCheckin,
  // runEvening, status } return list — added so the daily_plan tool's
  // skip_today action has something concrete to call (same "added beyond the
  // literal snippet" precedent as identity.js's getMaxAutonomousTier()).
  function skipToday() {
    var ts = nowFn();
    var day = loadDay(dateKeyFor(ts));
    day.morningFiredAt = day.morningFiredAt || ts;
    day.lastCheckinAt = ts;
    day.eveningFiredAt = ts;
    saveDay(day);
    return day;
  }

  // ---- scheduler ----

  function tick() {
    var ts = nowFn();
    var d = new Date(ts);
    var hour = d.getHours();
    var day = loadDay(dateKeyFor(ts));

    var morningHour = (config && typeof config.PLANNER_MORNING_HOUR === 'number') ? config.PLANNER_MORNING_HOUR : 9;
    var eveningHour = (config && typeof config.PLANNER_EVENING_HOUR === 'number') ? config.PLANNER_EVENING_HOUR : 21;
    var checkinEveryMs = (config && config.PLANNER_CHECKIN_EVERY_MS) || 10800000;

    // Morning: fire once, at/after the hour boundary, only if not already
    // fired today — the idempotence guard the restart test depends on.
    if (!day.morningFiredAt && hour >= morningHour) {
      return runMorning();
    }

    // Evening: fire once, at/after the hour boundary, only after the morning
    // brief has fired and evening hasn't yet.
    if (day.morningFiredAt && !day.eveningFiredAt && hour >= eveningHour) {
      return runEvening();
    }

    // Check-in: only between morning and evening, spaced by checkinEveryMs,
    // counted from the morning-brief-fired time (or the previous check-in).
    if (day.morningFiredAt && !day.eveningFiredAt) {
      var reference = day.lastCheckinAt || day.morningFiredAt;
      if (ts - reference >= checkinEveryMs) {
        return runCheckin();
      }
    }
    return null;
  }

  function start() {
    generation++;
    var myGen = generation;
    running = true;
    timer = setInterval(function () {
      if (generation !== myGen) return;
      try { tick(); } catch (err) {
        if (logger && typeof logger.warn === 'function') logger.warn('planner.tick-failed', { error: err.message });
      }
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start: start, stop: stop,
    runMorning: runMorning, runCheckin: runCheckin, runEvening: runEvening,
    status: status, skipToday: skipToday,
    isRunning: function () { return running; },
    _internal: { tick: tick, loadDay: loadDay, saveDay: saveDay, dateKeyFor: dateKeyFor }
  };
}

module.exports = { createDailyPlanner: createDailyPlanner };
