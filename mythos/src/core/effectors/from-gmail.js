'use strict';

// Gmail effector — gmail_unread, gmail_read, gmail_draft, gmail_send tools.
// Google adapter is injected via createGoogleAdapter deps (client ID/secret/refresh).

var effectorFromTool = require('./adapter').effectorFromTool;
var { reasonText } = require('../util/reason-text');

var _adapter = null;

// D3 — the authenticated account's own address, resolved once per session
// via the Gmail profile (not a config key) and reused so "me" never triggers
// a network call on every send/draft.
var _selfEmail = null;

function ok(data) { return { ok: true, result: data }; }
function fail(msg) { return { ok: false, result: { error: msg } }; }

// B5 (2026-08-14): eleven Gmail failures that day, ten of them `invalid_grant`,
// and MYTHOS told the operator "Network request failed... Google APIs appear
// unreachable" and filed an incident saying so. That is a wrong diagnosis on the
// record: invalid_grant comes from Google's token endpoint answering, not from an
// unreachable network, and no retry or restart can fix it — it needs the
// operator's browser consent to re-mint the refresh token.
//
// The adapter now flags this shape (isAuthError / googleError), so the failure
// text can name the actual remedy instead of leaving the model to guess a cause.
// Matching on the flag rather than on message text, per the same reasoning that
// put `attemptTimedOut` in chain.js's decision instead of a regex.
// BUG-296 (2026-08-21): the classifier and the remedy text moved to
// ./google-auth-failure.js and are re-exported here unchanged.
//
// They were never Gmail-specific — Gmail and Calendar authenticate with the SAME
// refresh token, so when it dies they fail together. Only Gmail handled it.
// Calendar returned a bare 'Calendar fetch failed: invalid_grant...' with no
// remedy and no terminal flag, and was retried forever. One invariant, two
// implementations, one of them missing.
//
// The names below are kept because gmail-sensor.js and four test files import
// them; only the home of the logic changed. The BUG-273 C2 precedence fix and
// the BUG-291 publish-first ordering both live in the shared module now.
var {
  isTerminalAuthError,
  googleAuthFailureText,
  googleAuthFailure,
} = require('./google-auth-failure');

function gmailFailureText(prefix, err) { return googleAuthFailureText(prefix, err); }

function gmailFailure(prefix, err) { return googleAuthFailure(prefix, err); }

// A recipient of "me" (or an omitted one) means "the authenticated account".
function isSelfRecipient(to) {
  var t = (to || '').trim();
  return !t || t.toLowerCase() === 'me';
}

// Resolve "me"/empty into a real address via the Gmail profile *before* the
// caller composes anything with it. Never guesses — an unresolvable "me"
// fails with a message naming exactly what's missing, so the model can ask
// the operator instead of forwarding a literal "me" to Gmail (which is what
// produced "Invalid To header" after a full body had already been drafted).
async function resolveRecipient(to, adapter) {
  if (!isSelfRecipient(to)) return { ok: true, address: to.trim() };
  if (_selfEmail) return { ok: true, address: _selfEmail };
  if (!adapter || typeof adapter.getProfile !== 'function') {
    return { ok: false, error: 'Could not resolve "me" to an address — no Gmail profile lookup is available. Specify an explicit recipient email.' };
  }
  var profile;
  try {
    profile = await adapter.getProfile();
  } catch (err) {
    // B5: routed through the same formatter as the four tools. A profile lookup
    // failing with invalid_grant is the SAME dead credential, and this path is
    // reached first on any send/draft addressed to "me" — so leaving it out would
    // have kept the wrong "network outage" diagnosis alive on the most common path.
    return { ok: false, error: gmailFailureText('Could not resolve "me" — the Gmail profile lookup failed', err) };
  }
  var address = profile && profile.emailAddress;
  if (!address) {
    return { ok: false, error: 'Could not resolve "me" — the Gmail profile did not return an email address.' };
  }
  _selfEmail = address;
  return { ok: true, address: address };
}

function buildTools(ctx) {
  var logger = (ctx && ctx.logger) || { warn: function() {} };

  // Lazy-construct adapter on first use so boot doesn't hang on DNS/OAuth if
  // Google creds are misconfigured. Only cache a *ready* adapter — caching the
  // not-ready sentinel would make every call after the first return it as if
  // it were truthy (bypassing the `if (!a)` guard below) and blow up with a
  // cryptic "a.listUnread is not a function" instead of the clean config error.
  function ensureAdapter() {
    if (_adapter && _adapter.ready) return _adapter;
    var { createGoogleAdapter } = require('../../../adapters/google');
    _adapter = createGoogleAdapter({ logger: logger });
    if (!_adapter.ready) return null;
    return _adapter;
  }

  async function gmail_unread(args) {
    try {
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.');
      var max = (args && args.max) ? Math.min(Number(args.max), 20) : 10;
      var msgs = await a.listUnread(max);
      if (!msgs.length) return ok({ count: 0, messages: [] });
      var summary = msgs.slice(0, max).map(function(m) { return { id: m.id, from: m.from, subject: m.subject, snippet: (m.snippet || '').slice(0, 200), date: m.date }; });
      return ok({ count: msgs.length, messages: summary });
    } catch (err) {
      return gmailFailure('Gmail fetch failed', err);
    }
  }

  async function gmail_read(args) {
    try {
      var id = (args && args.id) || '';
      if (!id) return fail('gmail_read requires an email id (from gmail_unread).');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.');
      var msg = await a.readMessage(id);
      var body = msg.bodyHtml || msg.bodyText || '';
      // Cap to avoid blowing the context window
      if (body.length > 4000) body = body.slice(0, 4000) + '... [truncated]';
      return ok({ from: msg.from, to: msg.to, subject: msg.subject, date: msg.date, body: body });
    } catch (err) {
      return gmailFailure('Gmail read failed', err);
    }
  }

  async function gmail_send(args) {
    try {
      var toRaw = (args && args.to) || '';
      var subject = (args && args.subject) || '';
      var body = (args && args.body) || '';
      if (!subject || !body) return fail('gmail_send requires to, subject, and body.');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.');
      var recipient = await resolveRecipient(toRaw, a);
      if (!recipient.ok) return fail(recipient.error);
      var to = recipient.address;
      await a.send({ to: to, subject: subject, body: body, html: args.html || null });
      return ok({ sent: true, to: to, subject: subject });
    } catch (err) {
      return gmailFailure('Gmail send failed', err);
    }
  }

  async function gmail_draft(args) {
    try {
      var to = (args && args.to) || '';
      var subject = (args && args.subject) || '';
      var body = (args && args.body) || '';
      if (!to || !subject || !body) return fail('gmail_draft requires to, subject, and body.');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.');
      await a.draft({ to: to, subject: subject, body: body });
      return ok({ drafted: true, to: to, subject: subject });
    } catch (err) {
      return gmailFailure('Gmail draft failed', err);
    }
  }

  var TOOLS = [
    { name: 'gmail_unread', description: 'List unread emails in the inbox.', params: { max: 'number (optional, default 10)' }, danger: false, fn: gmail_unread, needs_result: true },
    { name: 'gmail_read', description: 'Read a full email by its ID (obtained from gmail_unread).', params: { id: 'string — email message ID' }, danger: false, fn: gmail_read, needs_result: true },
    { name: 'gmail_send', description: 'Send an email. Use only when the operator explicitly asks.', params: { to: 'string — email address, or "me"/omitted for the authenticated account', subject: 'string', body: 'string' }, danger: true, fn: gmail_send },
    { name: 'gmail_draft', description: 'Save an email as a draft without sending.', params: { to: 'string', subject: 'string', body: 'string' }, danger: false, fn: gmail_draft },
  ];

  return TOOLS;
}

function registerFromGmail(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) {
    hub.register(effectorFromTool(tools[i]));
  }
  return { count: tools.length };
}

// gmailFailure is exported for the F1 terminal-classification test — the
// allow-list of terminal signatures is the risky half of that change (a 401 from
// a rate limiter must stay retryable) and needs to be asserted directly, not
// inferred from the tool wiring.
// BUG-273 C2: isTerminalAuthError is exported so gmail-sensor.js can decide
// "re-auth needed" with the SAME narrow test used here, rather than growing a
// second regex that drifts. The narrowness is the point — a rate limit or a
// transient 401 must stay retryable and must not raise a re-auth alarm.
module.exports = { registerFromGmail, buildTools, gmailFailure, isTerminalAuthError };
