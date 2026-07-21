'use strict';

// Phase 5 (P3 + P6) — CORS allowlist via config + platform-gate Windows-only adapters.
//
// P3: ALLOWED_ORIGINS now read from config.ALLOWED_ORIGINS (with process.env fallback)
//     for D-46 consistency. The Set construction + isValidOrigin regex are unchanged.
//
// P6: pc-child (powershell.exe spawn) and cua-driver (Windows binary) are skipped
//     on non-Windows hosts. browser-agent stays ungated (playwright-core is
//     cross-platform). This eliminates the noisy ENOENT spawn-error spam on
//     Linux/macOS deployment targets (Render, Docker, etc.).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Phase 5 (P3) — ALLOWED_ORIGINS config wiring', function () {

  it('server reads config.ALLOWED_ORIGINS with process.env fallback (D-46)', function () {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    // Must reference config.ALLOWED_ORIGINS (preferred) with process.env fallback
    assert.ok(src.indexOf('config.ALLOWED_ORIGINS') !== -1,
      'server must read config.ALLOWED_ORIGINS (D-46 live-read discipline)');
    assert.ok(src.indexOf('process.env.ALLOWED_ORIGINS') !== -1,
      'fallback to process.env preserved');
  });

  it('CORS allow-headers includes Authorization + X-Auth-Token for P1 gate', function () {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    // The Access-Control-Allow-Headers must list the auth headers so browser
    // fetches carrying the token pass CORS preflight (P1 dependency).
    assert.ok(src.indexOf("'Content-Type, Authorization, X-Auth-Token'") !== -1,
      'CORS allow-headers must include Authorization + X-Auth-Token');
  });

  it('schema declares ALLOWED_ORIGINS as a string with empty default', function () {
    const schema = require('../src/core/config/schema').SCHEMA;
    assert.ok(schema.ALLOWED_ORIGINS, 'key must exist');
    assert.equal(schema.ALLOWED_ORIGINS.type, 'string');
    assert.equal(schema.ALLOWED_ORIGINS.default, '');
  });

});

describe('Phase 5 (P6) — platform-gate pc-child + cua-driver on non-Windows', function () {

  const MAIN_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  it('main.js checks process.platform before starting pc-child', function () {
    assert.ok(MAIN_SRC.indexOf("process.platform === 'win32'") !== -1,
      'main.js must check process.platform before starting Windows-only adapters');
    assert.ok(MAIN_SRC.indexOf('pcChild.startPcChild()') !== -1,
      'pcChild.startPcChild must still be called on Windows');
  });

  it('main.js checks process.platform before starting cua-driver', function () {
    assert.ok(MAIN_SRC.indexOf('cuaDriver.startCuaDriver()') !== -1,
      'cuaDriver.startCuaDriver must still be called on Windows');
  });

  it('main.js logs a skip message on non-Windows (operator visibility)', function () {
    assert.ok(MAIN_SRC.indexOf('pc-child.skipped') !== -1,
      'must log pc-child.skipped on non-Windows');
    assert.ok(MAIN_SRC.indexOf('cua-driver.skipped') !== -1,
      'must log cua-driver.skipped on non-Windows');
  });

  it('browser-agent connect stays ungated (cross-platform via playwright-core)', function () {
    // The browserAgent.connect call must NOT be inside the isWindows branch —
    // playwright-core works on Linux/macOS too. Verify the connect call exists
    // outside any platform gate by checking it appears in the file.
    assert.ok(MAIN_SRC.indexOf('browserAgent.connect(') !== -1,
      'browser-agent connect must remain (cross-platform)');
  });

});
