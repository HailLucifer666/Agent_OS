'use strict';

// test/bug-317-signed-artifact-url.test.js — BUG-317.
//
// THE BUG, AND IT IS TOCTOU IN ITS PUREST FORM: the process that CHECKS is not
// the process that USES. from-dashboard.js's open_artifact preflighted the
// artifact URL with `Authorization: Bearer ${MYTHOS_AUTH_TOKEN}` and, on a 200,
// reported opened:true. The OS browser then requested that same URL with no
// header at all, and /vault/builds sits behind requireToken — so it 401'd.
//
// WHY NOT HYPOTHETICAL. 2026-08-22, 13:04:43, the operator's own words: "It says
// error unauthorized set mythos auth token via authorized bearer token." The
// audit records open_artifact returning ok:true twice for that file, MYTHOS
// misattributing the 401 to Gmail reauth, and then retracting at 13:05:10.
//
// The comment directly above that preflight says it exists because "configuring
// a token silently made every artifact unopenable". So the previous fix made the
// CHECK pass rather than making the OPEN work — the check was simply asking a
// question the browser would never ask.
//
// THE FIX. Mint a short-lived signed query token onto the artifact URL, so the
// URL handed to the browser is one the browser can actually load, and preflight
// THAT url. The thing checked becomes the thing used.
//
// SECURITY PROPERTIES THIS FILE PINS, because this is new authenticated surface:
//   - HMAC keyed on MYTHOS_AUTH_TOKEN — no new secret to manage or leak.
//   - expiry is checked BEFORE the signature is trusted for anything.
//   - scoped to one exact path: a token for a.html cannot open b.html.
//   - no traversal: '..' anywhere in the path is refused outright.
//   - constant-time comparison.
//   - IT DOES NOT BYPASS THE PIN LAYER. When PIN_SESSION_ENFORCE is on, both
//     layers are required, and a signed URL substitutes for the bearer token
//     only — never for the PIN session. A signature that skipped both would be a
//     real downgrade dressed as a convenience.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  signArtifactPath,
  verifyArtifactSignature,
  createArtifactAccess,
} = require('../src/core/effectors/artifact-token');

const SECRET = 'test-secret-value-not-a-real-token';
const REL = 'builds/pipeline/ai-news-landing-page.html';

function fakeReq(pathname, query, headers) {
  return { path: pathname, query: query || {}, headers: headers || {}, get(h) { return this.headers[String(h).toLowerCase()]; } };
}

function fakeRes() {
  const r = { statusCode: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

describe('BUG-317 — signing and verifying an artifact path', () => {
  test('a freshly signed path verifies', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    assert.ok(t && t.exp && t.sig, 'expected {exp, sig}');
    assert.strictEqual(verifyArtifactSignature(REL, t.exp, t.sig, SECRET).ok, true);
  });

  test('an expired token is refused, and the reason says so', () => {
    const t = signArtifactPath(REL, SECRET, -1000); // already expired
    const v = verifyArtifactSignature(REL, t.exp, t.sig, SECRET);
    assert.strictEqual(v.ok, false);
    assert.match(String(v.reason), /expired/i);
  });

  test('expiry is checked before the signature is trusted', () => {
    // An expired token with a GARBAGE signature must report expiry, not a
    // signature mismatch — the order matters, because a caller that trusts a
    // signature first has already used an unvalidated value.
    const t = signArtifactPath(REL, SECRET, -1000);
    const v = verifyArtifactSignature(REL, t.exp, 'deadbeef', SECRET);
    assert.strictEqual(v.ok, false);
    assert.match(String(v.reason), /expired/i);
  });

  test('a token for one artifact does not open another', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    const other = 'builds/pipeline/some-other-page.html';
    assert.strictEqual(verifyArtifactSignature(other, t.exp, t.sig, SECRET).ok, false);
  });

  test('tampering with the path or the expiry invalidates it', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    assert.strictEqual(verifyArtifactSignature(REL, t.exp + 600000, t.sig, SECRET).ok, false);
    assert.strictEqual(verifyArtifactSignature(REL + 'x', t.exp, t.sig, SECRET).ok, false);
  });

  test('a different secret cannot verify', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    assert.strictEqual(verifyArtifactSignature(REL, t.exp, t.sig, 'other-secret').ok, false);
  });

  test('traversal is refused outright, signed or not', () => {
    // Belt and braces: express.static normalises, but the signature check must
    // not be the place that lets a '..' through on its way there.
    assert.strictEqual(signArtifactPath('builds/../../.env', SECRET, 300000), null);
    const t = signArtifactPath(REL, SECRET, 300000);
    assert.strictEqual(verifyArtifactSignature('builds/../../.env', t.exp, t.sig, SECRET).ok, false);
  });

  test('no secret means no signature — never an unsigned pass', () => {
    assert.strictEqual(signArtifactPath(REL, '', 300000), null);
    assert.strictEqual(signArtifactPath(REL, null, 300000), null);
    assert.strictEqual(verifyArtifactSignature(REL, Date.now() + 1000, 'x', '').ok, false);
  });

  test('a missing signature or expiry is refused, not treated as absent-therefore-fine', () => {
    assert.strictEqual(verifyArtifactSignature(REL, null, null, SECRET).ok, false);
    assert.strictEqual(verifyArtifactSignature(REL, undefined, undefined, SECRET).ok, false);
  });
});

describe('BUG-317 — vaultUrl signs only when asked, and both browser callers ask', () => {
  const { vaultUrl } = require('../src/core/effectors/vault-url');
  const nodeFsForSrc = require('fs');
  const srcPath = require('path').join(__dirname, '..', 'src', 'core', 'effectors');

  test('unsigned by default — nothing that used a plain URL changes', () => {
    const u = vaultUrl(REL, { MYTHOS_AUTH_TOKEN: SECRET, MYTHOS_PORT: 4478 });
    assert.ok(u.indexOf('?') === -1, 'default must stay byte-identical: ' + u);
  });

  test('signed on request, and the signature verifies for that exact path', () => {
    const u = vaultUrl(REL, { MYTHOS_AUTH_TOKEN: SECRET, MYTHOS_PORT: 4478 }, { sign: true });
    const q = new URL(u).searchParams;
    assert.ok(q.get('sig') && q.get('exp'), 'expected exp and sig: ' + u);
    assert.strictEqual(verifyArtifactSignature(REL, q.get('exp'), q.get('sig'), SECRET).ok, true);
  });

  test('no token configured means no query string, not a broken one', () => {
    const u = vaultUrl(REL, { MYTHOS_PORT: 4478 }, { sign: true });
    assert.ok(u.indexOf('?') === -1, u);
  });

  // BOTH callers that hand a vault URL to a browser must sign. open_artifact was
  // the reported defect; browser_navigate resolves through the same mapping and
  // drives a real Chrome over CDP, so it had the identical bug and no report.
  // Asserted on source because the alternative is a live browser in the suite.
  for (const f of ['from-dashboard.js', 'from-browser.js']) {
    test(`${f} asks for a signed URL`, () => {
      const src = nodeFsForSrc.readFileSync(require('path').join(srcPath, f), 'utf8');
      assert.match(src, /vaultUrl\([^)]*\{\s*sign:\s*true\s*\}/,
        f + ' builds a vault URL for a browser without signing it');
    });
  }

  test('open_artifact no longer preflights with an Authorization header', () => {
    // The header was the defect: it made the CHECK pass while the browser's own
    // header-less request 401'd.
    const src = nodeFsForSrc.readFileSync(require('path').join(srcPath, 'from-dashboard.js'), 'utf8');
    const preflight = (src.match(/method: 'HEAD'[\s\S]{0,160}/) || [''])[0];
    assert.ok(preflight.indexOf('Authorization') === -1 && preflight.indexOf('headers') === -1,
      'the preflight must ask exactly what the browser will ask: ' + preflight);
  });
});

describe('BUG-317 — the /vault/builds middleware', () => {
  function accessWith(opts) {
    const o = opts || {};
    return createArtifactAccess({
      secret: o.secret === undefined ? SECRET : o.secret,
      // Stands in for requireToken: called only when the signature route did not
      // already authorise the request.
      requireToken: (req, res, next) => { res.status(401).json({ error: 'Unauthorized' }); },
      pinSessionRequired: () => !!o.pinRequired,
      pinSessionValid: () => !!o.pinValid,
    });
  }

  test('a valid signature admits the request without any header', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: String(t.exp), sig: t.sig });
    const res = fakeRes();
    let nexted = false;
    accessWith()(req, res, () => { nexted = true; });
    assert.strictEqual(nexted, true, 'a signed request must not be sent to requireToken');
    assert.strictEqual(res.statusCode, null);
  });

  test('no signature falls through to the existing token check', () => {
    const req = fakeReq('/pipeline/ai-news-landing-page.html', {});
    const res = fakeRes();
    accessWith()(req, res, () => { throw new Error('should not have been admitted'); });
    assert.strictEqual(res.statusCode, 401, 'unsigned requests must still need a token');
  });

  test('an expired signature falls through to the token check, it does not admit', () => {
    const t = signArtifactPath(REL, SECRET, -1000);
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: String(t.exp), sig: t.sig });
    const res = fakeRes();
    accessWith()(req, res, () => { throw new Error('an expired signature admitted a request'); });
    assert.strictEqual(res.statusCode, 401);
  });

  test('THE PIN LAYER IS NOT BYPASSED: signature alone is not enough when PIN is enforced', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: String(t.exp), sig: t.sig });
    const res = fakeRes();
    accessWith({ pinRequired: true, pinValid: false })(req, res, () => {
      throw new Error('a signed URL bypassed the PIN session — that is a downgrade, not a fix');
    });
    assert.strictEqual(res.statusCode, 401);
  });

  test('with PIN enforced AND unlocked, a signed URL is admitted', () => {
    const t = signArtifactPath(REL, SECRET, 300000);
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: String(t.exp), sig: t.sig });
    const res = fakeRes();
    let nexted = false;
    accessWith({ pinRequired: true, pinValid: true })(req, res, () => { nexted = true; });
    assert.strictEqual(nexted, true);
  });

  test('a signature for a different artifact does not admit this one', () => {
    const t = signArtifactPath('builds/pipeline/other.html', SECRET, 300000);
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: String(t.exp), sig: t.sig });
    const res = fakeRes();
    accessWith()(req, res, () => { throw new Error('cross-artifact signature admitted'); });
    assert.strictEqual(res.statusCode, 401);
  });

  test('with no secret configured the middleware is a pass-through to requireToken', () => {
    // Loopback-only mode: nothing to sign with, and behaviour must be exactly
    // what it was before this existed.
    const req = fakeReq('/pipeline/ai-news-landing-page.html', { exp: '1', sig: 'x' });
    const res = fakeRes();
    accessWith({ secret: '' })(req, res, () => { throw new Error('admitted without a secret'); });
    assert.strictEqual(res.statusCode, 401);
  });
});
