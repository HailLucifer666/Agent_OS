'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-system');
const { tierOf } = require('../src/core/leash/tiers');

function toolFn(tools, name) {
  return tools.find((t) => t.name === name).fn;
}

describe('from-system tools', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  describe('get_time', () => {
    it('returns the current time with a default timezone label', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_time')({});
      assert.equal(result.ok, true);
      assert.equal(result.result.timezone, 'system default');
      assert.match(result.result.iso, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(result.result.readable.length > 0);
    });

    it('honors an explicit IANA timezone', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_time')({ timezone: 'America/New_York' });
      assert.equal(result.ok, true);
      assert.equal(result.result.timezone, 'America/New_York');
    });

    it('degrades to system default on an invalid timezone instead of throwing', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_time')({ timezone: 'Not/A_Real_Zone' });
      assert.equal(result.ok, true);
      assert.match(result.result.timezone, /unrecognized timezone/);
    });
  });

  describe('get_weather', () => {
    it('uses the configured default location when none is spoken', async () => {
      global.fetch = async (url) => {
        assert.match(url, /latitude=22\.57&longitude=88\.36/);
        return {
          ok: true,
          json: async () => ({ current: { temperature_2m: 30, weather_code: 0, relative_humidity_2m: 60, wind_speed_10m: 5 } }),
        };
      };
      const tools = buildTools({ config: { WEATHER_LOCATION: '22.57,88.36' } });
      const result = await toolFn(tools, 'get_weather')({});
      assert.equal(result.ok, true);
      assert.equal(result.result.condition, 'Clear');
      assert.equal(result.result.temperatureC, 30);
    });

    it('geocodes an explicit location before fetching the forecast', async () => {
      let calls = 0;
      global.fetch = async (url) => {
        calls++;
        if (url.includes('geocoding-api')) {
          assert.match(url, /name=London/);
          return { ok: true, json: async () => ({ results: [{ latitude: 51.5, longitude: -0.12, name: 'London' }] }) };
        }
        assert.match(url, /latitude=51\.5&longitude=-0\.12/);
        return { ok: true, json: async () => ({ current: { temperature_2m: 15, weather_code: 61, relative_humidity_2m: 80, wind_speed_10m: 10 } }) };
      };
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_weather')({ location: 'London' });
      assert.equal(calls, 2);
      assert.equal(result.ok, true);
      assert.equal(result.result.location, 'London');
      assert.equal(result.result.condition, 'Rain');
    });

    it('degrades honestly on a network failure instead of throwing', async () => {
      global.fetch = async () => { throw new Error('network down'); };
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_weather')({});
      assert.equal(result.ok, false);
      assert.match(result.result, /Weather is unavailable/);
    });

    it('degrades honestly when geocoding finds no match', async () => {
      global.fetch = async (url) => {
        assert.match(url, /geocoding-api/);
        return { ok: true, json: async () => ({ results: [] }) };
      };
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'get_weather')({ location: 'Nowhereville' });
      assert.equal(result.ok, false);
      assert.match(result.result, /no such location/);
    });
  });

  describe('system_status', () => {
    it('is registered at tier T0 (read-only, auto-allow)', () => {
      assert.equal(tierOf('system_status'), 0);
    });

    it('is declared read-only, with no params to act or mutate with', () => {
      const tools = buildTools({ config: {} });
      const tool = tools.find((t) => t.name === 'system_status');
      assert.ok(tool, 'system_status must be registered by from-system.js');
      assert.equal(tool.danger, false);
      assert.deepEqual(tool.params, {});
    });

    it('returns the expected digest shape: metrics, providers, spend, adapters', async () => {
      const fakeProbes = { getStatus: async () => ({ providers: { alive: ['groq'] } }) };
      const tools = buildTools({ config: {}, probes: fakeProbes });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.ok(result.result.metrics, 'metrics section (CPU/mem/disk) must be present');
      assert.equal(typeof result.result.metrics.uptimeSec, 'number');
      assert.deepEqual(result.result.providers, { providers: { alive: ['groq'] } });
      assert.ok(result.result.spend, 'spend digest must be present');
      assert.equal(typeof result.result.spend.successRate, 'number');
      assert.ok(result.result.adapters, 'adapter ONLINE/OFFLINE map must be present');
    });

    it('never states a dollar figure — there is no pricing table in this repo', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      const serialized = JSON.stringify(result.result.spend);
      assert.doesNotMatch(serialized, /\$|dollar|usd|cost/i);
    });

    it('degrades honestly when probes is absent, instead of throwing', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.equal(result.result.providers, null);
    });
  });
});
