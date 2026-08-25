'use strict';

// bug-273-c2-gmail-reauth-announced.test.js — BUG-273 C2, the code half.
//
// MEASURED: `gmail_unread -> fail` twice on 2026-08-18, both "invalid_grant: Token
// has been expired or revoked", and the operator's own description is that Gmail
// "fails every now and then". That cadence is the signature of a Google Cloud OAuth
// app left in **Testing** publishing status, where refresh tokens expire after seven
// days. THE REAL FIX IS THE OPERATOR'S: move the app to Production/External, or
// accept weekly re-consent. No code change makes a revoked token work.
//
// What code can fix is WHEN the operator finds out. from-gmail.js already classifies
// this as terminal and names the remedy in the failure text, so the tool is honest —
// but the operator only learns by asking for mail and being told no.
//
// AND THE CHECK ALREADY EXISTED. gmail-sensor.js polls every GMAIL_TRIAGE_POLL_MS,
// discovered the dead token on every single pass, and threw the answer away at
// `if (!res || !res.ok) return;` — commented, accurately, as a silent no-op. So the
// "proactive check" the fix plan asks for did not need building. It needed its result
// not discarded.
//
// Q1 — WHAT ELSE MATCHES THIS? Only the OAuth grant signature, decided by
// from-gmail.js's exported isTerminalAuthError so there is ONE definition rather than
// a second regex that drifts. Not "Gmail unconfigured": a fresh clone with no Google
// keys is a legitimate degraded state and telling that operator to re-authorise would
// be nonsense. Not breaker-open, which is transient by construction.
//
// Q8 — STILL NO RETRY, deliberately. The plan is explicit that retrying a revoked
// token forever is the fail-open shape, and hub.js's isTerminalResult already keeps
// the breaker from counting it as retryable. This adds an announcement, not an
// attempt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createGmailSensor } = require('../src/core/sensors/gmail-sensor');
const { isTerminalAuthError } = require('../src/core/effectors/from-gmail');

const REVOKED = { ok: false, result: { error: 'Gmail fetch failed: invalid_grant: Token has been expired or revoked.' } };
const UNCONFIGURED = { ok: false, result: { error: 'Gmail is not configured — set GOOGLE_CLIENT_ID and GOOGLE_REFRESH_TOKEN in mythos/.env.' } };
const BREAKER_OPEN = { ok: false, result: { error: 'circuit-open' } };
const RATE_LIMITED = { ok: false, result: { error: 'Gmail fetch failed: 429 Too Many Requests' } };

// The sensor polls asynchronously through a promise chain, so let the microtasks run.
const settle = () => new Promise((r) => setTimeout(r, 20));

function run(responses) {
  const events = [];
  let i = 0;
  const sensor = createGmailSensor({
    mode: 'boot-once',
    bus: { emit: (kind, payload) => events.push({ kind, payload }) },
    gmailUnread: async () => responses[Math.min(i++, responses.length - 1)],
  });
  return { sensor, events, poll: () => sensor.start() };
}

const anomalies = (events) => events.filter((e) => e.kind === 'health.anomaly');

describe('BUG-273 C2 — a revoked token is announced instead of discarded', () => {
  it('emits one gmail-reauth-required anomaly on the terminal auth failure', async () => {
    const { events, poll } = run([REVOKED]);
    poll();
    await settle();
    const a = anomalies(events);
    assert.equal(a.length, 1, 'the sensor knew on the very first poll and used to say nothing');
    assert.equal(a[0].payload.kind, 'gmail-reauth-required');
    assert.equal(a[0].payload.target, 'gmail');
  });

  it('the reason reads as a spoken sentence, names the remedy, and names the ROOT cause', async () => {
    const { events, poll } = run([REVOKED]);
    poll();
    await settle();
    const reason = String(anomalies(events)[0].payload.reason);
    // An anomaly with no playbook is spoken from reason/target, so this is what the
    // operator actually hears — it has to be a sentence, not a slug.
    assert.match(reason, /will not recover on its own/, 'it must not read as a transient blip');
    assert.match(reason, /google-auth\.js/, 'and must name the command that fixes it');
    assert.match(reason, /GOOGLE_REFRESH_TOKEN/);
    assert.match(reason, /Testing publishing status/,
      'the recurrence is the actual complaint ("fails every now and then"), and the '
      + 'operator cannot act on it without being told why it keeps coming back');
    assert.match(reason, /Production/, 'including the change that stops it recurring');
  });

  it('Q1 — an UNCONFIGURED Gmail stays silent: a fresh clone must not be told to re-auth', async () => {
    const { events, poll } = run([UNCONFIGURED]);
    poll();
    await settle();
    assert.equal(anomalies(events).length, 0,
      'no Google keys is a legitimate degraded state on any fresh clone, and portability '
      + 'requires it degrade honestly and quietly');
  });

  it('Q1 — a breaker-open poll stays silent: transient is not terminal', async () => {
    const { events, poll } = run([BREAKER_OPEN]);
    poll();
    await settle();
    assert.equal(anomalies(events).length, 0);
  });

  it('Q1 — a 429 stays silent and stays retryable', async () => {
    const { events, poll } = run([RATE_LIMITED]);
    poll();
    await settle();
    assert.equal(anomalies(events).length, 0,
      'a blanket 4xx rule here would make every rate limit look like a revoked grant');
  });

  it('once per outage, not once per poll — twelve alarms an hour is how a warning gets ignored', async () => {
    const { events, sensor } = run([REVOKED]);
    for (let n = 0; n < 4; n++) { sensor.start(); await settle(); }
    assert.equal(anomalies(events).length, 1, 'the latch must survive repeated polls');
  });

  it('a successful poll clears the latch, so a later expiry is announced again', async () => {
    const { events, sensor } = run([REVOKED, { ok: true, result: { messages: [] } }, REVOKED]);
    sensor.start(); await settle();   // revoked -> announced
    sensor.start(); await settle();   // recovered -> latch cleared
    sensor.start(); await settle();   // revoked again -> announced again
    assert.equal(anomalies(events).length, 2,
      're-authorising and then expiring a week later is the reported pattern, and the '
      + 'second outage must not be suppressed for the life of the process');
  });

  it('a normal batch still emits gmail.unread-batch and no anomaly', async () => {
    const { events, poll } = run([{ ok: true, result: { messages: [{ id: 'm1' }] } }]);
    poll();
    await settle();
    assert.equal(anomalies(events).length, 0);
    assert.ok(events.some((e) => e.kind === 'gmail.unread-batch'), 'the happy path is untouched');
  });
});

describe('BUG-273 C2 — one definition of "terminal", shared', () => {
  it('the sensor uses the effector\'s own test rather than a second regex', () => {
    assert.equal(typeof isTerminalAuthError, 'function',
      'exported so the two cannot drift into disagreeing about what terminal means');
    assert.equal(isTerminalAuthError(null, 'invalid_grant: Token has been expired or revoked.'), true);
    assert.equal(isTerminalAuthError(null, 'unauthorized_client'), true);
    assert.equal(isTerminalAuthError(null, '429 Too Many Requests'), false);
    assert.equal(isTerminalAuthError(null, 'circuit-open'), false);
    assert.equal(isTerminalAuthError({ isAuthError: true }, 'anything'), true,
      'the adapter flag is the primary signal; the regex is the fallback');
  });
});
