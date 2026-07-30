'use strict';
// test/pin-gate-state.test.js — pure node:test coverage for the PIN lock
// screen's two decisions, extracted out of the DOM shell exactly like
// test/voice-barge-in-decision.test.js does for voice-loop.js:
//
//   derivePinGate(...)          — given GET /api/pin/status, is the HUD locked?
//   interpretVerifyResponse(...) — given POST /api/pin/verify's real
//                                  status+body, what does the screen show?
//
// The honesty constraints under test: the backend (src/core/security/
// pin-lock.js) sends 401 + 'Incorrect PIN.' for a wrong PIN and 429 +
// 'Too many attempts — locked for Ns.' once the 5-attempt lockout trips. It
// does NOT send a remaining-attempts count, so the UI must not invent one,
// and it must not build a client-side countdown out of the message text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const GATE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'pin', 'pin-gate.js')
).href;

describe('derivePinGate (GET /api/pin/status -> locked or not)', () => {
  it('configured:true locks the HUD', async () => {
    const { derivePinGate } = await import(GATE_URL);
    const gate = derivePinGate({ ok: true, status: 200, body: { configured: true, hasWindowsHello: false } });
    assert.equal(gate.locked, true);
  });

  it('configured:false leaves the HUD exactly as it is today — no overlay at all', async () => {
    const { derivePinGate } = await import(GATE_URL);
    const gate = derivePinGate({ ok: true, status: 200, body: { configured: false, hasWindowsHello: false } });
    assert.equal(gate.locked, false);
    assert.equal(gate.reason, 'not-configured');
  });

  it('404 (pinLock unwired in this deployment) does not lock — the route itself says the feature is absent', async () => {
    const { derivePinGate } = await import(GATE_URL);
    const gate = derivePinGate({ ok: false, status: 404, body: { error: 'PIN lock is not available in this deployment.' } });
    assert.equal(gate.locked, false);
    assert.equal(gate.reason, 'unavailable');
  });

  it('an indeterminate answer (network failure, 401, 500, garbage body) does not lock, and says WHY it could not tell', async () => {
    const { derivePinGate } = await import(GATE_URL);
    const cases = [
      { ok: false, status: 0, body: null },
      { ok: false, status: 401, body: { error: 'Unauthorized' } },
      { ok: false, status: 500, body: { error: 'boom' } },
      { ok: true, status: 200, body: null },
      { ok: true, status: 200, body: 'not-json' },
      undefined,
    ];
    for (const c of cases) {
      const gate = derivePinGate(c);
      assert.equal(gate.locked, false, `${JSON.stringify(c)} must not lock`);
      assert.equal(gate.reason, 'indeterminate', `${JSON.stringify(c)} should be reported as indeterminate`);
    }
  });
});

describe('interpretVerifyResponse (POST /api/pin/verify -> lock screen state)', () => {
  it('200 {ok:true} unlocks', async () => {
    const { interpretVerifyResponse } = await import(GATE_URL);
    const s = interpretVerifyResponse({ status: 200, body: { ok: true } });
    assert.equal(s.unlocked, true);
    assert.equal(s.lockedOut, false);
    assert.equal(s.message, '');
  });

  it('401 surfaces the server\'s own wrong-PIN message verbatim and does NOT invent a remaining-attempts count', async () => {
    const { interpretVerifyResponse } = await import(GATE_URL);
    const s = interpretVerifyResponse({ status: 401, body: { error: 'Incorrect PIN.' } });
    assert.equal(s.unlocked, false);
    assert.equal(s.lockedOut, false);
    assert.equal(s.message, 'Incorrect PIN.');
    assert.equal(/attempt/i.test(s.message), false, 'the backend sent no attempt count — the UI must not add one');
  });

  it('429 is surfaced as a real lockout, carrying the server\'s message verbatim (no client-side countdown)', async () => {
    const { interpretVerifyResponse } = await import(GATE_URL);
    const serverMsg = 'Too many attempts — locked for 60s.';
    const s = interpretVerifyResponse({ status: 429, body: { error: serverMsg } });
    assert.equal(s.unlocked, false);
    assert.equal(s.lockedOut, true);
    assert.equal(s.message, serverMsg);
    // The screen must not derive its own expiry clock from that string.
    assert.equal(s.lockedUntil, undefined, 'no synthesized expiry timestamp (AD-5)');
    assert.equal(s.retryAfterMs, undefined, 'no synthesized retry delay (AD-5)');
  });

  it('a 429 with no message still reads as locked out, with an honest generic line', async () => {
    const { interpretVerifyResponse } = await import(GATE_URL);
    const s = interpretVerifyResponse({ status: 429, body: {} });
    assert.equal(s.lockedOut, true);
    assert.equal(s.unlocked, false);
    assert.ok(s.message.length > 0);
  });

  it('a 400/500/garbage response never unlocks', async () => {
    const { interpretVerifyResponse } = await import(GATE_URL);
    const cases = [
      { status: 400, body: { error: 'No PIN configured.' } },
      { status: 500, body: { error: 'boom' } },
      { status: 0, body: null },
      { status: 200, body: {} },          // 200 without ok:true is NOT an unlock
      { status: 200, body: { ok: false } },
      undefined,
    ];
    for (const c of cases) {
      const s = interpretVerifyResponse(c);
      assert.equal(s.unlocked, false, `${JSON.stringify(c)} must not unlock`);
      assert.ok(typeof s.message === 'string' && s.message.length > 0, 'always has something honest to show');
    }
  });
});

describe("isGateClosed (tri-state guard app.js's mic-arming, wake-word, proactive-speech, and navigate handlers all call)", () => {
  it('treats the unknown state (GET /api/pin/status still in flight) as closed, the same as locked — this is what closes the arm-before-lock race in armOnce', async () => {
    const { isGateClosed } = await import(GATE_URL);
    assert.equal(isGateClosed('unknown'), true);
    assert.equal(isGateClosed('locked'), true);
  });

  it('only the explicit unlocked state opens the gate', async () => {
    const { isGateClosed } = await import(GATE_URL);
    assert.equal(isGateClosed('unlocked'), false);
  });

  it("onWake must refuse while locked or unknown — the same guard app.js's wake-word onWake handler calls before anything else", async () => {
    const { isGateClosed } = await import(GATE_URL);
    assert.equal(isGateClosed('locked'), true, 'onWake must refuse while locked');
    assert.equal(isGateClosed('unknown'), true, 'onWake must refuse while the lock state is still unknown');
    assert.equal(isGateClosed('unlocked'), false, 'onWake may proceed once unlocked');
  });

  it("proactive speech must be suppressed while locked or unknown — the same guard app.js's proactive-speech subscribe handler calls before registering a reply handler", async () => {
    const { isGateClosed } = await import(GATE_URL);
    assert.equal(isGateClosed('locked'), true, 'proactive speech must be suppressed while locked');
    assert.equal(isGateClosed('unknown'), true, 'proactive speech must be suppressed while the lock state is still unknown');
    assert.equal(isGateClosed('unlocked'), false, 'proactive speech may play once unlocked');
  });
});

describe('validatePinInput (client-side shape check only, mirrors PIN_RE)', () => {
  it('accepts 4-12 digits, rejects everything else — and never reports the PIN back in the message', async () => {
    const { validatePinInput } = await import(GATE_URL);
    assert.equal(validatePinInput('1234').ok, true);
    assert.equal(validatePinInput('123456789012').ok, true);
    for (const bad of ['', '123', '1234567890123', 'abcd', '12 34', '12.34', null, undefined]) {
      const r = validatePinInput(bad);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
      assert.ok(r.error.length > 0);
      if (typeof bad === 'string' && bad.length) {
        assert.equal(r.error.includes(bad), false, 'the entered PIN must never be echoed back into UI text');
      }
    }
  });
});
