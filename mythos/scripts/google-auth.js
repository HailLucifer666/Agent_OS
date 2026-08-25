#!/usr/bin/env node
'use strict';

// One-time Google OAuth setup: opens browser for user consent, exchanges auth
// code for refresh_token, prints it to stdout. Copy into .env as GOOGLE_REFRESH_TOKEN.
//
// Prerequisites:
//   1. Create OAuth 2.0 credentials in Google Cloud Console
//      (https://console.cloud.google.com/apis/credentials)
//      → Create "Desktop app" (not web app) → get Client ID + Client Secret
//   2. Enable Gmail API in APIs & Services
//
// Usage:
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/google-auth.js

var http = require('http');
var https = require('https');

var CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
var CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.');
  console.error('  GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx node scripts/google-auth.js');
  // No server is listening yet, so nothing holds the loop open — setting the code
  // is enough, and it flushes both lines above (see bail()).
  process.exitCode = 1;
  return;
}

// B5 DEFECT 2, fixed 2026-08-14 (also recorded 2026-08-05 and left unfixed).
//
// Every failure path was `console.error(...)` immediately followed by
// `process.exit(1)`. On Windows, stdout/stderr to a pipe is ASYNCHRONOUS, so
// process.exit() tears the process down before the write flushes and the operator
// sees a silent exit code 1 with no message — which is why the real Google error
// was never visible and had to be re-derived by hand.
//
// process.exitCode records the failure and lets the event loop drain naturally.
// Closing the listener is what allows it to drain at all: an open server keeps the
// loop alive forever, so "set exitCode instead of exiting" only works when the one
// handle holding the process open is released too.
function bail(message) {
  console.error('\n  ✗ ' + message + '\n');
  process.exitCode = 1;
  try { if (server && server.listening) server.close(); } catch (_) { /* already closed */ }
}

var REDIRECT_PORT = 4848;
// Phase 3 (BUG-024): added the Calendar readonly scope. Without it the
// refresh token this script mints works for Gmail tools but fails on real
// Calendar reads (the reminder-sensor polls calendar.fireDueReminders()).
// See docs/google-oauth-setup.md for the full operator walkthrough.
var SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly'
].join(' ');

var AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?' +
  'response_type=code' +
  '&client_id=' + encodeURIComponent(CLIENT_ID) +
  '&redirect_uri=' + encodeURIComponent('http://localhost:' + REDIRECT_PORT) +
  '&scope=' + encodeURIComponent(SCOPES) +
  '&access_type=offline' +
  '&prompt=consent';

console.log('\n=== MYTHOS Google OAuth Setup ===\n');
console.log('Opening browser for Google sign-in...');
console.log('If browser does not open, visit:\n  ' + AUTH_URL + '\n');

// B5 DEFECT 1, fixed 2026-08-14 (recorded 2026-08-05, worked around out-of-repo
// and left unfixed — so this re-auth would have paid the same cost a second time).
//
// `spawn('start', [url], { shell: true })` hands the URL to cmd.exe, which treats
// every `&` as a command separator. The consent URL has five of them, so cmd ran
// `start https://...?response_type=code` and then tried to execute
// `client_id=...` as a command. Google received a URL with only the first
// parameter and answered `400: Missing required parameter: redirect_uri`, which
// looks like a credentials problem and is not.
//
// The fix is to stop involving a shell at all, so the URL stays one argv element.
// rundll32's FileProtocolHandler is the shell-free way to hand a URL to the
// default browser on Windows; `open`/`xdg-open` already take one directly.
var opener = process.platform === 'win32'
  ? { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', AUTH_URL] }
  : { cmd: process.platform === 'darwin' ? 'open' : 'xdg-open', args: [AUTH_URL] };
var child = require('child_process').spawn(opener.cmd, opener.args, { shell: false, stdio: 'ignore' });
child.on('error', function() {
  // Browser launch failed — user must open URL manually (already printed above)
});

// Listen for redirect callback
var server = http.createServer(function(req, res) {
  var url = new URL(req.url || '/', 'http://localhost:' + REDIRECT_PORT);
  var code = url.searchParams.get('code');
  var errParam = url.searchParams.get('error');

  if (errParam) {
    res.writeHead(400);
    res.end('Authorization failed: ' + errParam);
    return bail('Authorization failed: ' + errParam);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No auth code received.');
    return bail('No auth code received from Google.');
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Authorization successful!</h1><p>You can close this window.</p>');
  console.log('  ✓ Auth code received, exchanging for tokens...');

  // Exchange code for tokens
  var body = 'code=' + encodeURIComponent(code) +
    '&client_id=' + encodeURIComponent(CLIENT_ID) +
    '&client_secret=' + encodeURIComponent(CLIENT_SECRET) +
    '&redirect_uri=' + encodeURIComponent('http://localhost:' + REDIRECT_PORT) +
    '&grant_type=authorization_code';

  var tokenReq = https.request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, function(tokenRes) {
    var chunks = [];
    tokenRes.on('data', function(c) { chunks.push(c); });
    tokenRes.on('end', function() {
      var json;
      var raw = Buffer.concat(chunks).toString();
      try { json = JSON.parse(raw); } catch (e) {
        return bail('Invalid token response (HTTP ' + tokenRes.statusCode + '): ' + raw.slice(0, 300));
      }
      if (json.error) {
        return bail('Token error: ' + json.error
          + (json.error_description ? ' — ' + json.error_description : ' (Google returned no description)'));
      }
      if (!json.refresh_token) {
        // Google omits refresh_token when the account has already granted this
        // client and it is reusing the existing grant. Printing
        // "GOOGLE_REFRESH_TOKEN=undefined" as a success was the old behaviour.
        return bail('Google returned no refresh_token. That happens when this client already holds a '
          + 'grant for the account: revoke MYTHOS at https://myaccount.google.com/permissions, then run '
          + 'this again.');
      }
      console.log('\n  ✓ SUCCESS! Add these to your .env:\n');
      console.log('  GOOGLE_CLIENT_ID=' + CLIENT_ID);
      console.log('  GOOGLE_CLIENT_SECRET=' + CLIENT_SECRET);
      console.log('  GOOGLE_REFRESH_TOKEN=' + json.refresh_token);
      console.log();
      // Same reason as bail(): close the listener so the event loop can drain and
      // let the process end on its own, instead of exiting on top of a pending
      // stdout write. This is the path that prints the refresh token, so a
      // truncated flush here hands the operator half a credential.
      server.close();
    });
  });
  tokenReq.on('error', function(err) {
    bail('Token exchange failed: ' + (err && err.message ? err.message : 'no reason given'));
  });
  tokenReq.write(body);
  tokenReq.end();
});

server.listen(REDIRECT_PORT, '127.0.0.1', function() {
  console.log('  Waiting for redirect on port ' + REDIRECT_PORT + '...\n');
});
