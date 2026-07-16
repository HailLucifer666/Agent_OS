'use strict';
// gmail-sensor.js — polls a bound gmailUnread() fn every GMAIL_TRIAGE_POLL_MS
// (default 300000ms / 5min) and emits 'gmail.unread-batch' for genuinely new
// message ids. Pattern mirrors reminder-sensor.js: generation token + unref
// to avoid keeping process alive.
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
  var generation = 0;
  var timer = null;
  var seenIds = new Set();

  function poll(myGen) {
    if (typeof gmailUnread !== 'function') return;
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
    generation++;
    var myGen = generation;
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

  return { start: start, stop: stop };
}
module.exports = { createGmailSensor };
