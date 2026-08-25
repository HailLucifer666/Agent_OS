'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(toolsObj, name) {
  const tools = toolsObj.TOOLS || toolsObj;
  return tools.find((t) => t.name === name).fn;
}

describe('BUG-023: Weather widget geocoding fallback', () => {
  const realFetch = global.fetch;
  let ctx;

  beforeEach(() => {
    ctx = {
      bus: {},
      config: {},
      fs: null,
      buildRunner: null,
      probes: null,
      abtop: null,
      goalsEffector: null,
      pipeline: null,
      kanban: null,
      agentActions: null,
    };
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('succeeds with full location "Kolkata, West Bengal" by falling back to city name', async () => {
    let fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(url);
      // First call: try "Kolkata, West Bengal" → empty results
      if (url.includes('name=Kolkata%2C%20West%20Bengal')) {
        return {
          ok: true,
          json: async () => ({ results: [] }),
        };
      }
      // Second call: try "Kolkata" (city only) → real result
      if (url.includes('name=Kolkata')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { latitude: 22.57, longitude: 88.36, name: 'Kolkata' },
            ],
          }),
        };
      }
      throw new Error('Unexpected fetch URL: ' + url);
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'Kolkata, West Bengal' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'weather');
    assert.equal(result.result.title, 'Weather: Kolkata');
    assert.equal(result.result.location, 'Kolkata');
    assert.match(result.result.weatherUrl, /latitude=22\.57&longitude=88\.36/);
    assert.equal(fetchCalls.length, 2, 'Should make exactly 2 fetch calls');
    assert.match(fetchCalls[0], /name=Kolkata%2C%20West%20Bengal/, 'First call should try full location');
    assert.match(fetchCalls[1], /name=Kolkata/, 'Second call should try city only');
  });

  it('fails when both full location and city name return empty results', async () => {
    let fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(url);
      // Both calls return empty
      return {
        ok: true,
        json: async () => ({ results: [] }),
      };
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'Atlantis, Fictional' });

    assert.equal(result.ok, false, 'Should fail');
    // BUG-293 reworded this failure so it names get_weather: the old bare "No
    // location found" read to the model as THE WEATHER IS UNAVAILABLE rather than
    // WRONG TOOL, and on 2026-08-20 that is what it did with "Kullu Manali current
    // weather". The behaviour under test here — both geocode attempts made, then a
    // clean failure — is unchanged.
    assert.match(result.result, /No PLACE matched/);
    assert.match(result.result, /get_weather/, 'the failure must name the tool that answers this');
    assert.equal(fetchCalls.length, 2, 'Should try both full and city name');
  });

  it('fails immediately on network error (does not retry)', async () => {
    let fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(url);
      // Network error on first call
      return {
        ok: false,
        json: async () => ({}),
      };
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'Kolkata, West Bengal' });

    assert.equal(result.ok, false, 'Should fail');
    assert.match(result.result, /Could not resolve location/);
    assert.equal(fetchCalls.length, 1, 'Should stop after network error, not retry');
  });

  it('succeeds immediately with location that has no comma (single city name)', async () => {
    let fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(url);
      if (url.includes('name=London')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { latitude: 51.5, longitude: -0.12, name: 'London' },
            ],
          }),
        };
      }
      throw new Error('Unexpected fetch URL: ' + url);
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'London' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.location, 'London');
    assert.equal(fetchCalls.length, 1, 'Should only make one fetch call (no comma, no retry)');
  });

  it('handles a thrown exception in fetch gracefully', async () => {
    global.fetch = async (url) => {
      throw new Error('Connection timeout');
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'Tokyo' });

    assert.equal(result.ok, false, 'Should fail');
    assert.match(result.result, /Weather lookup failed/);
  });

  it('requires a location and fails without one', async () => {
    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather' });

    assert.equal(result.ok, false, 'Should fail');
    assert.match(result.result, /location is required/);
  });

  it('falls back to city name even when both network calls succeed but first is empty', async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      if (callCount === 1) {
        // First call: return empty
        return {
          ok: true,
          json: async () => ({ results: [] }),
        };
      }
      // Second call: return result
      return {
        ok: true,
        json: async () => ({
          results: [
            { latitude: 35.6762, longitude: 139.6503, name: 'Tokyo' },
          ],
        }),
      };
    };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'weather', location: 'Tokyo, Japan' });

    assert.equal(result.ok, true, 'Should succeed with fallback');
    assert.equal(result.result.location, 'Tokyo');
    assert.equal(callCount, 2, 'Should make two calls');
  });
});
