'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-system');

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
});
