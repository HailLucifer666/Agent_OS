'use strict';

// test/open-web-evidence-honesty.test.js — Wave 7 (2026-08-13).
//
// open_web resolves real content (a YouTube video id, a geocoded weather
// URL, search results) and hands it to the client to render — but nothing
// here reads back from the HUD to confirm it actually rendered (no
// ui.open-web-consumed ack exists). Every branch returned a bare ok(),
// which is exactly the "the call succeeded" vs. "the thing happened"
// conflation evidence.js's own header exists to close for every other
// effector. Fixed by wrapping every open_web outcome in evidence.unverified()
// — still ok:true (real content WAS resolved), but honestly marked as
// unconfirmed rather than an unqualified success.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(built, name) {
  const t = built.TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} must be registered`);
  return t.fn;
}

function baseCtx(overrides) {
  return Object.assign({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    config: {}, fs: null, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
  }, overrides || {});
}

describe('open_web — every outcome is honestly unverified, never a bare success', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('a web (direct URL) embed is ok:true but unverified:true, with a spoken-usable reason', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'web', url: 'https://example.com' });
    assert.equal(res.ok, true, 'real content WAS resolved — this is not a failure');
    assert.equal(res.unverified, true);
    assert.equal(typeof res.reason, 'string');
    assert.ok(res.reason.length > 0);
    assert.equal(res.result.widgetType, 'web');
  });

  it('a no-embed domain (newtab route) is also unverified, not a special-cased success', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'web', url: 'https://github.com/foo/bar' });
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.equal(res.result.widgetType, 'newtab');
  });

  it('the Google News smart-route is unverified too', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'web', url: 'https://news.google.com/' });
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.equal(res.result.widgetType, 'news');
  });

  it('a weather card is unverified, and the real geocoded payload still comes through unchanged', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 2, name: 'Testville' }] }) });
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'weather', location: 'Testville' });
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.equal(res.result.widgetType, 'weather');
    assert.match(res.result.weatherUrl, /latitude=1&longitude=2/);
  });

  it('a search card list is unverified', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    // web_search's real chain will fail with no network/keys in this env —
    // the honesty guard applies equally to the FAILURE path (unaffected: a
    // real fail() is not wrapped in unverified) and this only pins the
    // success shape when results exist, so route through a stubbed search.
    const Module = require('node:module');
    const WEB_SEARCH_PATH = require.resolve('../src/core/effectors/web-search');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id, ...rest) {
      if (id === './web-search') return { web_search: async () => ({ ok: true, result: { results: [{ title: 'T', url: 'https://x.com', snippet: 's' }], source: 'test' } }) };
      return originalRequire.call(this, id, ...rest);
    };
    delete require.cache[require.resolve('../src/core/effectors/from-dashboard')];
    try {
      const fromDashboard = require('../src/core/effectors/from-dashboard');
      const built2 = fromDashboard.buildTools(baseCtx());
      const fn2 = toolFn(built2, 'open_web');
      const res = await fn2({ type: 'search', query: 'anything' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.unverified, true);
      assert.equal(res.result.widgetType, 'search');
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[require.resolve('../src/core/effectors/from-dashboard')];
      void WEB_SEARCH_PATH;
    }
  });

  it('a genuine failure (bad type, missing query) is NOT wrapped in unverified — it stays a real fail()', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'bogus' });
    assert.equal(res.ok, false);
    assert.equal(res.unverified, undefined, 'a rejected/invalid call must not read as "attempted"');
  });

  it('an invalid URL for type:web fails honestly, not as an unverified success', async () => {
    const built = buildTools(baseCtx());
    const fn = toolFn(built, 'open_web');
    const res = await fn({ type: 'web', url: 'not-a-url' });
    assert.equal(res.ok, false);
    assert.equal(res.unverified, undefined);
  });
});
