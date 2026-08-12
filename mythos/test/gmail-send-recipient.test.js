'use strict';

// Task D3 — gmail_send resolves "me" to the authenticated account instead of
// forwarding the literal string to Gmail, which rejected it with "Invalid To
// header" only *after* MYTHOS had already drafted the whole email body
// (installed-build session, 2026-08-12 02:06:02 — "send me an email").
//
// DI seam mirrors test/from-calendar-google.test.js: substitute the compiled
// adapters/google module in require.cache with a fake createGoogleAdapter so
// from-gmail.js's lazy ensureAdapter() picks up a mocked "ready" adapter
// instead of touching the network.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function toolFn(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.fn;
}

function installFakeGoogleAdapter(factory) {
  const googlePath = require.resolve('../adapters/google');
  const real = require.cache[googlePath];
  delete require.cache[googlePath];
  require.cache[googlePath] = {
    id: googlePath,
    filename: googlePath,
    loaded: true,
    exports: { createGoogleAdapter: factory },
  };
  return function restore() {
    delete require.cache[googlePath];
    if (real) require.cache[googlePath] = real;
  };
}

function freshFromGmail() {
  delete require.cache[require.resolve('../src/core/effectors/from-gmail')];
  return require('../src/core/effectors/from-gmail');
}

describe('D3: gmail_send resolves "me" to the authenticated account', () => {
  let restoreGoogle;

  afterEach(() => {
    if (restoreGoogle) { restoreGoogle(); restoreGoogle = null; }
    delete require.cache[require.resolve('../src/core/effectors/from-gmail')];
  });

  it('to: "me" resolves to the Gmail profile\'s own address before sending', async () => {
    let profileCalls = 0;
    let sentTo = null;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => { profileCalls++; return { emailAddress: 'operator@example.com' }; },
      send: async (msg) => { sentTo = msg.to; return { id: 'sent-1' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'me', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, true);
    assert.equal(result.result.to, 'operator@example.com');
    assert.equal(sentTo, 'operator@example.com');
    assert.equal(profileCalls, 1);
  });

  it('a missing "to" also resolves to the authenticated account', async () => {
    let sentTo = null;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => ({ emailAddress: 'operator@example.com' }),
      send: async (msg) => { sentTo = msg.to; return { id: 'sent-2' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ subject: 'hi', body: 'hello' });

    assert.equal(result.ok, true);
    assert.equal(result.result.to, 'operator@example.com');
    assert.equal(sentTo, 'operator@example.com');
  });

  it('caches the resolved address for the session — getProfile is called only once across two sends', async () => {
    let profileCalls = 0;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => { profileCalls++; return { emailAddress: 'operator@example.com' }; },
      send: async () => ({ id: 'sent' }),
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    await gmail_send({ to: 'me', subject: 'a', body: 'b' });
    await gmail_send({ to: 'me', subject: 'c', body: 'd' });

    assert.equal(profileCalls, 1, 'getProfile must not be called on every send once cached');
  });

  it('an explicit recipient bypasses the profile lookup entirely', async () => {
    let profileCalls = 0;
    let sentTo = null;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => { profileCalls++; return { emailAddress: 'operator@example.com' }; },
      send: async (msg) => { sentTo = msg.to; return { id: 'sent' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'friend@example.com', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, true);
    assert.equal(sentTo, 'friend@example.com');
    assert.equal(profileCalls, 0, 'an explicit recipient must never trigger a profile lookup');
  });

  it('fails BEFORE calling send when "me" cannot be resolved (no profile lookup available), naming the missing piece', async () => {
    let sendCalled = false;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      // No getProfile on this adapter build — simulates a lookup that isn't
      // available with the current credentials/adapter version.
      send: async () => { sendCalled = true; return { id: 'should-not-happen' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'me', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, false);
    assert.match(result.result.error, /recipient|"me"|profile/i);
    assert.equal(sendCalled, false, 'must fail before composing/sending, not after');
  });

  it('fails BEFORE calling send when the Gmail profile lookup errors, naming the failure', async () => {
    let sendCalled = false;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => { throw new Error('network down'); },
      send: async () => { sendCalled = true; return { id: 'should-not-happen' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'me', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, false);
    assert.match(result.result.error, /profile/i);
    assert.equal(sendCalled, false);
  });

  it('fails BEFORE calling send when the profile has no email address, naming what is missing', async () => {
    let sendCalled = false;
    restoreGoogle = installFakeGoogleAdapter(() => ({
      ready: true,
      getProfile: async () => ({}), // no emailAddress field
      send: async () => { sendCalled = true; return { id: 'should-not-happen' }; },
    }));

    const { buildTools } = freshFromGmail();
    const tools = buildTools({ logger: { warn: () => {} } });
    const gmail_send = toolFn(tools, 'gmail_send');

    const result = await gmail_send({ to: 'me', subject: 'hi', body: 'hello' });

    assert.equal(result.ok, false);
    assert.match(result.result.error, /address|profile/i);
    assert.equal(sendCalled, false);
  });
});
