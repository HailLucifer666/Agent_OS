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
    // system_status reads provider health directly via brain/registry.js (no
    // ctx.probes at all — FIX 1, see from-system.js's header). registry.js's
    // own getStatus() does real fetch()-backed probes and caches for a TTL,
    // which would make these tests slow and network-dependent; monkeypatch
    // the module's exported getStatus for determinism, same pattern
    // test/immune.test.js already uses for this exact module. from-system.js
    // calls it as `registry.getStatus()` (not destructured at require time),
    // so reassigning the exported property here is visible to it.
    const registry = require('../src/core/brain/registry');
    const originalGetStatus = registry.getStatus;
    const fakeRegistryStatus = {
      nim: { configured: 0, aliveModels: 0 }, groq: { alive: true }, mistral: { alive: true },
      cerebras: { configured: false, aliveModels: 0 }, google: { configured: false, aliveModels: 0 },
      openrouter: { configured: false, alive: false }, chains: {}, probedAt: 12345,
    };
    beforeEach(() => { registry.getStatus = async () => fakeRegistryStatus; });
    afterEach(() => { registry.getStatus = originalGetStatus; });

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
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.ok(result.result.metrics, 'metrics section (CPU/mem/disk) must be present');
      assert.equal(typeof result.result.metrics.uptimeSec, 'number');
      assert.deepEqual(result.result.providers.providers, fakeRegistryStatus);
      assert.ok(Array.isArray(result.result.providers.quotas));
      assert.ok(result.result.spend, 'spend digest must be present');
      assert.equal(typeof result.result.spend.successRate, 'number');
      assert.ok(result.result.adapters, 'adapter ONLINE/OFFLINE map must be present');
    });

    // FIX 2 (code review): a single snapshotSystemMetrics() call has no
    // earlier os.cpus() sample to diff against, so cpu.loadPercent self-diffs
    // to a permanent null — degrades honestly, which is exactly why it can
    // ship broken unnoticed. system_status now goes through the shared
    // sampledSystemMetrics() two-sample helper (server/routes/system.js),
    // the same fix already landed for the boot briefing in 18b603a. This
    // must fail if that regresses back to a bare snapshotSystemMetrics().
    it('the CPU figure is a real delta, not permanently null (FIX 2)', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.equal(typeof result.result.metrics.cpu.loadPercent, 'number',
        'cpu.loadPercent must be a real two-sample delta, not null from a single self-diffed sample');
    });

    it('never states a dollar figure — there is no pricing table in this repo', async () => {
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      const serialized = JSON.stringify(result.result.spend);
      assert.doesNotMatch(serialized, /\$|dollar|usd|cost/i);
    });

    it('degrades honestly when the provider-health read throws, instead of throwing itself', async () => {
      registry.getStatus = async () => { throw new Error('probe failed'); };
      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.equal(result.result.providers, null);
    });

    // FIX 1 (HIGH, code review): probes.getStatus() (immune/probes.js) is
    // documented as emitting 'health.anomaly'/'health.healed' on provider-
    // down/quota-low STATE TRANSITIONS, which diagnostician.js/healer.js turn
    // into real remediation (restart-cortex, pause-goal, degrade-lane,
    // suppress-tool). A T0, voice-invoked, read-only tool must never be able
    // to originate that emit — that is the whole reason this plan refused to
    // add a restart_component effector. This proves system_status's read
    // path never touches a bus at all, using a fixture chosen specifically
    // because it WOULD trip the emit if system_status went through
    // probes.getStatus() — the sanity assertion at the end proves the
    // fixture is capable of tripping it through the real wrapper, so this
    // test cannot pass vacuously.
    it('never triggers the immune system\'s health.anomaly/health.healed side effect', async () => {
      registry.getStatus = async () => ({
        nim: { configured: 1, aliveModels: 0 }, groq: { alive: false }, mistral: { alive: false },
        cerebras: {}, google: {}, openrouter: {}, chains: {}, probedAt: Date.now(),
      });
      const emitted = [];
      const fakeBus = { emit: (type, payload) => emitted.push({ type, payload }) };
      const { createProbes } = require('../src/core/immune/probes');
      const probes = createProbes({ bus: fakeBus, config: {} });

      const tools = buildTools({ config: {} });
      const result = await toolFn(tools, 'system_status')({});
      assert.equal(result.ok, true);
      assert.deepEqual(emitted, [], 'system_status must never emit health.anomaly/health.healed via probes.js');

      // Sanity: the SAME registry fixture DOES trip the emit through the real
      // probes.js wrapper — proves the fixture is capable of tripping it and
      // that the assertion above is not passing vacuously.
      await probes.getStatus();
      assert.ok(emitted.length > 0,
        'sanity check failed: this fixture must emit through probes.getStatus(), or this test proves nothing');
    });
  });
});
