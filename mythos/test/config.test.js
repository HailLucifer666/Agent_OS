'use strict';

const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validate, SCHEMA } = require('../src/core/config');

describe('config', () => {
  it('accepts valid env with all defaults', () => {
    const result = validate({}, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.MYTHOS_NAME, 'MYTHOS');
    assert.equal(result.config.MYTHOS_PORT, 4478);
    assert.equal(result.config.MYTHOS_BIND, '127.0.0.1');
    // B3-remainder (security audit, 2026-08-08): the default used to be the
    // literal relative string './vault', resolved against whatever cwd
    // launched the process — the exact shape of the "factory-reset MYTHOS"
    // incident. It is now an ABSOLUTE path anchored to mythos/ (this file's
    // own package root), independent of process.cwd(). An explicit
    // MYTHOS_VAULT_ROOT (tested elsewhere) is untouched and still wins.
    assert.equal(path.isAbsolute(result.config.MYTHOS_VAULT_ROOT), true, 'default vault root must not depend on cwd');
    assert.equal(result.config.MYTHOS_VAULT_ROOT, path.join(__dirname, '..', 'vault'));
    assert.equal(result.config.MYTHOS_TICK_MS, 1000);
    assert.equal(result.config.MYTHOS_IDLE_SALIENCE, 0.3);
    assert.equal(result.config.MYTHOS_DRY_RUN, false);
    assert.equal(result.config.LOG_LEVEL, 'info');
    assert.equal(result.config.AUTONOMOUS_MAX_TIER, 2);
    assert.equal(result.config.SHUTDOWN_MS, 10000);
  });

  it('build-driver knobs (forge-runner.js) default sensibly and accept overrides', () => {
    // RENAMED HERMES_* -> DSH_* by W6 (2026-08-22).
    const defaults = validate({}, SCHEMA);
    assert.equal(defaults.config.DSH_PLAN_TIMEOUT_MS, 300000);
    assert.equal(defaults.config.DSH_BUILD_TIMEOUT_MS, 1800000);
    assert.equal(defaults.config.DSH_POLL_MS, 2000);
    assert.equal(defaults.config.DSH_BUILD_TERMINAL_ENV, 'local');

    const overridden = validate({ DSH_BUILD_TIMEOUT_MS: '600000', DSH_POLL_MS: '500' }, SCHEMA);
    assert.equal(overridden.ok, true);
    assert.equal(overridden.config.DSH_BUILD_TIMEOUT_MS, 600000);
    assert.equal(overridden.config.DSH_POLL_MS, 500);
  });

  it('the old HERMES_* build-driver keys are NOT accepted as aliases', () => {
    // Deliberate, and the reason it is pinned: a silently-accepted
    // HERMES_BUILD_TIMEOUT_MS would look like it was working while forge-runner
    // read the DSH_ default instead. An unknown key must not become a live one.
    const res = validate({ HERMES_BUILD_TIMEOUT_MS: '600000' }, SCHEMA);
    assert.equal(res.config.HERMES_BUILD_TIMEOUT_MS, undefined);
    assert.equal(res.config.DSH_BUILD_TIMEOUT_MS, 1800000, 'the DSH_ default must still apply');
  });

  it('overrides defaults with env values', () => {
    const result = validate({ MYTHOS_PORT: '3000', MYTHOS_NAME: 'GALACTUS', LOG_LEVEL: 'debug' }, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.MYTHOS_PORT, 3000);
    assert.equal(result.config.MYTHOS_NAME, 'GALACTUS');
    assert.equal(result.config.LOG_LEVEL, 'debug');
  });

  it('coerces boolean strings', () => {
    const result = validate({ MYTHOS_DRY_RUN: 'true' }, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.MYTHOS_DRY_RUN, true);
  });

  it('collects errors for invalid values', () => {
    const result = validate({ MYTHOS_PORT: 'not-a-number', LOG_LEVEL: 'trace' }, SCHEMA);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 2);
    assert.ok(result.errors.some(e => e.includes('Invalid number')));
    assert.ok(result.errors.some(e => e.includes('not in')));
  });

  it('enforces min/max for numbers', () => {
    const result = validate({ MYTHOS_PORT: '80', MYTHOS_TICK_MS: '50' }, SCHEMA);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('below minimum')));
  });

  it('returns frozen config', () => {
    const result = validate({}, SCHEMA);
    assert.throws(() => { result.config.MYTHOS_PORT = 9999; }, TypeError);
  });

  it('allows empty string provider keys', () => {
    const result = validate({ GROQ_API_KEY: '' }, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.GROQ_API_KEY, '');
  });

  it('SCHEMA has expected key count', () => {
    const keys = Object.keys(SCHEMA);
    assert.ok(keys.length >= 20, `Expected >=20 schema keys, got ${keys.length}`);
  });

  it('wake-word keys default to disabled with the documented threshold', () => {
    const result = validate({}, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.WAKEWORD_ENABLED, false);
    assert.equal(result.config.WAKEWORD_THRESHOLD, 0.5);
  });

  it('wake-word keys accept env overrides within range', () => {
    const result = validate({ WAKEWORD_ENABLED: 'true', WAKEWORD_THRESHOLD: '0.8' }, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.WAKEWORD_ENABLED, true);
    assert.equal(result.config.WAKEWORD_THRESHOLD, 0.8);
  });

  it('rejects WAKEWORD_THRESHOLD outside its 0.1-0.95 range', () => {
    const tooLow = validate({ WAKEWORD_THRESHOLD: '0.05' }, SCHEMA);
    assert.equal(tooLow.ok, false);
    assert.ok(tooLow.errors.some((e) => e.includes('below minimum')));

    const tooHigh = validate({ WAKEWORD_THRESHOLD: '0.99' }, SCHEMA);
    assert.equal(tooHigh.ok, false);
    assert.ok(tooHigh.errors.some((e) => e.includes('above maximum')));
  });

  it('planner keys default to enabled with documented hours/cadence', () => {
    const result = validate({}, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.PLANNER_ENABLED, true);
    assert.equal(result.config.PLANNER_MORNING_HOUR, 9);
    assert.equal(result.config.PLANNER_EVENING_HOUR, 21);
    assert.equal(result.config.PLANNER_CHECKIN_EVERY_MS, 10800000);
  });

  it('planner keys accept env overrides within range', () => {
    const result = validate({ PLANNER_ENABLED: 'false', PLANNER_MORNING_HOUR: '7', PLANNER_EVENING_HOUR: '22', PLANNER_CHECKIN_EVERY_MS: '3600000' }, SCHEMA);
    assert.equal(result.ok, true);
    assert.equal(result.config.PLANNER_ENABLED, false);
    assert.equal(result.config.PLANNER_MORNING_HOUR, 7);
    assert.equal(result.config.PLANNER_EVENING_HOUR, 22);
    assert.equal(result.config.PLANNER_CHECKIN_EVERY_MS, 3600000);
  });

  // F5 (go-live proof plan, 2026-08-08): VOICE_S2S_ENABLED must default to
  // OFF. Gemini Live is metered per open session and bills while the socket is
  // open, and .env.example has always documented it as "Opt-in and OFF by
  // default" — the schema default of true contradicted the docs, so a fresh
  // deploy with a GOOGLE_API_KEY billed Live sessions with no explicit opt-in.
  it('VOICE_S2S_ENABLED defaults to OFF (Live is opt-in) and accepts a true override', () => {
    const defaults = validate({}, SCHEMA);
    assert.equal(defaults.ok, true);
    assert.equal(defaults.config.VOICE_S2S_ENABLED, false,
      'a fresh install must NOT open billed Live sessions without an explicit opt-in');

    const overridden = validate({ VOICE_S2S_ENABLED: 'true' }, SCHEMA);
    assert.equal(overridden.ok, true);
    assert.equal(overridden.config.VOICE_S2S_ENABLED, true);
  });

  // PIN_SESSION_ENFORCE was a real setting until the PIN was removed on
  // 2026-09-23. It is RETIRED, not deleted from memory: an operator's .env may
  // still carry it, and main.js names it at boot rather than ignoring it silently.
  it('the PIN settings are retired: absent from the schema, present in RETIRED_SETTINGS', () => {
    const { RETIRED_SETTINGS } = require('../src/core/config/schema');
    for (const key of ['PIN_SESSION_ENFORCE', 'PIN_SESSION_TTL_MS']) {
      assert.equal(key in SCHEMA, false, key + ' must not be a live setting');
      assert.equal(typeof RETIRED_SETTINGS[key], 'string', key + ' must say why it does nothing');
    }
    assert.equal(validate({ PIN_SESSION_ENFORCE: 'true' }, SCHEMA).config.PIN_SESSION_ENFORCE, undefined,
      'setting it changes nothing');
  });

  it('rejects PLANNER_MORNING_HOUR outside its 0-23 range and PLANNER_CHECKIN_EVERY_MS below its floor', () => {
    const badHour = validate({ PLANNER_MORNING_HOUR: '24' }, SCHEMA);
    assert.equal(badHour.ok, false);
    assert.ok(badHour.errors.some((e) => e.includes('above maximum')));

    const badCadence = validate({ PLANNER_CHECKIN_EVERY_MS: '1000' }, SCHEMA);
    assert.equal(badCadence.ok, false);
    assert.ok(badCadence.errors.some((e) => e.includes('below minimum')));
  });
});
