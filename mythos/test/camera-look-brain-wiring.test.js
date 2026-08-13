'use strict';

// test/camera-look-brain-wiring.test.js — Wave 5 (2026-08-13).
//
// camera_look's own code reads `var brain = (ctx && ctx.brain) || null;` and,
// when null, fails with "Camera frame captured but no vision brain is
// available" — sounding like lane exhaustion (all vision providers down) but
// actually a straightforward wiring gap: main.js's registerFromDashboard()
// call never included a `brain` key in its ctx object at all, unlike its
// sibling registerFromPc() call 20 lines earlier (which DOES pass
// `brain: brain` for screen_look). NIM_API_KEY being present never mattered
// — the brain reference camera_look reads was always null in production.
//
// main.js's boot sequence isn't unit-tested directly (too much to mock for
// one wiring line) — this is a source-shape assertion, the same class the
// repo's Electron lesson in CLAUDE.md already established as the right tool
// for a wiring gap like this: it proves the call site passes `brain`, so a
// future edit that drops it again fails a test instead of only degrading
// silently in production.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const src = fs.readFileSync(MAIN_PATH, 'utf8');

describe('Wave 5: registerFromDashboard is wired with a real brain reference', () => {
  it('the registerFromDashboard call site passes brain: brain', () => {
    const callIdx = src.indexOf('registerFromDashboard(hub, {');
    assert.ok(callIdx !== -1, 'the registerFromDashboard call site must still exist');
    const closeIdx = src.indexOf('});', callIdx);
    const ctxBlock = src.slice(callIdx, closeIdx);
    assert.match(ctxBlock, /brain:\s*brain\b/,
      'camera_look reads ctx.brain — omitting this key here is the exact regression ' +
      'that made camera_look report "no vision brain" while NIM_API_KEY was configured and present');
  });

  it('registerFromPc (screen_look\'s sibling) still passes brain too, so this is not a new asymmetry', () => {
    const callIdx = src.indexOf('registerFromPc(hub, {');
    assert.ok(callIdx !== -1);
    const closeIdx = src.indexOf('});', callIdx);
    const ctxBlock = src.slice(callIdx, closeIdx);
    assert.match(ctxBlock, /brain:\s*brain\b/);
  });
});

describe('Wave 5: camera_look actually uses the brain it is given (unit-level, not just wiring)', () => {
  it('with a real brain in ctx, camera_look reaches brain.think and returns its description', async () => {
    const { buildTools } = require('../src/core/effectors/from-dashboard');
    let thinkCalled = false;
    const built = buildTools({
      config: {},
      fs: null,
      brain: { think: async () => { thinkCalled = true; return { content: 'a tidy desk', provider: 'test', model: 'test-vision' }; } },
      visionChainFor: async () => [{ provider: 'test', model: 'test-vision' }],
    });
    built.setCameraFrameProvider(async () => 'ZmFrZS1qcGVn');
    const tool = built.TOOLS.find((t) => t.name === 'camera_look');
    const res = await tool.fn({ query: 'what is on the desk?' });
    assert.equal(thinkCalled, true, 'a wired brain must actually be called — this is what production was missing');
    assert.equal(res.ok, true);
    assert.equal(res.result.description, 'a tidy desk');
  });

  it('with NO brain in ctx (the regression state), camera_look fails honestly rather than crashing', async () => {
    const { buildTools } = require('../src/core/effectors/from-dashboard');
    const built = buildTools({ config: {}, fs: null }); // no brain key at all
    built.setCameraFrameProvider(async () => 'ZmFrZS1qcGVn');
    const tool = built.TOOLS.find((t) => t.name === 'camera_look');
    const res = await tool.fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.result), /no vision brain/i);
  });
});
