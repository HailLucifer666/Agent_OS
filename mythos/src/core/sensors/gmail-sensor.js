'use strict';
// gmail-sensor.js — polls a bound gmailUnread() fn and emits
// 'gmail.unread-batch' for genuinely new message ids. Pattern mirrors
// reminder-sensor.js: generation token + unref to avoid keeping process alive.
//
// BUG-111: ctx.mode (mirrors config.GMAIL_TRIAGE_MODE) gates the recurring
// cadence — a stored `remember` note can't stop a background timer, so this
// has to be a config decision:
//   - 'boot-once': one pass at start(), no recurring interval at all.
//   - 'poll' (also the default when ctx.mode is omitted, for back-compat with
//     callers that predate this option): today's always-on GMAIL_TRIAGE_POLL_MS
//     (default 300000ms / 5min) recurring behavior, unchanged.
//   - 'off': the sensor never polls at all.
// gmail_unread (the effector/tool itself) is untouched by any mode — explicit
// requests still work normally.
//
// Dedup: an in-memory seenIds Set tracks message ids already announced.
// Known accepted limitation: seenIds resets on process restart, which can
// cause one possible re-announcement of already-seen mail after a restart.
//
// When the bound fn returns { ok:false, ... } (Gmail unconfigured/not authed/
// breaker-open), the poll is a silent no-op — no throw, no health.anomaly.
function createGmailSensor(ctx) {
  var gmailUnread = ctx.gmailUnread;
  var bus = ctx.bus;
  var pollMs = ctx.pollMs || 300000;
  var mode = ctx.mode || 'poll';
  var generation = 0;
  var timer = null;
  var seenIds = new Set();
  var pollCount = 0;

  function poll(myGen) {
    if (typeof gmailUnread !== 'function') return;
    pollCount++;
    Promise.resolve()
      .then(function () { return gmailUnread({}); })
      .then(function (res) {
        if (generation !== myGen) return; // stopped/restarted mid-flight
        if (!res || !res.ok) return; // Gmail unconfigured/not authed/breaker-open — silent no-op
        var messages = (res.result && res.result.messages) || [];
        var fresh = messages.filter(function (m) { return m && m.id && !seenIds.has(m.id); });
        if (!fresh.length) return;
        fresh.forEach(function (m) { seenIds.add(m.id); });
        if (bus) bus.emit('gmail.unread-batch', { count: fresh.length, messages: fresh });
      })
      .catch(function () { /* best-effort */ });
  }

  function start() {
    if (mode === 'off') return; // never polls at all
    generation++;
    var myGen = generation;
    if (mode === 'boot-once') {
      try {
        poll(myGen);
      } catch (_) { /* best-effort */ }
      return; // no recurring timer — exactly one pass, ever
    }
    timer = setInterval(function () {
      if (generation !== myGen) return;
      try {
        poll(myGen);
      } catch (_) { /* best-effort */ }
    }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function getPollCount() {
    return pollCount;
  }

  return { start: start, stop: stop, getPollCount: getPollCount };
}
module.exports = { createGmailSensor };
