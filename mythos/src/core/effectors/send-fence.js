'use strict';

// effectors/send-fence.js — BUG-476 (2026-10-06): one logical WhatsApp send at a
// time, and a send whose caller stopped waiting stops before it can submit.
//
// WHAT HAPPENED. 2026-10-06, vault/Audit: three leash confirms for the same
// message to the same contact (09:33:57, 09:34:07, 09:34:32), all three clicked.
// Each became its own dispatch on channel 'confirm-accept' — server/index.js
// passes no signal there, so dispatch-action.js arms AbortSignal.timeout(
// ACTION_TIMEOUT_MS), 30 s by default (config/schema.js). The second dispatch hit
// that deadline at 09:34:39.05. hub.js's raceSignal then stopped WAITING for it —
// and only that: whatsapp_send never read a signal, so its queued desktop steps
// kept draining (ui_type 09:34:45, submit 09:34:49) while the third dispatch ran
// its own (submit 09:34:55, the confirmed ok). Two submits, up to two messages.
// (The ticket's "about 8 s" timed the THIRD call; the timed-out one was the
// second, and the 09:34:40.656 immune-explain line trails the anomaly by one
// brain round trip.)
//
// WHAT THIS DOES, through seams that already exist. The hub already hands
// ctx.signal to effector.invoke, and adapter.js already hands ctx to tool.fn —
// the signal simply arrived at a function that ignored it. So:
//   1. checkpoint(stage): whatsapp_send asks immediately before typing and
//      immediately before submitting whether its caller has given up. If so it
//      stops and says NOTHING was sent — the honest "cancelled before
//      submission" outcome, distinct from an uncertain one.
//   2. run(): one entry per logical send (recipient number + normalised text).
//      A second identical send while one is running is REFUSED, not queued
//      behind it, and a send that ended without proof stays refused for
//      UNCERTAIN_SEND_HOLD_MS. An uncertain send never triggers an automatic
//      resubmission.
//   3. Every admitted call settles into exactly one terminal outcome, logged as
//      `whatsapp-send.settled` with the dispatch traceId, so the late truth of a
//      timed-out call can be joined to the Audit row that said 'tool-timeout'.
//
// Not a new action path: nothing here dispatches. The leash and dispatch-action
// remain the only way in; this only decides whether an admitted whatsapp_send
// may proceed, and what it must say when it may not.
//
// Module scope on purpose, like implicit-target.js: from-pc.js's send_key must
// see the same state, and it cannot require from-whatsapp.js (which requires it).
//
// ATTACK ANSWERS (2026-10-06, written before calling this done):
//  - What else matches? keyOf folds case, punctuation and spacing, so "Hi!" and
//    "hi" are one send; that refuses a genuinely different message only while an
//    identical-looking one is unresolved, which is the safe direction. A message
//    with no letters or digits keeps its raw text so emoji-only messages do not
//    collide. Different recipient or different words: never blocked (test 8).
//  - Does it hide evidence? No. A refusal returns ok:false with its own reason,
//    so dispatch-action audits it like any failure; the late outcome of a call
//    the hub stopped waiting for — which used to vanish entirely — is now logged
//    as whatsapp-send.settled with the dispatch traceId.
//  - What did this make unreachable (gate F)? A whatsapp_send's own `cancelled`
//    result never reaches a hub caller: raceSignal has already answered
//    'tool-timeout' by then. Only this module and the log read it, and the next
//    attempt's note is how the model hears it. The hub's 'tool-timeout' text
//    ("NOT cancelled ... may already have landed") is now conservative for this
//    one tool rather than exact; it is deliberately left as is, because at the
//    moment it is written the hub cannot know which side of the submit the
//    effector was on. The `threw` mid-submit branch is a backstop: from-pc's
//    delegate catches, so with the real adapter a submit does not throw.
//  - Deliberately NOT fenced: ui_type. It cannot submit on its own (the submit
//    ladder is a separate command), and fencing it needs the target's process
//    name, which ui_type does not have. Typing into the box while a send is in
//    flight can corrupt that message; it cannot duplicate it. Pinned by test 10c.
//  - Not covered: two DIFFERENT sends still interleave their desktop steps in
//    pc-child's FIFO; a refusal counts as a breaker failure, so a burst of
//    refused retries can open whatsapp_send's breaker for its cooldown; a state
//    that lives in one process does not survive a restart.

// How long a send that ended without proof keeps its duplicate refused. The
// measured retry loops were seconds apart (2026-10-06: three calls in 35 s;
// 2026-10-05: six in two minutes), so this outlasts them comfortably while still
// letting an operator who has checked the chat ask again later. Also bounds a
// running entry whose effector never settles, so a wedged send cannot block this
// message forever.
const UNCERTAIN_SEND_HOLD_MS = 5 * 60 * 1000;

const entries = new Map(); // key -> attempt (running, or held after an unproven end)
const notes = new Map();   // key -> sentence for the NEXT attempt (an earlier one sent nothing)
let attemptSeq = 0;
let clock = Date.now;

// Case, punctuation and spacing do not make a different message: "Test, this
// is a test." retried as "test this is a test" is the same send to the person
// receiving it. Digits only for the number, so "Alex" and "+1 555..." resolving
// to the same contact share one key.
function keyOf(number, message) {
  const digits = String(number || '').replace(/\D/g, '');
  const words = String(message || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // A message with no letters or digits ("👍", "?") would otherwise normalise to
  // '' and share one key with every other such message to this contact.
  return digits + '|' + (words || String(message || '').trim());
}

function expire() {
  const now = clock();
  for (const [key, a] of entries) {
    if (now - a.since > UNCERTAIN_SEND_HOLD_MS) entries.delete(key);
  }
}

const DO_NOT_RETRY = ' Do not send it again. Tell the operator and ask them to check the chat.';

function refusal(a) {
  const ago = Math.max(0, Math.round((clock() - a.since) / 1000));
  const who = a.label || 'this contact';
  let why;
  if (a.state === 'running') {
    why = 'REFUSED, and nothing was done by this call: an identical WhatsApp message to ' + who
      + ' is still being sent by an earlier call (started ' + ago + 's ago)'
      + (a.signal && a.signal.aborted
        ? ', whose caller stopped waiting before it finished. It has not reported back yet, so it may still go out.'
        : '.');
  } else if (a.state === 'typed') {
    why = 'REFUSED, and nothing was done by this call: an earlier attempt typed this exact message to ' + who
      + ' and was stopped before submitting, so it was not sent, but the text may still be in the message box. '
      + 'Sending it again would type it a second time after the first.';
  } else if (a.state === 'landed') {
    why = 'REFUSED, and nothing was done by this call: this exact message to ' + who
      + ' was sent by an earlier call that finished after its caller had stopped waiting. Sending again would duplicate it.';
  } else {
    why = 'REFUSED, and nothing was done by this call: an earlier attempt to send this exact message to ' + who
      + ' ended without proof either way, so it may already have been sent.';
  }
  return { ok: false, result: why + DO_NOT_RETRY, notExecuted: true, duplicateOf: a.traceId || a.id };
}

// The stage the caller gave up at decides the sentence. Before typing nothing
// touched the composer; before submitting the text may be sitting in it.
function cancelledResult(stage, label) {
  const where = stage === 'submit'
    ? 'after typing it but before submitting, so nothing was sent — the text may still be sitting in the message box, unsent.'
    : 'before typing anything, so nothing was sent.';
  return { ok: false, cancelled: true, sent: false,
    result: 'Cancelled: the call sending this to ' + (label || 'this contact')
      + ' was stopped by its caller ' + where };
}

// The terminal outcome of one admitted call, from what it returned (or threw)
// and how far it got. 'submitting' is the only stage where the world may have
// changed without this call knowing for sure.
function outcomeOf(a, result, threw) {
  if (result && result.cancelled === true) return a.stoppedAt === 'submit' ? 'cancelled-after-typing' : 'cancelled-before-submit';
  if (!threw && result && result.ok && result.result && result.result.sent === true) return 'sent';
  if (a.stage === 'submitting' && (threw || !result || !result.ok)) return 'submit-unproven';
  return 'not-sent';
}

function settle(key, a, result, threw, logger) {
  const callerGaveUp = Boolean(a.signal && a.signal.aborted);
  const outcome = outcomeOf(a, result, threw);
  // A caller that got the result holds the truth, so nothing needs holding —
  // except a throw mid-submit, which reached nobody as an answer about the world.
  // A caller that gave up was told only 'tool-timeout', so anything that may have
  // gone out stays held.
  let held = null;
  if (outcome === 'sent' && callerGaveUp) held = 'landed';
  else if (outcome === 'submit-unproven' && (callerGaveUp || threw)) held = 'uncertain';
  // Review finding, 2026-10-07: stopped AFTER typing, the text may still sit in the
  // composer. Releasing the entry let a retry type the message a second time after
  // it (whatsapp_send appends to an existing draft: "Hi Hi"), and let a raw Enter
  // submit the leftover (refuseRawSubmit saw no entry). Held, both are refused.
  else if (outcome === 'cancelled-after-typing') held = 'typed';
  if (held) {
    a.state = held;
    a.since = clock();
  } else {
    entries.delete(key);
    if (callerGaveUp) {
      notes.set(key, 'An earlier attempt at this exact message (' + (a.traceId || a.id) + ') stopped before '
        + 'submitting after its caller timed out, so it sent nothing.');
    }
  }
  if (logger) {
    const log = callerGaveUp || held ? logger.warn : logger.info;
    try {
      log.call(logger, 'whatsapp-send.settled', { attempt: a.id, traceId: a.traceId || null,
        outcome: outcome, callerGaveUp: callerGaveUp, held: held });
    } catch (_) { /* logging must never change a send's outcome */ }
  }
}

// steps(fence) is the send itself. fence.checkpoint(stage) returns a cancelled
// result to return, or null to go on; fence.submitting() marks the point after
// which the world may have changed.
async function run({ number, message, label, ctx, logger }, steps) {
  expire();
  const key = keyOf(number, message);
  const held = entries.get(key);
  if (held) return refusal(held);
  const signal = (ctx && ctx.signal) || null;
  const a = { id: 'wa-send-' + (++attemptSeq), traceId: (ctx && ctx.traceId) || null, label: label,
    signal: signal, state: 'running', stage: 'before-type', since: clock() };
  entries.set(key, a);
  const note = notes.get(key);
  notes.delete(key);
  const fence = {
    checkpoint(stage) {
      if (!(signal && signal.aborted)) return null;
      a.stoppedAt = stage;
      return cancelledResult(stage, label);
    },
    submitting() { a.stage = 'submitting'; },
  };
  let result, threw = null;
  try {
    result = await steps(fence);
  } catch (err) {
    threw = err;
  }
  settle(key, a, result, threw, logger);
  if (threw) throw threw;
  if (note && result && result.ok && result.result && typeof result.result === 'object') {
    return Object.assign({}, result, { result: Object.assign({}, result.result,
      { note: note + ' ' + String(result.result.note || '') }) });
  }
  return result;
}

// from-pc.js send_key: with WhatsApp in the foreground, Enter goes to the same
// submit ladder whatsapp_send uses. While any WhatsApp send is running or held,
// that Enter would submit whatever is in the box — including a message a timed-out
// send typed and was stopped from submitting. Returns the refusal text, or null.
function refuseRawSubmit(app) {
  if (!/whatsapp/i.test(String(app || ''))) return null;
  expire();
  if (entries.size === 0) return null;
  return 'Refusing to press Enter in WhatsApp: a WhatsApp send is still in flight, ended without proof, or was stopped with its text still in the box, '
    + 'and Enter would submit whatever is in the message box. Nothing was pressed.' + DO_NOT_RETRY;
}

function _resetForTests(opts) {
  entries.clear();
  notes.clear();
  clock = (opts && opts.now) || Date.now;
}

module.exports = { run, refuseRawSubmit, keyOf, UNCERTAIN_SEND_HOLD_MS, _resetForTests };
