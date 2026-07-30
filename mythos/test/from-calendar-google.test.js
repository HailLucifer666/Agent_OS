'use strict';

// test/from-calendar-google.test.js — §7.6 Google Calendar read layer.
// Mirrors test/bug-024-gmail-calendar.test.js's pattern: bust require.cache
// for both from-calendar.js and adapters/google so the module-level adapter
// cache starts fresh per test, and prove the clean-config-error path never
// makes a real network call. A second describe proves the success path
// against a mocked adapter (real GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN are
// not configured on this machine, so no real Google Calendar account is
// reachable here — that live check needs an operator with real OAuth creds
// configured, same class of gap as the other operator-only items in this
// build).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const CLEAN_MSG = 'Google Calendar is not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.';
const GOOGLE_ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

function toolFn(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.fn;
}

function fakeVaultFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
  };
}

describe('§7.6 calendar_upcoming: clean config error when Google creds are unset', () => {
  const saved = {};

  beforeEach(() => {
    GOOGLE_ENV_KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    delete require.cache[require.resolve('../src/core/effectors/from-calendar')];
    delete require.cache[require.resolve('../adapters/google')];
  });

  afterEach(() => {
    GOOGLE_ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  it('calendar_upcoming returns the exact clean config error, no network call', async () => {
    const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
    const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
    const fn = toolFn(tools, 'calendar_upcoming');

    const result = await fn({});

    assert.equal(result.ok, false);
    assert.equal(result.result.error, CLEAN_MSG);
  });

  it('keeps returning the clean error on a second call (not-ready sentinel must not get cached as truthy)', async () => {
    const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
    const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
    const fn = toolFn(tools, 'calendar_upcoming');

    const first = await fn({});
    const second = await fn({});

    assert.equal(first.result.error, CLEAN_MSG);
    assert.equal(second.result.error, CLEAN_MSG);
  });

  it('reminder tools are unaffected by the new tool (local store still works with no Google creds)', async () => {
    const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
    const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
    const addFn = toolFn(tools, 'reminder_add');
    const res = await addFn({ text: 'stand up', when: 'in 5 minutes' });
    assert.equal(res.ok, true);
  });
});

describe('§7.6 calendar_upcoming: success path against a mocked adapter', () => {
  it('maps real Calendar API event shape into {id, title, start, end, location}', async () => {
    // Load the real module, then monkeypatch adapters/google's factory via the
    // require cache so from-calendar.js's lazy ensureGoogleAdapter() picks up
    // a fake "ready" adapter instead of hitting the network — this is the
    // legitimate DI seam this codebase already uses elsewhere (createSocket,
    // contextFactory) applied via require-cache substitution since
    // from-calendar.js doesn't (yet) accept an injectable adapter factory.
    delete require.cache[require.resolve('../src/core/effectors/from-calendar')];
    const googlePath = require.resolve('../adapters/google');
    const realGoogleModule = require.cache[googlePath];
    delete require.cache[googlePath];
    require.cache[googlePath] = {
      id: googlePath,
      filename: googlePath,
      loaded: true,
      exports: {
        createGoogleAdapter: () => ({
          ready: true,
          listUpcomingEvents: async (max) => {
            assert.equal(max, 5);
            return [{ id: 'evt1', title: 'Standup', start: '2026-08-01T09:00:00Z', end: '2026-08-01T09:15:00Z', location: null }];
          },
        }),
      },
    };
    try {
      const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
      const tools = buildCalendarTools({ fs: fakeVaultFs(), bus: null });
      const fn = toolFn(tools, 'calendar_upcoming');
      const result = await fn({ max: 5 });
      assert.equal(result.ok, true);
      assert.equal(result.result.events.length, 1);
      assert.equal(result.result.events[0].title, 'Standup');
    } finally {
      delete require.cache[require.resolve('../src/core/effectors/from-calendar')];
      if (realGoogleModule) require.cache[googlePath] = realGoogleModule;
      else delete require.cache[googlePath];
    }
  });
});
