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
  process.exit(1);
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

// Open browser
var start = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
var child = require('child_process').spawn(start, [AUTH_URL], { shell: true, stdio: 'ignore' });
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
    console.error('\nAuthorization failed: ' + errParam);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No auth code received.');
    process.exit(1);
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
      try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) {
        console.error('  ✗ Invalid token response');
        process.exit(1);
      }
      if (json.error) {
        console.error('  ✗ Token error: ' + json.error + ' — ' + (json.error_description || ''));
        process.exit(1);
      }
      console.log('\n  ✓ SUCCESS! Add these to your .env:\n');
      console.log('  GOOGLE_CLIENT_ID=' + CLIENT_ID);
      console.log('  GOOGLE_CLIENT_SECRET=' + CLIENT_SECRET);
      console.log('  GOOGLE_REFRESH_TOKEN=' + json.refresh_token);
      console.log();
      server.close();
      process.exit(0);
    });
  });
  tokenReq.on('error', function(err) {
    console.error('  ✗ Token exchange failed: ' + err.message);
    process.exit(1);
  });
  tokenReq.write(body);
  tokenReq.end();
});

server.listen(REDIRECT_PORT, '127.0.0.1', function() {
  console.log('  Waiting for redirect on port ' + REDIRECT_PORT + '...\n');
});
