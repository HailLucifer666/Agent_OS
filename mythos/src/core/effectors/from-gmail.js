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
// F1 (2026-08-15): the message B5 added was right and still got retried forever,
// because saying "do not retry" in prose does not stop the circuit breaker. This
// is the machine-readable half of the same fact — see hub.js's isTerminalResult.
// Deliberately narrow: only the two OAuth grant signatures, never a blanket
// 4xx rule, so a rate limit or a transient 401 stays retryable.
// BUG-273 C2 — PRECEDENCE BUG, found while exporting this for gmail-sensor.js. It
// used to read `!!(err && (err.isAuthError || RE.test(reason)))`, so the leading
// `err &&` short-circuited the WHOLE expression and the reason-regex fallback could
// never fire without an error object. The comment above calls the regex the fallback
// for exactly the case where there is no flag to read, which is the case it could not
// serve. Every caller inside this file happens to pass a truthy `err`, so the bug was
// latent — but the sensor reaching for the same helper is precisely a caller that may
// have only a string, and a dead fallback there would silently stop announcing a
// revoked token.
function isTerminalAuthError(err, reason) {
  return !!((err && err.isAuthError) || /invalid_grant|unauthorized_client/.test(String(reason)));
}

function gmailFailureText(prefix, err) {
  var reason = reasonText(err);
  if (isTerminalAuthError(err, reason)) {
    // BUG-291 (2026-08-21): everything below the first line is new, and it is
    // here because the message above was ALREADY correct and still cost the same
    // session twice. Following it exactly — run the script, paste the token —
    // reproduces the fault a week later, so the remedy was a loop with no exit
    // written into it.
    //
    // From Google's OAuth documentation: a project whose consent screen is
    // external user type with publishing status 'Testing' is issued refresh
    // tokens that EXPIRE IN 7 DAYS. This project requests gmail.readonly,
    // gmail.compose, gmail.send and calendar.readonly, so it is squarely in that
    // rule. That is a fact about the deployment, recoverable from no amount of
    // reading this code, which is exactly why it belongs in the failure string
    // rather than in a session transcript that the next reader will not have.
    //
    // The ORDER is the load-bearing part: publish first, THEN re-authorise. Doing
    // it the other way round mints another 7-day token and files this incident
    // again. Publishing unverified is fine for a single operator — it costs an
    // "unverified app" interstitial and a 100-user lifetime cap on the project.
    return prefix + ': ' + reason
      + ' — this is NOT a network problem and will not recover on its own: the Google refresh token is '
      + 'expired or revoked. Tell the operator it needs re-authorising by running '
      + '`node scripts/google-auth.js` and putting the new GOOGLE_REFRESH_TOKEN in mythos/.env. '
      + 'If this recurs roughly every 7 days, re-authorising alone will NOT fix it: an OAuth consent '
      + 'screen with external user type and publishing status "Testing" is issued refresh tokens that '
      + 'expire in 7 days. Publish the app first (Google Cloud Console -> APIs & Services -> OAuth '
      + 'consent screen -> Publish app), and only then re-authorise, or the new token expires the same '
      + 'way. Do not retry.';
  }
  return prefix + ': ' + reason;
}

function gmailFailure(prefix, err) {
  var out = fail(gmailFailureText(prefix, err));
  // `terminal` travels BESIDE ok/result, never folded into either — the evidence
  // contract in src/core/CLAUDE.md has been flattened before and it cost a
  // ui_type action being audited as delivered.
  if (isTerminalAuthError(err, reasonText(err))) out.terminal = true;
  return out;
}

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
