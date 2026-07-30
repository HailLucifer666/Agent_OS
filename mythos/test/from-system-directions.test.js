'use strict';

// test/from-system-directions.test.js — §7.9 maps/routing: get_directions.
// Mocks global.fetch for both the Open-Meteo geocoding calls (reused from
// get_weather) and the free, keyless OSRM public routing API. No real
// network needed for this suite — see scripts/verify-directions-live.js (or
// the session's live-verification transcript) for the real-network proof.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-system');

function toolFn(tools, name) {
  const t = tools.find((t) => t.name === name);
  return t && t.fn;
}

describe('from-system tools — get_directions', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('is registered with a fn', () => {
    const tools = buildTools({ config: {} });
    assert.ok(toolFn(tools, 'get_directions'), 'get_directions must be registered');
  });

  it('geocodes from/to, defaults to driving, and returns distance/duration computed from OSRM', async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      if (url.includes('geocoding-api')) {
        if (url.includes('London')) {
          return { ok: true, json: async () => ({ results: [{ latitude: 51.5, longitude: -0.12, name: 'London' }] }) };
        }
        if (url.includes('Paris')) {
          return { ok: true, json: async () => ({ results: [{ latitude: 48.85, longitude: 2.35, name: 'Paris' }] }) };
        }
        return { ok: true, json: async () => ({ results: [] }) };
      }
      // OSRM route call
      assert.match(url, /router\.project-osrm\.org\/route\/v1\/driving\//);
      assert.match(url, /-0\.12,51\.5;2\.35,48\.85/);
      return {
        ok: true,
        json: async () => ({ code: 'Ok', routes: [{ distance: 344000, duration: 12600 }] }),
      };
    };

    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'London', to: 'Paris' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.fromLabel, 'London');
    assert.equal(result.result.toLabel, 'Paris');
    assert.equal(result.result.mode, 'driving');
    assert.equal(result.result.distanceKm, 344);
    assert.equal(result.result.durationMin, 210);
    assert.equal(calls.length, 3, 'two geocode calls + one OSRM call');
  });

  it('maps mode=walking to the OSRM foot profile in the request URL', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1, name: 'A' }] }) };
      }
      assert.match(url, /\/route\/v1\/foot\//);
      return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 1000, duration: 600 }] }) };
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B', mode: 'walking' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.mode, 'walking');
  });

  it('maps mode=cycling to the OSRM bike profile in the request URL', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1, name: 'A' }] }) };
      }
      assert.match(url, /\/route\/v1\/bike\//);
      return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 1000, duration: 600 }] }) };
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B', mode: 'cycling' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.mode, 'cycling');
  });

  it('rejects an unsupported mode honestly, without ever calling fetch', async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B', mode: 'teleport' });
    assert.equal(result.ok, false);
    assert.match(result.result, /mode/i);
    assert.equal(fetchCalled, false);
  });

  it('degrades honestly when geocoding the origin fails', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [] }) };
      throw new Error('should not reach OSRM');
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'Nowhereville', to: 'Paris' });
    assert.equal(result.ok, false);
    assert.match(result.result, /unavailable/i);
  });

  it('degrades honestly when OSRM is unreachable', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1, name: 'X' }] }) };
      }
      throw new Error('network down');
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B' });
    assert.equal(result.ok, false);
    assert.match(result.result, /unavailable/i);
  });

  it('degrades honestly when OSRM finds no route', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1, name: 'X' }] }) };
      }
      return { ok: true, json: async () => ({ code: 'NoRoute', routes: [] }) };
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B' });
    assert.equal(result.ok, false);
    assert.match(result.result, /unavailable/i);
  });

  it('never throws even when OSRM returns a non-ok HTTP status', async () => {
    global.fetch = async (url) => {
      if (url.includes('geocoding-api')) {
        return { ok: true, json: async () => ({ results: [{ latitude: 1, longitude: 1, name: 'X' }] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const tools = buildTools({ config: {} });
    const result = await toolFn(tools, 'get_directions')({ from: 'A', to: 'B' });
    assert.equal(result.ok, false);
    assert.match(result.result, /unavailable/i);
  });
});
