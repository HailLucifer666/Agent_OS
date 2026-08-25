'use strict';

// BUG-296 — Calendar had none of the dead-token handling Gmail got.
//
// Gmail and Calendar authenticate with the SAME refresh token. When that token
// dies, both fail, in the same way, at the same moment. Gmail has been handling
// it properly since BUG-273 C2: the failure is classified as terminal, carries
// a remedy, and sets `terminal: true` so hub.js's isTerminalResult stops the
// circuit breaker retrying something that will never succeed.
//
// calendarUpcoming did this instead:
//
//     catch (err) {
//       return { ok: false, result: { error: 'Calendar fetch failed: ' + err.message } };
//     }
//
// No classification, no remedy, no flag. So on the expired token of 2026-08-20
// Calendar produced a bare "Calendar fetch failed: invalid_grant: Token has been
// expired or revoked." — which reads like a transient fault, tells the operator
// nothing about how to fix it, and is retried forever because nothing marks it
// terminal. Same token, same fault, one file over from the fix.
//
// Found while fixing BUG-291 (the Gmail message naming its own cause) and
// deliberately kept out of that commit rather than widening it.
//
// The classifier and the remedy text now live in one module used by both
// adapters (google-auth-failure.js). Two implementations of one invariant is
// the defect class this repo hits most often — the same reason net-address.js
// exists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
const { isTerminalAuthError } = require('../src/core/effectors/google-auth-failure');

function fakeFs() {
  const store = {};
  return {
    readJSON: (p, f) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : f),
    readJSONStrict: (p, f) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : f),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
    vaultPath: () => '/vault',
  };
}

// The adapter is constructed lazily inside from-calendar from env credentials.
// Rather than reach into that, drive the tool with an adapter whose
// listUpcomingEvents throws the real error the audited session produced.
function calendarToolWithAdapter(thrown) {
  const tools = buildCalendarTools({
    fs: fakeFs(),
    googleAdapter: {
      listUpcomingEvents: async () => { throw thrown; },
    },
  });
  return tools.find((t) => t.name === 'calendar_upcoming');
}

function deadToken() {
  const err = new Error('invalid_grant: Token has been expired or revoked.');
  err.isAuthError = true;
  return err;
}

function textOf(res) {
  return String((res && res.error) || (res && res.result && res.result.error) || '');
}

describe('BUG-296: a dead token is terminal for Calendar too', () => {
  it('flags the failure terminal so the breaker stops retrying it', async () => {
    // hub.js: isTerminalResult(r) === !!(r && r.ok === false && r.terminal === true).
    // Without the flag the breaker retries a token that can never succeed until
    // it trips, and the HUD wears a DEGRADED badge for a fault no retry fixes.
    const res = await calendarToolWithAdapter(deadToken()).fn({ max: 3 });
    assert.equal(res.ok, false);
    assert.equal(res.terminal, true, 'expected terminal:true beside ok:false, got: ' + JSON.stringify(res));
  });

  it('carries the same remedy Gmail carries, including the publish-first ordering', async () => {
    const msg = textOf(await calendarToolWithAdapter(deadToken()).fn({ max: 3 }));
    assert.match(msg, /invalid_grant/, 'the real reason must survive: ' + msg);
    assert.match(msg, /google-auth\.js/, 'must name the re-auth script: ' + msg);
    assert.match(msg, /GOOGLE_REFRESH_TOKEN/);
    assert.match(msg, /7[- ]day/i, 'must name the 7-day expiry (BUG-291): ' + msg);
    assert.match(msg, /publish[\s\S]{0,200}?then re-?authoris/i, 'must keep the ordering: ' + msg);
    assert.match(msg, /Do not retry/);
  });

  it('still says Calendar, not Gmail — the prefix identifies which surface broke', async () => {
    // One shared remedy, two surfaces. Collapsing the prefix would send the
    // operator to the wrong adapter's logs.
    const msg = textOf(await calendarToolWithAdapter(deadToken()).fn({ max: 3 }));
    assert.match(msg, /^Calendar fetch failed/, msg);
    assert.ok(!/^Gmail/.test(msg), 'must not claim to be a Gmail failure: ' + msg);
  });

  it('a transient Calendar failure stays retryable and gains no OAuth advice', async () => {
    // The whole point of a narrow classifier: a socket error or a rate limit must
    // not be answered with console instructions, and must stay retryable.
    const res = await calendarToolWithAdapter(new Error('socket hang up')).fn({ max: 3 });
    assert.equal(res.ok, false);
    assert.notEqual(res.terminal, true, 'a transient failure must not be terminal');
    const msg = textOf(res);
    assert.match(msg, /socket hang up/);
    assert.ok(!/publish/i.test(msg), 'no OAuth remedy on a transient fault: ' + msg);
    assert.equal(isTerminalAuthError(new Error('socket hang up'), 'socket hang up'), false);
  });

  it('an unconfigured Calendar is still a setup message, not a dead-token one', async () => {
    // No credentials at all is a different fault with a different fix, and it
    // must not be dressed up as an expired token.
    const tool = buildCalendarTools({ fs: fakeFs(), googleAdapter: null }).find((t) => t.name === 'calendar_upcoming');
    const res = await tool.fn({ max: 3 });
    assert.equal(res.ok, false);
    const msg = textOf(res);
    assert.match(msg, /not configured/i, msg);
    assert.ok(!/7[- ]day/i.test(msg), 'an unconfigured adapter is not an expired token: ' + msg);
  });

  it('an explicitly null adapter means NO adapter — the real one is never built', async () => {
    // Added after a mutation survived. Degrading the seam from a hasOwnProperty
    // check to `ctx.googleAdapter ? ... : ensureGoogleAdapter()` passed every
    // other test here — but only because `node --test` runs without the Google
    // env vars loaded, so the real adapter reports itself unready and the
    // fallback happens to produce the same message. That is luck, not coverage:
    // on a machine where those vars ARE in the environment, the same mutation
    // sends this test at the operator's live Google account.
    //
    // So this asserts the seam behaviourally: with null passed explicitly, the
    // real adapter factory must not be constructed at all.
    const adapterPath = require.resolve('../adapters/google');
    const saved = require.cache[adapterPath];
    let built = 0;
    require.cache[adapterPath] = {
      id: adapterPath,
      filename: adapterPath,
      loaded: true,
      exports: {
        createGoogleAdapter() {
          built++;
          return { ready: true, listUpcomingEvents: async () => [] };
        },
      },
    };
    try {
      const tool = buildCalendarTools({ fs: fakeFs(), googleAdapter: null })
        .find((x) => x.name === 'calendar_upcoming');
      const res = await tool.fn({ max: 3 });
      assert.equal(built, 0, 'ensureGoogleAdapter was called despite an explicit null adapter');
      assert.equal(res.ok, false);
      assert.match(textOf(res), /not configured/i);
    } finally {
      if (saved) require.cache[adapterPath] = saved; else delete require.cache[adapterPath];
    }
  });
});

describe('BUG-296: one classifier, not two', () => {
  it('Gmail and Calendar share the same terminal-auth classifier module', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '..', 'src', 'core', 'effectors');
    const gmail = fs.readFileSync(path.join(dir, 'from-gmail.js'), 'utf8');
    const cal = fs.readFileSync(path.join(dir, 'from-calendar.js'), 'utf8');
    assert.match(gmail, /require\('\.\/google-auth-failure'\)/,
      'from-gmail must consume the shared classifier');
    assert.match(cal, /require\('\.\/google-auth-failure'\)/,
      'from-calendar must consume the shared classifier');
    // Neither file may keep a private copy of the grant-signature regex — that is
    // the two-implementations-of-one-invariant shape this extraction removes.
    for (const [name, src] of [['from-gmail.js', gmail], ['from-calendar.js', cal]]) {
      assert.ok(!/invalid_grant\|unauthorized_client/.test(src),
        name + ' still carries its own copy of the grant-signature regex');
    }
  });

  it('the sensor keeps importing a working classifier', () => {
    // gmail-sensor.js imports isTerminalAuthError from from-gmail. The extraction
    // must not break that import, or a revoked token stops being announced —
    // which is the BUG-273 C2 regression, re-armed.
    const { isTerminalAuthError: viaGmail } = require('../src/core/effectors/from-gmail');
    assert.equal(typeof viaGmail, 'function');
    assert.equal(viaGmail(null, 'invalid_grant: Token has been expired or revoked.'), true);
    assert.equal(viaGmail(null, 'socket hang up'), false);
  });
});
