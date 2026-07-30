'use strict';

// test/pin-lock.test.js — §7.3 PIN lock. Salted hash in the vault, never
// plaintext; rate-limited against brute force; Windows Hello honestly
// reported as not-implemented (see pin-lock.js's header for why).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPinLock } = require('../src/core/security/pin-lock');

function fakeVaultFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = d === null ? null : JSON.parse(JSON.stringify(d)); },
    _raw: store,
  };
}

test('no PIN configured initially; setPin rejects a non-numeric/short/long PIN', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  assert.equal(lock.isConfigured(), false);

  assert.equal(lock.setPin('12a4').ok, false);
  assert.equal(lock.setPin('123').ok, false);
  assert.equal(lock.setPin('1234567890123').ok, false);
  assert.equal(lock.isConfigured(), false);
});

test('setPin stores a salted hash, never the plaintext PIN', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  const res = lock.setPin('4242');
  assert.equal(res.ok, true);
  assert.equal(lock.isConfigured(), true);

  const raw = fs._raw['Identity/pin.json'];
  assert.ok(raw.salt && raw.hash, 'salt and hash must be present');
  assert.notEqual(raw.hash, '4242');
  assert.equal(JSON.stringify(raw).includes('4242'), false, 'the plaintext PIN must never appear anywhere in the stored record');
});

test('verifyPin: correct PIN passes, wrong PIN fails, with no PIN configured fails honestly', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  assert.equal(lock.verifyPin('4242').ok, false); // not configured yet

  lock.setPin('4242');
  assert.equal(lock.verifyPin('4242').ok, true);
  assert.equal(lock.verifyPin('0000').ok, false);
  assert.equal(lock.verifyPin('4242').ok, true); // a correct verify doesn't get "used up"
});

test('verifyPin locks out after repeated failures, even against the correct PIN, then recovers', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  lock.setPin('4242');

  for (let i = 0; i < 5; i++) {
    const res = lock.verifyPin('0000');
    assert.equal(res.ok, false);
  }
  // 5th failure should have triggered the lockout.
  const lockedRes = lock.verifyPin('4242'); // correct PIN, but locked out
  assert.equal(lockedRes.ok, false);
  assert.equal(lockedRes.lockedOut, true);

  t.mock.timers.tick(61000); // past the lockout window
  const afterRes = lock.verifyPin('4242');
  assert.equal(afterRes.ok, true);
});

// Superseded by the security-reviewer fix above: setPin() no longer accepts
// a bare replacement PIN with no proof of the current one, so "just call
// setPin to escape a lockout" is no longer a real recovery path — allowing
// that would have been exactly the bypass the fix closes (an attacker who
// can reach the route at all could always change:instead-of-guess). Once a
// lockout is active, changing the PIN is correctly blocked too (verifyPin()
// is what setPin() calls internally to check the current PIN, and it
// enforces the same lockout) — real recovery is: wait out the 60s window,
// THEN change it with the correct current PIN. Both halves proven below.
test('setPin() does NOT bypass an active lockout, even with the correct current PIN', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  lock.setPin('4242');
  for (let i = 0; i < 5; i++) lock.verifyPin('0000');
  assert.equal(lock.verifyPin('4242').lockedOut, true);

  const attempt = lock.setPin('9999', '4242'); // correct current PIN, but still locked out
  assert.equal(attempt.ok, false);
  assert.equal(attempt.lockedOut, true);
});

test('setPin() succeeds with the correct current PIN once the lockout window has passed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  lock.setPin('4242');
  for (let i = 0; i < 5; i++) lock.verifyPin('0000');
  assert.equal(lock.verifyPin('4242').lockedOut, true);

  t.mock.timers.tick(61000);
  const attempt = lock.setPin('9999', '4242');
  assert.equal(attempt.ok, true);
  assert.equal(lock.verifyPin('9999').ok, true);
});

test('hasWindowsHello() honestly reports false — never built this session, not a hardware probe result', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  assert.equal(lock.hasWindowsHello(), false);
});

test('security-reviewer fix: setPin requires the CURRENT pin before replacing an already-configured one', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  lock.setPin('4242'); // first-time setup: no currentPin needed

  // Attempting to change it without the correct current PIN must fail and
  // must NOT change the stored PIN.
  const wrongCurrent = lock.setPin('9999', '0000');
  assert.equal(wrongCurrent.ok, false);
  assert.equal(lock.verifyPin('4242').ok, true, 'old PIN must still work — the change must not have happened');

  // With no currentPin argument at all (the exact bypass the review found).
  const noCurrent = lock.setPin('9999');
  assert.equal(noCurrent.ok, false);
  assert.equal(lock.verifyPin('4242').ok, true);

  // With the correct current PIN, the change succeeds for real.
  const rightCurrent = lock.setPin('9999', '4242');
  assert.equal(rightCurrent.ok, true);
  assert.equal(lock.verifyPin('9999').ok, true);
  assert.equal(lock.verifyPin('4242').ok, false, 'old PIN must no longer work after a real change');
});

test('clearPin removes the stored PIN and resets lockout state', () => {
  const fs = fakeVaultFs();
  const lock = createPinLock({ fs });
  lock.setPin('4242');
  assert.equal(lock.isConfigured(), true);
  lock.clearPin();
  assert.equal(lock.isConfigured(), false);
  assert.equal(lock.verifyPin('4242').ok, false);
});
