// test/security-state.test.js — pure node:test coverage for the SECURITY
// panel's decisions (views/security-state.js). Same idiom as
// test/pin-gate-state.test.js: no DOM, no fetch — the module is pure by
// construction, so the tests are the module.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STATE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'security-state.js')
).href;

describe('derivePinPanelStatus (GET /api/pin/status -> panel state)', () => {
  it('an explicit configured:true is the only way to report configured', async () => {
    const { derivePinPanelStatus } = await import(STATE_URL);
    const st = derivePinPanelStatus({ ok: true, status: 200, body: { configured: true, hasWindowsHello: false } });
    assert.equal(st.state, 'configured');
    assert.equal(st.reason, '');
  });

  it('configured:false reports not-configured, never a lockout', async () => {
    const { derivePinPanelStatus } = await import(STATE_URL);
    const st = derivePinPanelStatus({ ok: true, status: 200, body: { configured: false } });
    assert.equal(st.state, 'not-configured');
    assert.equal(st.reason, '');
  });

  it('404 (pinLock unwired in this deployment) is unavailable, not a guess', async () => {
    const { derivePinPanelStatus } = await import(STATE_URL);
    const st = derivePinPanelStatus({ ok: false, status: 404, body: { error: 'PIN lock is not available in this deployment.' } });
    assert.equal(st.state, 'unavailable');
    assert.match(st.reason, /not available/);
  });

  it('unparseable body, non-200, or a failed fetch is indeterminate — never configured', async () => {
    const { derivePinPanelStatus } = await import(STATE_URL);
    for (const probe of [
      { ok: true, status: 200, body: null },
      { ok: true, status: 200, body: 'garbage' },
      { ok: false, status: 500, body: {} },
      { ok: false, status: 401, body: { error: 'unauthorized' } },
      { ok: false, status: 200, body: {} },
      null, // fetch threw
    ]) {
      const st = derivePinPanelStatus(probe);
      assert.equal(st.state, 'indeterminate', JSON.stringify(probe));
      assert.ok(st.reason.length > 0);
    }
  });

  it('a body without a boolean configured is indeterminate (not a lie in either direction)', async () => {
    const { derivePinPanelStatus } = await import(STATE_URL);
    const st = derivePinPanelStatus({ ok: true, status: 200, body: { hasWindowsHello: false } });
    assert.equal(st.state, 'indeterminate');
  });
});

describe('derivePinSectionNeed (first-run setup screen PIN block)', () => {
  it('renders a set-PIN form when no PIN is configured', async () => {
    const { derivePinSectionNeed } = await import(STATE_URL);
    const need = derivePinSectionNeed({ ok: true, status: 200, body: { configured: false } });
    assert.equal(need.show, true);
    assert.equal(need.configured, false);
  });

  it('renders a change-PIN form when a PIN is configured', async () => {
    const { derivePinSectionNeed } = await import(STATE_URL);
    const need = derivePinSectionNeed({ ok: true, status: 200, body: { configured: true } });
    assert.equal(need.show, true);
    assert.equal(need.configured, true);
  });

  it('renders nothing on an indeterminate probe or an unwired deployment', async () => {
    const { derivePinSectionNeed } = await import(STATE_URL);
    for (const probe of [
      null,
      { ok: false, status: 404, body: { error: 'PIN lock is not available in this deployment.' } },
      { ok: false, status: 401, body: {} },
      { ok: true, status: 200, body: null },
      { ok: false, status: 500, body: {} },
    ]) {
      const need = derivePinSectionNeed(probe);
      assert.equal(need.show, false, JSON.stringify(probe));
      assert.equal(need.configured, false);
    }
  });
});

describe('confirmMatches (type-it-twice guard)', () => {
  it('exact string equality only — trailing whitespace is a mismatch', async () => {
    const { confirmMatches } = await import(STATE_URL);
    assert.equal(confirmMatches('4242', '4242'), true);
    assert.equal(confirmMatches('4242', '4242 '), false);
    assert.equal(confirmMatches('4242', '4243'), false);
    assert.equal(confirmMatches(4242, '4242'), false, 'non-string is never a match');
    assert.equal(confirmMatches(null, null), false);
  });
});

describe('interpretSetResult (POST /api/pin/set -> what the panel says)', () => {
  it('ok:true reports saved and names the next observable step', async () => {
    const { interpretSetResult } = await import(STATE_URL);
    const out = interpretSetResult({ ok: true, status: 200, body: { ok: true } }, '');
    assert.equal(out.set, true);
    assert.match(out.message, /PIN saved/);
  });

  it('a thrown fetch is a failure whose message survives', async () => {
    const { interpretSetResult } = await import(STATE_URL);
    const out = interpretSetResult(null, 'the server did not answer');
    assert.equal(out.set, false);
    assert.equal(out.message, 'the server did not answer');
  });

  it("the server's 429 lockout text is shown verbatim, never reworded", async () => {
    const { interpretSetResult } = await import(STATE_URL);
    const out = interpretSetResult(
      { ok: false, status: 429, body: { error: 'Too many attempts — locked for 60s.' } }, ''
    );
    assert.equal(out.set, false);
    assert.equal(out.message, 'Too many attempts — locked for 60s.');
  });

  it('a 401 (wrong current PIN) names the cause from the server text', async () => {
    const { interpretSetResult } = await import(STATE_URL);
    const out = interpretSetResult(
      { ok: false, status: 401, body: { error: 'Incorrect PIN.' } }, ''
    );
    assert.equal(out.set, false);
    assert.equal(out.message, 'Incorrect PIN.');
  });

  it('an unrecognized answer never claims success', async () => {
    const { interpretSetResult } = await import(STATE_URL);
    for (const res of [
      null,
      { ok: false, status: 400, body: { error: 'PIN must be 4-12 digits.' } },
      { ok: true, status: 200, body: null },
      { ok: true, status: 200, body: { error: 'weird' } },
    ]) {
      const out = interpretSetResult(res, '');
      assert.equal(out.set, false, JSON.stringify(res));
      assert.ok(out.message.length > 0);
    }
  });
});
