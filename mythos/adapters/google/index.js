'use strict';

// Google OAuth adapter — refresh-token exchange for Gmail API access.
// Requires a one-time setup via scripts/google-auth.js to mint refresh_token.
// Then this module keeps tokens fresh via client_credentials refresh.

var https = require('https');

var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
// §7.6 — Calendar read layer. scripts/google-auth.js has requested
// 'calendar.readonly' alongside the Gmail scopes since BUG-024 (see that
// script's SCOPES comment), so any refresh token minted after that fix
// already carries it — this is genuinely "scope, not new auth" against the
// existing adapter, not a new OAuth consent flow.
var CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

var _tokenCache = null;
var _refreshTimer = null;

/**
 * Create the Google adapter.
 * @param {{ clientId, clientSecret, refreshToken, logger }} opts
 */
function createGoogleAdapter(opts) {
  var clientId = opts.clientId || process.env.GOOGLE_CLIENT_ID || '';
  var clientSecret = opts.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
  var refreshToken = opts.refreshToken || process.env.GOOGLE_REFRESH_TOKEN || '';
  var logger = opts.logger || { info: function() {}, warn: function() {}, error: function() {} };

  if (!clientId || !clientSecret || !refreshToken) {
    return { ready: false, error: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set.' };
  }

  function refreshAccessToken() {
    return new Promise(function(resolve, reject) {
      var body = 'client_id=' + encodeURIComponent(clientId) +
        '&client_secret=' + encodeURIComponent(clientSecret) +
        '&refresh_token=' + encodeURIComponent(refreshToken) +
        '&grant_type=refresh_token';
      var opts2 = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      };
      var req = https.request(TOKEN_URL, opts2, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          var json;
          try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { return reject(new Error('Invalid token response: ' + chunks.join(''))); }
          if (!json.access_token) return reject(new Error(json.error || 'No access_token in response'));
          _tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
          // Schedule proactive refresh at 80% of lifetime
          if (_refreshTimer) clearTimeout(_refreshTimer);
          var ttl = Math.max(10, Math.floor((json.expires_in || 3600) * 0.8));
          _refreshTimer = setTimeout(function() {
            refreshAccessToken().catch(function(err) { logger.warn('google.token.refresh.fail', { error: err.message }); });
          }, ttl * 1000);
          resolve(_tokenCache.token);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  function getToken() {
    if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30000) {
      return Promise.resolve(_tokenCache.token);
    }
    return refreshAccessToken();
  }

  // Shared request helper, parameterized on base URL — gmailRequest() below is
  // now a thin wrapper so every existing Gmail call site is untouched.
  function apiRequest(base, path, method, body) {
    return getToken().then(function(token) {
      return new Promise(function(resolve, reject) {
        var url = base + path;
        var opts2 = { method: method || 'GET', headers: { 'Authorization': 'Bearer ' + token } };
        if (body) {
          opts2.headers['Content-Type'] = 'application/json';
          body = JSON.stringify(body);
          opts2.headers['Content-Length'] = Buffer.byteLength(body);
        }
        var req = https.request(url, opts2, function(res) {
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() {
            var json;
            try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { return reject(new Error('Invalid response from ' + base)); }
            if (json.error) return reject(new Error(json.error.message || JSON.stringify(json.error)));
            resolve(json);
          });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    });
  }

  function gmailRequest(path, method, body) {
    return apiRequest(GMAIL_BASE, path, method, body);
  }

  function calendarRequest(path, method, body) {
    return apiRequest(CALENDAR_BASE, path, method, body);
  }

  // Public API
  return {
    ready: true,
    /**
     * List unread messages. Returns array of { id, from, subject, snippet, date }.
     */
    listUnread: function(max) {
      return gmailRequest('/messages?maxResults=' + (max || 10) + '&q=is:unread', 'GET').then(function(data) {
        var ids = (data.messages || []).map(function(m) { return m.id; });
        if (!ids.length) return [];
        // Fetch metadata for each in parallel (max 5 at a time to avoid burst)
        var results = new Array(ids.length);
        var idx = 0;
        function batch() {
          var slice = ids.slice(idx, idx + 5);
          idx += slice.length;
          return Promise.all(slice.map(function(id) {
            return gmailRequest('/messages/' + id + '?format=metadata&metadataFields=From,Subject,Date,snippet', 'GET');
          })).then(function(msgs) {
            msgs.forEach(function(m, i) { results[ids.indexOf(slice[i])] = m; });
            if (idx < ids.length) return batch();
            return results.map(function(m) { return m ? { id: m.id, from: (m.payload && m.payload.headers && _h(m.payload.headers, 'From')) || '', subject: (m.payload && m.payload.headers && _h(m.payload.headers, 'Subject')) || '', snippet: m.snippet || '', date: (m.payload && m.payload.headers && _h(m.payload.headers, 'Date')) || '' } : null; }).filter(Boolean);
          });
        }
        return batch();
      });
    },
    /**
     * Read a full message by ID. Returns { from, to, subject, date, bodyText, bodyHtml }.
     */
    readMessage: function(id) {
      return gmailRequest('/messages/' + id + '?format=full', 'GET').then(function(m) {
        var headers = m.payload && m.payload.headers || [];
        var parts = _flattenParts(m.payload);
        var textPart = parts.find(function(p) { return p.mimeType === 'text/plain'; });
        var htmlPart = parts.find(function(p) { return p.mimeType === 'text/html'; });
        return { id: m.id, from: _h(headers, 'From'), to: _h(headers, 'To'), subject: _h(headers, 'Subject'), date: _h(headers, 'Date'), bodyText: _decode(textPart), bodyHtml: _decode(htmlPart) };
      });
    },
    /**
     * Send an email. { to, subject, body, html (optional) }.
     */
    send: function(msg) {
      var raw = 'To: ' + (msg.to || '') + '\r\nSubject: ' + (msg.subject || '') + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + (msg.body || '');
      if (msg.html) raw = 'To: ' + (msg.to || '') + '\r\nSubject: ' + (msg.subject || '') + '\r\nContent-Type: text/html; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n' + msg.html;
      return gmailRequest('/messages/send', 'POST', { raw: Buffer.from(raw).toString('base64') });
    },
    /**
     * Create a draft. Same params as send().
     */
    draft: function(msg) {
      var raw = 'To: ' + (msg.to || '') + '\r\nSubject: ' + (msg.subject || '') + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + (msg.body || '');
      return gmailRequest('/drafts', 'POST', { message: { raw: Buffer.from(raw).toString('base64') } });
    },
    /**
     * §7.6 — List upcoming events on the primary calendar, soonest first.
     * Returns array of { id, title, start, end, location }. Read-only
     * (calendar.readonly scope) — never creates/modifies events.
     */
    listUpcomingEvents: function(maxResults) {
      var timeMin = encodeURIComponent(new Date().toISOString());
      var qs = '/calendars/primary/events?timeMin=' + timeMin +
        '&maxResults=' + (maxResults || 10) +
        '&singleEvents=true&orderBy=startTime';
      return calendarRequest(qs, 'GET').then(function(data) {
        var items = data.items || [];
        return items.map(function(ev) {
          return {
            id: ev.id,
            title: ev.summary || '(no title)',
            start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
            end: (ev.end && (ev.end.dateTime || ev.end.date)) || null,
            location: ev.location || null,
          };
        });
      });
    },
  };
}

function _h(headers, name) {
  var h = headers.find(function(x) { return x.name === name; });
  return h ? h.value : '';
}

function _flattenParts(payload) {
  if (!payload || !payload.parts) return [payload];
  var out = [];
  payload.parts.forEach(function(p) {
    if (p.parts && p.parts.length) {
      out = out.concat(_flattenParts(p));
    } else {
      out.push(p);
    }
  });
  return out;
}

function _decode(part) {
  if (!part || !part.body || !part.body.data) return '';
  try { return Buffer.from(part.body.data, 'base64').toString('utf-8'); } catch (e) { return ''; }
}

module.exports = { createGoogleAdapter };
