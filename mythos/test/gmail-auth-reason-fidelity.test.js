'use strict';

// gmail-auth-reason-fidelity.test.js — B5 of the 2026-08-14 session repair.
//
// MEASURED: 11 Gmail failures across the day (00:36 -> 17:27). Ten said
// `invalid_grant`. The one at 12:29:39 said "Gmail fetch failed: " — nothing after
// the colon. And MYTHOS told the operator "Network request failed... Google APIs
// appear unreachable" and filed an incident saying so, which is a wrong diagnosis
// on the permanent record.
//
// THREE PARTS, and only two of them are code:
//   1. The token is expired or revoked. `invalid_grant` from Google's token
//      endpoint is not a network condition and no code change can fix it — it
//      needs the operator's browser consent to re-mint. Not testable here.
//   2. The actionable half of the error was discarded. Google returns
//      error_description ("Token has been expired or revoked.") next to
//      error ("invalid_grant"); adapters/google/index.js read only the latter.
//   3. An empty failure reason was reachable at all.
//
// Part 3 is the THIRD instance of "a failure path that discards its reason"
// (BUG-101 was the first, scripts/google-auth.js the second), so it is fixed at
// the shared helper with a class-level assertion rather than patched a third time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { reasonText } = require('../src/core/util/reason-text');

describe('B5.3 no failure message may trail off after a colon', () => {
  it('an Error with an empty message no longer renders as nothing', () => {
    // The literal 12:29:39 record: "Gmail fetch failed: " with nothing after it.
    // The cause is that `typeof err.message === 'string'` is TRUE for '' and the
    // helper returned it as-is.
    const out = reasonText(new Error(''));
    assert.ok(out.trim().length > 0,
      'the operator was told a tool failed and given no reason at all, which is worse than a bad '
      + 'reason — there is nothing to act on or even to search for');
    assert.match(out, /no message/i);
  });

  it('a named error type says which type it was', () => {
    const err = new Error('');
    err.name = 'AbortError';
    assert.match(reasonText(err), /AbortError/);
  });

  it('an empty object and an empty array both describe themselves', () => {
    assert.match(reasonText({}), /empty object/);
    assert.match(reasonText([]), /empty array/);   // '[]' tells nobody anything either
  });

  it('a whitespace-only string is treated as empty', () => {
    assert.ok(reasonText('   ').trim().length > 0);
  });

  it('null and undefined still map to the empty string, because that means "nothing was passed"', () => {
    // Callers concatenate this into their own sentence, and dispatch-action.js
    // passes `result && result.result` which is legitimately undefined.
    assert.equal(reasonText(null), '');
    assert.equal(reasonText(undefined), '');
  });

  it('every real reason is passed through untouched', () => {
    assert.equal(reasonText('invalid_grant'), 'invalid_grant');
    assert.equal(reasonText(new Error('boom')), 'boom');
    assert.equal(reasonText({ error: 'nope' }), 'nope');
    assert.equal(reasonText({ message: 'hmm' }), 'hmm');
    assert.equal(reasonText({ a: 1 }), '{"a":1}', 'a real object still dumps rather than being hidden');
  });
});

describe('B5.2 the actionable half of a Google auth error survives', () => {
  it('error_description is included in the rejection', async () => {
    // Drives the real refreshAccessToken path with a stubbed https, so the parse
    // and reject shape are the production ones.
    const httpsPath = require.resolve('https');
    const ADAPTER = require.resolve('../../mythos/adapters/google');
    const savedHttps = require.cache[httpsPath];

    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    });
    require.cache[httpsPath] = {
      id: httpsPath, filename: httpsPath, loaded: true,
      exports: {
        request(_url, _opts, cb) {
          const res = { statusCode: 400, on(evt, h) { if (evt === 'data') h(Buffer.from(body)); if (evt === 'end') h(); } };
          setImmediate(() => cb(res));
          return { on() {}, write() {}, end() {} };
        },
      },
    };
    delete require.cache[ADAPTER];

    const prev = {
      id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, tok: process.env.GOOGLE_REFRESH_TOKEN,
    };
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    process.env.GOOGLE_REFRESH_TOKEN = 'rtok';
    try {
      const { createGoogleAdapter } = require('../../mythos/adapters/google');
      const a = createGoogleAdapter({ logger: { warn() {}, info() {} } });
      assert.equal(a.ready, true);
      // Driven through the public surface: listUnread -> gmailRequest -> getToken ->
      // refreshAccessToken, so the production path is what rejects.
      await assert.rejects(() => a.listUnread(1), (err) => {
        assert.match(err.message, /invalid_grant/, 'the code must survive');
        assert.match(err.message, /expired or revoked/,
          'and so must the description — it is the only part that tells a human what to DO, and it '
          + 'was the missing half behind an incident filed as a network outage');
        assert.equal(err.isAuthError, true, 'flagged so callers need not match on message text');
        assert.equal(err.googleError, 'invalid_grant');
        return true;
      });
    } finally {
      if (savedHttps) require.cache[httpsPath] = savedHttps; else delete require.cache[httpsPath];
      delete require.cache[ADAPTER];
      if (prev.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prev.id;
      if (prev.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prev.secret;
      if (prev.tok === undefined) delete process.env.GOOGLE_REFRESH_TOKEN; else process.env.GOOGLE_REFRESH_TOKEN = prev.tok;
    }
  });

  it('the adapter never logs the refresh token itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'google', 'index.js'), 'utf8');
    assert.doesNotMatch(src, /logger\.(warn|info|error)\([^)]*refreshToken/,
      'error_description is Google\'s own operational text and carries no token material — that is '
      + 'why surfacing it is safe. The credential itself must stay out of the logs.');
  });
});

describe('B5 a dead credential is not reported as a network outage', () => {
  it('an invalid_grant failure names re-authorisation and says not to retry', () => {
    // The wrong diagnosis was spoken aloud AND filed as an incident. The failure
    // text is what the model narrates from, so the remedy belongs in it — the same
    // remedy-on-failure reasoning as Wave A's browser disambiguation.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-gmail.js'), 'utf8');
    const m = src.match(/function gmailFailure[\s\S]{0,1200}?\n\}/);
    assert.ok(m, 'the shared gmail failure formatter must exist');
    const fn = m[0];
    assert.match(fn, /isAuthError/, 'match on the adapter\'s flag, not on message text');
    assert.match(fn, /NOT a network problem/i,
      'MYTHOS said "Google APIs appear unreachable" for a token the endpoint had just rejected');
    assert.match(fn, /google-auth\.js/, 'and it must name the script that fixes it');
    assert.match(fn, /Do not retry/i, 'a revoked token does not recover on its own');

    // All four tools must route through it — a per-tool patch is how the first two
    // instances of this class were missed.
    for (const label of ['Gmail fetch failed', 'Gmail read failed', 'Gmail send failed', 'Gmail draft failed']) {
      assert.match(src, new RegExp("gmailFailure\\('" + label + "'"), label + ' must use the shared formatter');
    }
    assert.equal((src.match(/failed: ' \+ reasonText\(err\)/g) || []).length, 0,
      'no tool may still format its own failure and skip the auth diagnosis');
  });
});

describe('B5 scripts/google-auth.js: both recorded Windows defects are fixed', () => {
  // Comments stripped before scanning: this file's own explanatory comments QUOTE the
  // old broken code ("shell: true", "process.exit(1)"), so a raw scan would match the
  // description of the bug rather than the bug.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'google-auth.js'), 'utf8');
  const src = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('the consent URL is not handed to a shell, so & no longer splits it', () => {
    // Recorded 2026-08-05, worked around out-of-repo, left unfixed — so this
    // re-auth would have paid the same cost a second time. cmd.exe treats each of
    // the URL's five `&` as a command separator, so Google received only
    // response_type=code and answered "400: Missing required parameter:
    // redirect_uri", which reads as a credentials problem and is not one.
    assert.doesNotMatch(src, /shell:\s*true/,
      'any shell at all re-opens this: the URL must stay a single argv element');
    assert.match(src, /shell:\s*false/);
    assert.match(src, /FileProtocolHandler/,
      'the shell-free way to hand a URL to the default browser on Windows');
  });

  it('no failure path exits before stdout has flushed', () => {
    // On Windows a pipe write is async, so console.error + process.exit(1) loses
    // the message entirely — which is why the real Google error was never visible.
    assert.doesNotMatch(src, /process\.exit\(/,
      'process.exitCode records the failure and lets the loop drain; process.exit() truncates it');
    assert.match(src, /process\.exitCode\s*=\s*1/);
    assert.match(src, /function bail\(/, 'one place that does it, so a new path cannot get it wrong');
    const bail = src.slice(src.indexOf('function bail('), src.indexOf('var REDIRECT_PORT'));
    assert.match(bail, /server\.close\(\)/,
      'an open listener keeps the loop alive forever, so "set exitCode" only works if the handle is released');
  });

  it('the success path does not exit on top of a pending write either', () => {
    // This is the path that prints the refresh token. A truncated flush here hands
    // the operator half a credential.
    const tail = src.slice(src.indexOf('GOOGLE_REFRESH_TOKEN='));
    assert.doesNotMatch(tail, /process\.exit\(0\)/);
    assert.match(tail, /server\.close\(\)/);
  });

  it('a response with no refresh_token fails instead of printing "undefined"', () => {
    assert.match(src, /no refresh_token/i,
      'Google omits it when the client already holds a grant; printing '
      + 'GOOGLE_REFRESH_TOKEN=undefined as a success is how an operator ends up with a broken .env');
    assert.match(src, /myaccount\.google\.com\/permissions/, 'and it must name the fix');
  });

  it('it still parses and still refuses to run without credentials', () => {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, ['--check', path.join(__dirname, '..', 'scripts', 'google-auth.js')]);
    let code = 0;
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'google-auth.js')], {
        env: Object.assign({}, process.env, { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
        stdio: 'pipe',
      });
    } catch (err) {
      code = err.status;
      assert.match(String(err.stderr), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required/,
        'and the message must actually reach stderr — that is the whole defect');
    }
    assert.equal(code, 1, 'exitCode must still signal failure to a caller/CI');
  });
});
