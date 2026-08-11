'use strict';

// voice-picker-state.test.js — the picker's pure decisions.
//
// The screen's job is to be HONEST about what this machine can speak with. Two
// ways it could lie, both easy to reintroduce:
//   * rendering an empty list on a packaged, keyless install, which reads as
//     "broken" when the true statement is "no engine here, so you are hearing
//     the browser's voice — add a Google key";
//   * hiding an engine that exists but is not installed, so the operator never
//     learns piper was an option at all.
//
// The module is browser ESM and this suite is CJS, so the source is evaluated
// with its `export ` keywords stripped — the same trick setup-state.test.js uses,
// which keeps voice-picker.js free of any test-shaped seam.
//
// Run: cd mythos && node --test test/voice-picker-state.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-picker.js'),
  'utf8'
);
// Only the pure helpers are exercised; createVoicePicker touches document/Audio,
// which this environment does not have and does not need to have.
const { summarizeEngines, isCurrent } = new Function(`${SRC.replace(/^export /gm, '')}
  return { summarizeEngines, isCurrent };`)();

const GEMINI = { provider: 'gemini-tts', short: 'gemini', available: true, voices: [{ id: 'Aoede', label: 'Aoede' }, { id: 'Kore', label: 'Kore' }] };
const PIPER_MISSING = { provider: 'piper-tts', short: 'piper', available: false, voices: [] };
// Available but with nothing to offer — a sidecar that answered its health probe
// and then failed to list. Not usable, and must not render as an empty group.
const EDGE_EMPTY = { provider: 'edge-tts', short: 'edge', available: true, voices: [] };

describe('summarizeEngines', () => {
  it('keeps missing engines visible while only offering the usable ones', () => {
    const s = summarizeEngines({ engines: [GEMINI, PIPER_MISSING], default: { provider: 'gemini-tts', voice: 'Aoede' } });
    assert.equal(s.anyUsable, true);
    assert.deepEqual(s.usable.map((e) => e.short), ['gemini']);
    assert.equal(s.engines.length, 2, 'the missing engine stays in the list so the screen can name it');
  });

  it('an engine with no voices is not offered as a choice', () => {
    const s = summarizeEngines({ engines: [EDGE_EMPTY] });
    assert.equal(s.anyUsable, false);
    assert.deepEqual(s.usable, []);
  });

  it('a machine with nothing to speak with gets the browser-voice explanation', () => {
    const s = summarizeEngines({ engines: [PIPER_MISSING] });
    assert.equal(s.anyUsable, false);
    assert.match(s.emptyMessage, /browser/i);
    assert.match(s.emptyMessage, /GOOGLE_API_KEY/);
  });

  it('survives a body the server never sent', () => {
    for (const body of [null, undefined, {}, { engines: 'nope' }]) {
      const s = summarizeEngines(body);
      assert.equal(s.anyUsable, false);
      assert.deepEqual(s.engines, []);
    }
  });
});

describe('isCurrent', () => {
  it('matches only the exact provider AND voice in use', () => {
    const chosen = { provider: 'gemini-tts', voice: 'Aoede' };
    assert.equal(isCurrent(chosen, 'gemini-tts', 'Aoede'), true);
    assert.equal(isCurrent(chosen, 'gemini-tts', 'Kore'), false);
    assert.equal(isCurrent(chosen, 'edge-tts', 'Aoede'), false, 'the same voice name on another engine is another voice');
    assert.equal(isCurrent(null, 'gemini-tts', 'Aoede'), false);
  });
});
