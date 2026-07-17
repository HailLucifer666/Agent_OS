'use strict';

// Phase 2 Jarvis upgrade — ambient_awareness voice/tool command. Registered in
// from-pc.js beside screen_look (keeps cohesion with the other pc-child/
// vision-adjacent tools). It flips the running screen-sensor via an injected
// handle (setScreenSensorHandle), mirroring from-dashboard.js's
// setAskAgentDispatch/setCameraFrameProvider closure-wiring precedent.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const fromPc = require('../src/core/effectors/from-pc');

function fakeSensorHandle() {
  let running = false;
  return {
    start: () => { running = true; },
    stop: () => { running = false; },
    isRunning: () => running,
  };
}

describe('ambient_awareness tool (from-pc.js)', () => {
  beforeEach(() => {
    // Reset module-scoped handle between tests — mirrors how registerFromPc()
    // re-wires `brain`/`vaultFs` fresh on every call.
    fromPc.setScreenSensorHandle(null);
  });

  it('registered in TOOLS with tier-appropriate metadata', () => {
    const tool = fromPc.TOOLS.find((t) => t.name === 'ambient_awareness');
    assert.ok(tool, 'ambient_awareness must be registered in from-pc.js TOOLS');
    assert.equal(tool.danger, false);
    assert.equal(typeof tool.fn, 'function');
    assert.match(tool.description, /watch my screen/i);
  });

  it('status reports disabled/not-running when no sensor handle is wired (boot-disabled path)', async () => {
    const result = await fromPc.ambient_awareness({ action: 'status' });
    assert.equal(result.ok, true);
    assert.equal(result.result.enabled, false);
    assert.equal(result.result.running, false);
  });

  it('on/off fail honestly (no throw) when no sensor handle is wired', async () => {
    const onResult = await fromPc.ambient_awareness({ action: 'on' });
    assert.equal(onResult.ok, false);
    assert.match(onResult.result, /not available/i);

    const offResult = await fromPc.ambient_awareness({ action: 'off' });
    assert.equal(offResult.ok, false);
  });

  it('an unknown action fails with a clear message', async () => {
    const result = await fromPc.ambient_awareness({ action: 'bogus' });
    assert.equal(result.ok, false);
    assert.match(result.result, /Invalid action/);
  });

  it('once a sensor handle is wired: "on" starts it and isRunning() flips true', async () => {
    const handle = fakeSensorHandle();
    fromPc.setScreenSensorHandle(handle);

    assert.equal(handle.isRunning(), false);
    const result = await fromPc.ambient_awareness({ action: 'on' });
    assert.equal(result.ok, true);
    assert.equal(result.result.running, true);
    assert.equal(handle.isRunning(), true);
  });

  it('"off" stops the wired sensor and isRunning() flips false', async () => {
    const handle = fakeSensorHandle();
    fromPc.setScreenSensorHandle(handle);
    handle.start();

    const result = await fromPc.ambient_awareness({ action: 'off' });
    assert.equal(result.ok, true);
    assert.equal(result.result.running, false);
    assert.equal(handle.isRunning(), false);
  });

  it('"status" reports the wired sensor\'s live running state without changing it', async () => {
    const handle = fakeSensorHandle();
    fromPc.setScreenSensorHandle(handle);
    handle.start();

    const result = await fromPc.ambient_awareness({ action: 'status' });
    assert.equal(result.ok, true);
    assert.equal(result.result.running, true);
    assert.equal(handle.isRunning(), true, 'status must be read-only — must not stop the sensor');
  });

  it('defaults to "status" when action is omitted', async () => {
    const handle = fakeSensorHandle();
    fromPc.setScreenSensorHandle(handle);
    const result = await fromPc.ambient_awareness({});
    assert.equal(result.ok, true);
    assert.equal(result.result.running, false);
  });

  it('registerFromPc() returns setScreenSensorHandle for main.js to wire', () => {
    const hubMock = { register: () => {} };
    const registration = fromPc.registerFromPc(hubMock, { brain: null, fs: null });
    assert.equal(typeof registration.setScreenSensorHandle, 'function');
    assert.equal(typeof registration.count, 'number');
    assert.ok(registration.count > 0);
  });
});
