'use strict';

// WAVE 4 — the tool that was supposed to catch the lie was itself lying.
//
// Two real replies from 2026-07-31, both passed straight through to the operator:
//
//   11:21:51  {"description":"https://i.imgur.com/SYP5Cfi.png"}
//             A bare, almost certainly hallucinated URL. Not an observation.
//
//   11:28:36  "When you type text in Notepad, it immediately appears in the
//             document area..." — a generic tutorial paragraph about how Notepad
//             works, produced while the actual screen showed an EMPTY document.
//             MYTHOS relayed it as visual confirmation that the typing worked.
//
// screen_look validated nothing. OCR is now the ground truth and the vision
// model's prose is commentary; a cheap token overlap catches both failure modes
// without a second model call.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

const originalRequire = Module.prototype.require;
function withPc(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

// ocrText: what the screen literally reads. visionReply: what the model says.
function scenario(ocrText, visionReply) {
  const pc = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'screen_look') return { ok: true, result: { base64: 'ZmFrZS1wbmc=', width: 1920, height: 1080 } };
      if (c.cmd === 'screen_read_text') {
        if (ocrText === null) return { ok: false, error: 'no OCR language pack installed' };
        return { ok: true, result: { text: ocrText, lineCount: String(ocrText).split('\n').length } };
      }
      return { ok: true, result: {} };
    },
  };
  const brain = { think: async () => ({ content: visionReply, offline: false }) };
  return { pc, brain };
}

async function look(ocrText, visionReply, query) {
  const { pc, brain } = scenario(ocrText, visionReply);
  return withPc(pc, async (m) => {
    // registerFromPc is how brain gets injected in the real boot.
    const hub = { register: () => {}, effectors: new Map() };
    m.registerFromPc(hub, { brain, fs: { readJSON: () => null, writeJSON: () => {} } });
    return m.screen_look({ query: query || 'what is on screen?' });
  });
}

const EMPTY_NOTEPAD_OCR = 'Untitled - Notepad\nFile Edit View\nLn 1, Col 1\n100%\nWindows (CRLF)\nUTF-8';

describe('WAVE 4 — screen_look cannot fabricate', () => {
  it('THE 11:21 CASE: a bare URL is rejected, not relayed as a description', async () => {
    const res = await look(EMPTY_NOTEPAD_OCR, 'https://i.imgur.com/SYP5Cfi.png');
    assert.equal(res.ok, false);
    assert.match(String(res.result || res.error), /bare URL|fabrication/i);
  });

  it('an empty vision reply is rejected', async () => {
    const res = await look(EMPTY_NOTEPAD_OCR, '   ');
    assert.equal(res.ok, false);
    assert.match(String(res.result || res.error), /empty description|nothing about the screen/i);
  });

  it('THE 11:28 CASE: generic prose about the app, sharing nothing with the screen, is rejected', async () => {
    const tutorial = 'When you type text in Notepad, it immediately appears in the document area of the ' +
      'window. Any characters entered through the keyboard become part of the saved contents.';
    const res = await look('Slack\nAlex Rivera\nyesterday\nHuddle\nThreads\nMentions', tutorial);
    assert.equal(res.ok, false, 'this was relayed as visual confirmation of typing that never happened');
    assert.match(String(res.result || res.error), /does not match the screen/i);
  });

  it('a genuinely grounded description passes and carries literal screen text', async () => {
    const res = await look(EMPTY_NOTEPAD_OCR, 'An empty Notepad window titled Untitled, with the cursor at Ln 1, Col 1.');
    assert.equal(res.ok, true);
    assert.equal(res.result.grounded, true);
    assert.ok(Array.isArray(res.result.ocrSample), 'the voice layer needs literal text to quote');
    assert.ok(res.result.ocrSample.some((l) => /Untitled - Notepad/.test(l)));
  });

  it('the ocrSample is what proves the empty-Notepad case, and it contains no typed text', async () => {
    // The Wave 4 acceptance case: asked to confirm text is typed, the honest
    // answer must be derivable from the result rather than from the prose.
    const res = await look(EMPTY_NOTEPAD_OCR, 'A Notepad window is open, showing an empty document with no text.');
    assert.equal(res.ok, true);
    const joined = res.result.ocrSample.join('\n');
    assert.doesNotMatch(joined, /Hi Alex/, 'nothing was typed, and OCR must not show it');
    assert.match(joined, /Ln 1, Col 1/, 'the caret position is itself evidence the document is empty');
  });

  it('a text-free screen skips the overlap check instead of failing honest descriptions', async () => {
    // A photo, a game, a video: OCR yields nothing, so overlap proves nothing.
    const res = await look('', 'A photograph of a mountain range at sunset, mostly orange sky.');
    assert.equal(res.ok, true, 'no ground truth available is not the same as a fabrication');
    assert.equal(res.result.grounded, false, 'and it must be honest that it is ungrounded');
    assert.deepEqual(res.result.ocrSample, []);
  });

  it('OCR being unavailable degrades honestly rather than blocking screen_look', async () => {
    const res = await look(null, 'A Notepad window with some text in it.');
    assert.equal(res.ok, true, 'no OCR language pack must not break vision entirely');
    assert.equal(res.result.grounded, false);
  });

  it('a short but grounded reply is not failed for having few words', async () => {
    const res = await look(EMPTY_NOTEPAD_OCR, 'Notepad.');
    assert.equal(res.ok, true, 'brevity is not fabrication');
  });
});

describe('WAVE 4 — the voice rule that consumes it', () => {
  it('RULES tells the model ocrSample is ground truth and description is not', () => {
    const { RULES } = require('../src/core/voice/voice-agent');
    assert.match(RULES, /SCREEN EVIDENCE RULE/);
    assert.match(RULES, /ocrSample/, 'the rule must name the actual field');
    assert.match(RULES, /visually confirmed/i, 'the exact phrase it fabricated must be governed');
    assert.match(RULES, /generally behaves|generally/i,
      'the tutorial-paragraph failure mode must be named, since it read as reassuring');
  });
});
