'use strict';

// test/webcam-sight-regression.test.js — the 2026-08-10 "webcam sight" incident.
//
// What happened, from vault/Audit/2026-08-10.jsonl and the server log: the
// operator asked "can you see me, Jarvis?" and MYTHOS answered from a DESKTOP
// SCREENSHOT. camera_look was withheld from the Live voice allowlist, so the
// model called screen_look with query "Can I see the operator through the
// webcam?", described the HUD's own camera-preview panel inside that screenshot,
// concluded it could see the operator, contradicted its own correct "I can't get
// a live video feed" of thirty seconds earlier, and went on to invent "a black
// smartphone" and then "a small dog" for "what am I holding?". screen_look's OCR
// grounding check rejected the dog — 16 SECONDS after the model had already
// spoken, because a Live tool gets 1500ms before the model is told "started".
//
// Meanwhile 5 of 16 turns raised live-turn-no-user-transcript, every one of them
// a turn the operator never spoke in, and each was recited aloud mid-conversation
// as a raw event name.
//
// Every assertion below pins one link in that chain. They are grouped by the
// defect they guard, and each group's failure would let a specific part of the
// incident happen again.

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { DEFAULT_ALLOWLIST, buildFunctionDeclarations } = require('../src/core/voice/live-tools');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const fromPc = require('../src/core/effectors/from-pc');
const { visionThink, DEFAULT_VISION_TIMEOUT_MS } = require('../src/core/effectors/vision-call');
const { SCHEMA } = require('../src/core/config/schema');

function toolNamed(tools, name) {
  return (tools || []).find((t) => t.name === name) || null;
}

// ---------------------------------------------------------------------------
// Defect 1 — voice could not reach the webcam at all.
// ---------------------------------------------------------------------------
describe('the webcam is reachable from voice', () => {
  it('camera_look is on the Live allowlist (it was WITHHELD, which is the root cause)', () => {
    assert.ok(
      DEFAULT_ALLOWLIST.includes('camera_look'),
      'camera_look must be reachable from a Live session — withholding it is what made the model '
      + 'substitute screen_look for a webcam question on 2026-08-10',
    );
  });

  it('camera_on is on the Live allowlist, so "can you see me" with the camera off can ASK', () => {
    assert.ok(DEFAULT_ALLOWLIST.includes('camera_on'));
  });

  it('neither camera tool is also in the exempt list (a name in both is a silent withhold)', () => {
    const liveTools = require('../src/core/voice/live-tools');
    const exempt = liveTools.VOICE_ALLOWLIST_EXEMPT || [];
    for (const name of ['camera_look', 'camera_on']) {
      assert.ok(!exempt.includes(name), `${name} must not appear in VOICE_ALLOWLIST_EXEMPT`);
    }
  });

  it('both are real registered dashboard tools, not dead allowlist entries', () => {
    const built = buildTools({ config: {}, fs: null });
    assert.ok(toolNamed(built.TOOLS, 'camera_look'), 'camera_look must exist as a tool');
    assert.ok(toolNamed(built.TOOLS, 'camera_on'), 'camera_on must exist as a tool');
  });

  it('they survive Gemini function-declaration building (an unbuildable tool is unreachable)', () => {
    const built = buildTools({ config: {}, fs: null });
    const hub = { catalog: () => built.TOOLS.map((t) => ({ name: t.name, description: t.description, params: t.params || {} })) };
    const { declarations, withheld } = buildFunctionDeclarations(hub);
    const names = declarations.map((d) => d.name);
    assert.ok(names.includes('camera_look'), 'camera_look must be DECLARED to Gemini');
    assert.ok(names.includes('camera_on'), 'camera_on must be DECLARED to Gemini');
    // The withheld list is what the boot log printed on 2026-08-10 with
    // camera_look in it. Neither may appear there again.
    assert.ok(!withheld.includes('camera_look'));
    assert.ok(!withheld.includes('camera_on'));
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — opening a camera must always need the operator's word.
// ---------------------------------------------------------------------------
describe('camera_on cannot open a camera without a confirm', () => {
  it('is tier 3 (camera_look stays tier 0 — it is a read)', () => {
    assert.equal(TIER_TABLE['camera_on'], 3);
    assert.equal(TIER_TABLE['camera_look'], 0);
  });

  it('is NEVER_TRUSTABLE, so no trust/grant path can auto-allow it', () => {
    // Asserted through the real construction path rather than by reading the
    // literal: TRUSTED_TOOLS=camera_on must be REJECTED and reported by name.
    const anomalies = [];
    const bus = { emit: (type, payload) => anomalies.push({ type, payload }), subscribe: () => () => {} };
    const { createLeash } = require('../src/core/leash');
    createLeash({
      bus,
      config: { TRUSTED_TOOLS: 'camera_on', AUTONOMOUS_MAX_TIER: 2 },
      identity: { checkBoundary: () => ({ allowed: true }), getMaxAutonomousTier: () => 2 },
      auditWriter: { write: () => true },
      goals: { get: () => null },
      effectors: { get: () => ({ name: 'camera_on' }) },
    });
    const ignored = anomalies.find((a) => a.payload && a.payload.kind === 'leash-trusted-tool-ignored'
      && a.payload.target === 'camera_on');
    assert.ok(ignored, 'TRUSTED_TOOLS=camera_on must be rejected and the rejection emitted by name');
    assert.match(String(ignored.payload.evidence.reason), /never-trustable/);
  });

  it('reports honestly when there is no dashboard to ask', async () => {
    const built = buildTools({ config: {}, fs: null });
    const cameraOn = toolNamed(built.TOOLS, 'camera_on');
    const res = await cameraOn.fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result || ''), /no UI is connected|cannot reach/i);
  });

  it('reports the camera as OFF when the HUD says it did not start — never a hopeful success', async () => {
    const built = buildTools({ config: {}, fs: null });
    built.setCameraPowerProvider(async () => ({ on: false, state: 'off', reason: 'permission denied' }));
    const res = await toolNamed(built.TOOLS, 'camera_on').fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result || ''), /permission denied/);
  });

  it('reports on:true only when the HUD confirms the loop is watching', async () => {
    const built = buildTools({ config: {}, fs: null });
    built.setCameraPowerProvider(async () => ({ on: true, state: 'watching', reason: '' }));
    const res = await toolNamed(built.TOOLS, 'camera_on').fn({});
    assert.equal(res.ok, true);
    assert.equal(res.result.camera, 'on');
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — the two pairs of eyes must not be confusable.
// ---------------------------------------------------------------------------
describe('screen_look and camera_look each say what they are NOT', () => {
  const pcScreenLook = toolNamed(fromPc.TOOLS, 'screen_look');

  it('screen_look\'s description denies being a camera and names camera_look', () => {
    const d = String(pcScreenLook.description);
    assert.match(d, /NOT a camera|not a camera/);
    assert.match(d, /camera_look/, 'it must name the tool that CAN see the operator');
  });

  it('camera_look\'s description denies being the screen and names screen_look', () => {
    const built = buildTools({ config: {}, fs: null });
    const d = String(toolNamed(built.TOOLS, 'camera_look').description);
    assert.match(d, /WEBCAM|webcam/);
    assert.match(d, /screen_look/);
    assert.match(d, /camera_on/, 'it must say how to get the camera turned on');
  });

  // THE assertion of this file. The incident query was verbatim "What is the
  // user holding in the webcam frame?" and the model answered it from a desktop
  // screenshot. The framing has to reach the vision prompt regardless of what the
  // caller asked, so the image cannot be mistaken for a camera frame.
  //
  // Driven through the real pc-child mock harness (the same shape
  // test/screen-look-validation.test.js uses) rather than asserted on source: it
  // is the prompt that actually goes out that matters.
  it('screen_look TELLS THE VISION MODEL the image is a screen, whatever was asked', async () => {
    const Module = require('node:module');
    const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
    const originalRequire = Module.prototype.require;
    const prompts = [];
    const pc = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (c) => {
        if (c.cmd === 'screen_look') return { ok: true, result: { base64: 'ZmFrZS1wbmc=', width: 1920, height: 1080 } };
        if (c.cmd === 'screen_read_text') return { ok: true, result: { text: 'MYTHOS AGENT ACTIONS screen look', lineCount: 1 } };
        return { ok: true, result: {} };
      },
    };
    const brain = {
      think: async (req) => {
        const parts = req.messages[0].content;
        prompts.push(parts.find((p) => p.type === 'text').text);
        return { content: 'The MYTHOS agent actions screen.', offline: false };
      },
    };
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/pc-child') return pc;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[FROM_PC_PATH];
    try {
      const m = require(FROM_PC_PATH);
      m.registerFromPc({ register: () => {}, effectors: new Map() },
        { brain, fs: { readJSON: () => null, writeJSON: () => {} }, visionChainFor: ALIVE_CHAIN_STUB });
      await m.screen_look({ query: 'What is the user holding in the webcam frame?' });
    } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[FROM_PC_PATH];
    }

    assert.equal(prompts.length, 1, 'the vision model must have been asked exactly once');
    const prompt = prompts[0];
    assert.match(prompt, /COMPUTER SCREEN/, 'the prompt must state that the image is the screen');
    assert.match(prompt, /not a webcam or camera image/i);
    assert.match(prompt, /does not show the operator/i);
    // And the caller's question is still passed through — the framing constrains
    // the answer, it does not discard what was asked.
    assert.match(prompt, /What is the user holding in the webcam frame\?/);
  });
});

// ---------------------------------------------------------------------------
// Defect 4 — a camera description is not a fact.
// ---------------------------------------------------------------------------
describe('camera_look reports provenance rather than asserting', () => {
  function ctxWithVision(content) {
    return {
      config: {},
      fs: null,
      brain: { think: async () => ({ content, provider: 'test', model: 'test-vision' }) },
      visionChainFor: ALIVE_CHAIN_STUB,
    };
  }

  it('carries an unverifiable-single-frame note alongside the description', async () => {
    const built = buildTools(ctxWithVision('A person holding a mug.'));
    built.setCameraFrameProvider(async () => 'ZmFrZS1qcGVn');
    const res = await toolNamed(built.TOOLS, 'camera_look').fn({ query: 'what am I holding?' });
    assert.equal(res.ok, true);
    assert.equal(res.result.description, 'A person holding a mug.');
    assert.equal(res.result.confidence, 'unverified-vision');
    assert.match(String(res.result.note), /cannot be verified/i);
    assert.match(String(res.result.note), /LOOKED LIKE|looked like/);
  });

  it('when the camera is off, says so AND points at camera_on', async () => {
    // The incident's dead end: with no way to ask for the camera, the model went
    // looking for another way to see and found the screen.
    const built = buildTools(ctxWithVision('unused'));
    built.setCameraFrameProvider(async () => null);
    const res = await toolNamed(built.TOOLS, 'camera_look').fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result || ''), /camera is off/i);
    assert.match(String(res.error || res.result || ''), /camera_on/);
  });

  it('a vision timeout describes NOTHING', async () => {
    const built = buildTools({
      config: { VISION_CALL_TIMEOUT_MS: 1000 },
      fs: null,
      brain: { think: () => new Promise(() => {}) }, // never settles
      visionChainFor: ALIVE_CHAIN_STUB,
    });
    built.setCameraFrameProvider(async () => 'ZmFrZS1qcGVn');
    const res = await toolNamed(built.TOOLS, 'camera_look').fn({});
    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result || ''), /did not answer in time/i);
    assert.match(String(res.error || res.result || ''), /do not describe anything/i);
  });
});

// ---------------------------------------------------------------------------
// Defect 5 — the vision call was unbounded and unobservable.
// ---------------------------------------------------------------------------
// Wave 5 (2026-08-13): visionThink's lane preflight (chainFor()) is only
// meaningful against the REAL registry the production brain facade also
// queries — a test brain here is a stand-in that never touches that
// registry, so every visionThink() call below stubs chainFor to report the
// lane alive, exactly as this repo's real registry does when a key is
// actually configured. The preflight's own behavior is covered separately
// in test/vision-call-lane-preflight.test.js.
const ALIVE_CHAIN_STUB = async () => [{ provider: 'test', model: 'test-vision' }];

describe('visionThink — bounded and instrumented', () => {
  it('logs one vision.call line with provider, model and duration', async () => {
    const lines = [];
    const brain = { think: async () => ({ content: 'a screen', provider: 'mistral', model: 'mistral-small-latest' }) };
    const res = await visionThink(brain, {
      prompt: 'q', b64: 'x', source: 'screen-look', chainFor: ALIVE_CHAIN_STUB,
      logger: { info: (msg, fields) => lines.push({ msg, fields }) },
    });
    assert.equal(res.content, 'a screen');
    const call = lines.find((l) => l.msg === 'vision.call');
    assert.ok(call, 'a vision.call line must be emitted — nothing recorded provider/model before this');
    assert.equal(call.fields.provider, 'mistral');
    assert.equal(call.fields.model, 'mistral-small-latest');
    assert.equal(call.fields.ok, true);
    assert.equal(typeof call.fields.ms, 'number');
  });

  it('resolves timedOut instead of hanging, and says so in the log', async () => {
    const lines = [];
    const res = await visionThink({ think: () => new Promise(() => {}) }, {
      prompt: 'q', b64: 'x', source: 'camera-look', timeoutMs: 50, chainFor: ALIVE_CHAIN_STUB,
      logger: { info: (msg, fields) => lines.push({ msg, fields }) },
    });
    assert.equal(res.timedOut, true);
    assert.equal(res.content, null);
    const call = lines.find((l) => l.msg === 'vision.call');
    assert.equal(call.fields.timedOut, true);
    assert.equal(call.fields.ok, false);
  });

  it('a rejecting think does not become an unhandled rejection after a timeout', async () => {
    // The underlying call is not cancellable, so its later rejection must be
    // absorbed — an unhandled rejection would take the process down well after
    // the look was already reported as timed out.
    let reject;
    const res = await visionThink({ think: () => new Promise((_, r) => { reject = r; }) }, {
      prompt: 'q', b64: 'x', timeoutMs: 30, chainFor: ALIVE_CHAIN_STUB,
    });
    assert.equal(res.timedOut, true);
    reject(new Error('late provider failure'));
    await new Promise((r) => setTimeout(r, 20)); // would crash here if unabsorbed
  });

  it('works with no logger at all (tests and headless construction)', async () => {
    const res = await visionThink({ think: async () => ({ content: 'ok' }) }, { prompt: 'q', b64: 'x', chainFor: ALIVE_CHAIN_STUB });
    assert.equal(res.content, 'ok');
  });

  it('the default bound is far below CHAIN_ATTEMPT_TIMEOUT_MS', () => {
    // 30s per attempt across a seven-model lane is how one look reached 63s.
    assert.ok(DEFAULT_VISION_TIMEOUT_MS < SCHEMA.CHAIN_ATTEMPT_TIMEOUT_MS.default);
    assert.equal(SCHEMA.VISION_CALL_TIMEOUT_MS.default, 12000);
  });
});

describe('the vision tools ack instantly instead of letting the model guess', () => {
  it('screen_look and camera_look are SLOW_TOOLS', () => {
    // Membership is about DURATION (that list's own rule). Real measurements:
    // 16s and 63s, against a 1500ms ack deadline.
    const fs = require('fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'voice', 'live-tool-adapter.js'), 'utf8');
    // SLOW_TOOLS is factory-local, so this reads the declaration itself: from
    // `const SLOW_TOOLS` to the closing brace of that object literal. Slicing to
    // the first mention of TOOL_ACK_DEADLINE_MS does NOT work — the module header
    // names it long before the list.
    const start = src.indexOf('const SLOW_TOOLS');
    assert.ok(start > 0, 'SLOW_TOOLS must still exist');
    const slowBlock = src.slice(start, src.indexOf('};', start));
    assert.match(slowBlock, /screen_look:\s*true/);
    assert.match(slowBlock, /camera_look:\s*true/);
  });
});
