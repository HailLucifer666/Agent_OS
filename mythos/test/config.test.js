'use strict';

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
    assert.equal(result.config.MYTHOS_VAULT_ROOT, './vault');
    assert.equal(result.config.MYTHOS_TICK_MS, 1000);
    assert.equal(result.config.MYTHOS_IDLE_SALIENCE, 0.3);
    assert.equal(result.config.MYTHOS_DRY_RUN, false);
    assert.equal(result.config.LOG_LEVEL, 'info');
    assert.equal(result.config.AUTONOMOUS_MAX_TIER, 2);
    assert.equal(result.config.SHUTDOWN_MS, 10000);
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
});
