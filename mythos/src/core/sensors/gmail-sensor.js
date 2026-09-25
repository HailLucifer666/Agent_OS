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
// When the bound fn returns { ok:false, ... } (Gmail unconfigured or
// breaker-open), the poll is a silent no-op — no throw, no health.anomaly.
//
// BUG-273 C2 — WITH ONE EXCEPTION, added 2026-08-18. `gmail_unread` failed twice
// that session with "invalid_grant: Token has been expired or revoked", and the
// operator's report was that Gmail "fails every now and then" — the signature of an
// OAuth app left in Testing publishing status, where Google expires refresh tokens
// after seven days. from-gmail.js already classifies that as terminal and names the
// remedy in the failure text, so the tool is honest. The gap is WHEN the operator
// finds out: only by asking for mail and being told.
//
// This sensor already knew. It polls every GMAIL_TRIAGE_POLL_MS, discovered the
// dead token on every pass, and threw the answer away at the `!res.ok` line below.
// So the proactive check the fix plan asks for does not need building — it needs
// its result not discarded.
//
// Q1 — WHAT ELSE MATCHES THIS? Only the OAuth grant signature, via from-gmail.js's
// exported isTerminalAuthError. NOT 'Gmail unconfigured': a fresh clone with no
// Google keys is a legitimate degraded state and telling that operator to re-auth
// would be nonsense. NOT breaker-open, which is transient by construction. One
// definition, imported, so the two cannot drift into disagreeing about what
// 'terminal' means.
//
// Q8 — STILL NO RETRY. The plan is explicit that retrying a revoked token forever
// is the fail-open shape, and hub.js's isTerminalResult already stops the breaker
// counting it as a retryable failure. This adds an announcement, not an attempt.
//
// ONCE PER OUTAGE, not once per poll: at a 5-minute cadence the latter would be
// twelve identical spoken alarms an hour, which is how a real warning gets ignored.
// The latch clears on the next successful poll, so a re-auth followed by another
// expiry a week later is announced again.
var isTerminalAuthError = require('../effectors/from-gmail').isTerminalAuthError;

function createGmailSensor(ctx) {
  var gmailUnread = ctx.gmailUnread;
  var bus = ctx.bus;
  var pollMs = ctx.pollMs || 300000;
  var mode = ctx.mode || 'poll';
  var generation = 0;
  var timer = null;
  var seenIds = new Set();
  var pollCount = 0;
  // BUG-273 C2: latched so one dead token produces one announcement, not one per
  // poll. Cleared by a success below.
  var reauthAnnounced = false;

  function poll(myGen) {
    if (typeof gmailUnread !== 'function') return;
    pollCount++;
    Promise.resolve()
      .then(function () { return gmailUnread({}); })
      .then(function (res) {
        if (generation !== myGen) return; // stopped/restarted mid-flight
        if (!res || !res.ok) {
          // BUG-273 C2: everything except a terminal OAuth failure stays a silent
          // no-op, exactly as before. See the header for why this one does not.
          var why = (res && res.result && res.result.error) || (res && res.result) || '';
          if (!reauthAnnounced && isTerminalAuthError(res && res.result, why)) {
            reauthAnnounced = true;
            if (bus) {
              // `reason` carries the whole message because an anomaly with no
              // playbook is spoken from reason/target — so this has to read as a
              // sentence to the operator, not as a slug.
              bus.emit('health.anomaly', {
                kind: 'gmail-reauth-required',
                target: 'gmail',
                // BUG-273 C2 (second half): the immune explainer asks the brain to pick a
                // mechanical remedy for anomalies that have none, and on 2026-08-18 it
                // picked `probe_provider` for THIS one — so MYTHOS re-probed the AI
                // providers and announced it was doing so, for a dead Google OAuth token.
                // This flag says the fault is terminal and human-only, so no remedy is
                // guessed at all. The reason below is already the complete instruction.
                needsOperator: true,
                // BUG-447 (2026-09-25, operator decision): what is SPOKEN is this one
                // plain sentence; `reason` below keeps the full steps, and the HUD's
                // Anomalies list shows them. Read aloud, the steps were a command line.
                sayToOperator: 'Gmail has stopped working because its Google sign-in expired, and it needs you to sign in again.',
                reason: 'Gmail has stopped working and it will not recover on its own: the Google '
                  + 'refresh token is expired or revoked. Nothing was read. Re-authorise by running '
                  + '`node scripts/google-auth.js` and putting the new GOOGLE_REFRESH_TOKEN in '
                  + 'mythos/.env. If this keeps happening every few days, the Google Cloud OAuth app '
                  + 'is still in Testing publishing status, which expires refresh tokens after seven '
                  + 'days — moving it to Production stops it recurring.',
                detail: String(why).slice(0, 200),
              });
            }
          }
          return;
        }
        // A working poll clears the latch, so a later expiry is announced again
        // rather than being suppressed for the life of the process.
        reauthAnnounced = false;
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
