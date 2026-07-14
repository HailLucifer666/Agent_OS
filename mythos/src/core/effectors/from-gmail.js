'use strict';

// Gmail effector — gmail_unread, gmail_read, gmail_draft, gmail_send tools.
// Google adapter is injected via createGoogleAdapter deps (client ID/secret/refresh).

var effectorFromTool = require('./adapter').effectorFromTool;

var _adapter = null;

function ok(data) { return { ok: true, result: data }; }
function fail(msg) { return { ok: false, result: { error: msg } }; }

function buildTools(ctx) {
  var logger = (ctx && ctx.logger) || { warn: function() {} };

  // Lazy-construct adapter on first use so boot doesn't hang on DNS/OAuth if
  // Google creds are misconfigured.
  function ensureAdapter() {
    if (_adapter) return _adapter;
    var { createGoogleAdapter } = require('../../adapters/google');
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
      var summary = msgs.slice(0, max).map(function(m) { return { from: m.from, subject: m.subject, snippet: (m.snippet || '').slice(0, 200), date: m.date }; });
      return ok({ count: msgs.length, messages: summary });
    } catch (err) {
      return fail('Gmail fetch failed: ' + (err.message || err));
    }
  }

  async function gmail_read(args) {
    try {
      var id = (args && args.id) || '';
      if (!id) return fail('gmail_read requires an email id (from gmail_unread).');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured.');
      var msg = await a.readMessage(id);
      var body = msg.bodyHtml || msg.bodyText || '';
      // Cap to avoid blowing the context window
      if (body.length > 4000) body = body.slice(0, 4000) + '... [truncated]';
      return ok({ from: msg.from, to: msg.to, subject: msg.subject, date: msg.date, body: body });
    } catch (err) {
      return fail('Gmail read failed: ' + (err.message || err));
    }
  }

  async function gmail_send(args) {
    try {
      var to = (args && args.to) || '';
      var subject = (args && args.subject) || '';
      var body = (args && args.body) || '';
      if (!to || !subject || !body) return fail('gmail_send requires to, subject, and body.');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured.');
      await a.send({ to: to, subject: subject, body: body, html: args.html || null });
      return ok({ sent: true, to: to, subject: subject });
    } catch (err) {
      return fail('Gmail send failed: ' + (err.message || err));
    }
  }

  async function gmail_draft(args) {
    try {
      var to = (args && args.to) || '';
      var subject = (args && args.subject) || '';
      var body = (args && args.body) || '';
      if (!to || !subject || !body) return fail('gmail_draft requires to, subject, and body.');
      var a = ensureAdapter();
      if (!a) return fail('Gmail is not configured.');
      await a.draft({ to: to, subject: subject, body: body });
      return ok({ drafted: true, to: to, subject: subject });
    } catch (err) {
      return fail('Gmail draft failed: ' + (err.message || err));
    }
  }

  var TOOLS = [
    { name: 'gmail_unread', description: 'List unread emails in the inbox.', params: { max: 'number (optional, default 10)' }, danger: false, fn: gmail_unread },
    { name: 'gmail_read', description: 'Read a full email by its ID (obtained from gmail_unread).', params: { id: 'string — email message ID' }, danger: false, fn: gmail_read },
    { name: 'gmail_send', description: 'Send an email. Use only when the operator explicitly asks.', params: { to: 'string', subject: 'string', body: 'string' }, danger: true, fn: gmail_send },
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

module.exports = { registerFromGmail, buildTools };
