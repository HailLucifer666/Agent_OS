'use strict';

// F2b (2026-08-15) — "the HUD stays blue while it is talking".
//
// The operator was right, and it was TWO independent defects stacked. Fixing
// either alone leaves them looking at a blue orb, which is why both halves are
// asserted here:
//
//   1. NO SIGNAL. On the Live path, s2s-bridge.js reached setState() from
//      exactly two places — onLiveStateMsg and the mute overlay. onSpeakStart /
//      onSpeakEnd were wired to the PCM player and drove only the BUG-224 mic
//      gate. So voiceState was set to 'listening' once when the session opened
//      and never changed again, across every reply of an 80-minute session.
//      The legacy voice-loop.js path has always done this correctly.
//
//   2. NO COLOUR FOR THE SIGNAL. voice.css gave .mic-listening and
//      .mic-speaking the same --accent token (#4fd8ff, blue). Even with the
//      state emitted, nothing on screen would have changed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui', 'public');
const bridge = fs.readFileSync(path.join(UI, 'js', 'voice', 's2s-bridge.js'), 'utf8');
const css = fs.readFileSync(path.join(UI, 'css', 'voice.css'), 'utf8');

function ruleBody(selector) {
  const at = css.indexOf(selector);
  assert.notStrictEqual(at, -1, 'missing CSS rule: ' + selector);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('F2b — the HUD must show when MYTHOS is speaking', () => {
  test('the Live path emits a speaking state on the player\'s speak edge', () => {
    const m = bridge.match(/onSpeakStart:\s*\(\)\s*=>\s*\{([^}]*)\}/);
    assert.ok(m, 'onSpeakStart must still be wired to the PCM player');
    assert.match(m[1], /setVoiceState\('speaking'\)/,
      'onSpeakStart drove only the mic gate; without a state emit the orb never '
      + 'changes for the whole session');
  });

  test('and clears it when the utterance ends', () => {
    const m = bridge.match(/onSpeakEnd:\s*\(\)\s*=>\s*\{([^}]*)\}/);
    assert.ok(m, 'onSpeakEnd must still be wired to the PCM player');
    assert.match(m[1], /setVoiceState\('listening'\)/,
      'a speaking state that is never cleared is as wrong as one never set');
  });

  test('the speak edges still drive the BUG-224 mic gate', () => {
    // Pinning the disposition: this change ADDS a paint, it does not replace the
    // half-duplex gate. Dropping the gate here would feed MYTHOS's own voice
    // back into Gemini's VAD, which is the F3 defect.
    assert.match(bridge, /onSpeakStart:\s*\(\)\s*=>\s*\{\s*holdOwnVoiceGate\(\)/);
    assert.match(bridge, /onSpeakEnd:\s*\(\)\s*=>\s*\{\s*releaseOwnVoiceGate\('own-voice-ended'\)/);
  });

  test('listening and speaking are not the same colour', () => {
    const listening = ruleBody('#mic-indicator.mic-listening .mic-ring');
    const speaking = ruleBody('#mic-indicator.mic-speaking .mic-ring');
    const colourOf = (body) => (body.match(/(?:^|\n)\s*color:\s*([^;]+);/) || [])[1];
    assert.notStrictEqual(colourOf(listening), colourOf(speaking),
      'both states resolved to var(--accent), so the indicator looked identical '
      + 'whether MYTHOS was listening or talking');
  });

  test('the mic indicator reuses the orb\'s tokens rather than inventing a third palette', () => {
    assert.match(ruleBody('#mic-indicator.mic-speaking .mic-ring'), /--orb-speaking/);
    assert.match(ruleBody('#mic-indicator.mic-listening .mic-ring'), /--orb-listening/);
  });

  test('both tokens are actually defined somewhere in the theme', () => {
    // A var() that resolves to nothing renders as an unstyled ring, which would
    // trade one wrong appearance for another.
    // Recursive: the tokens live in css/tokens/semantic.css, not the top level.
    // A non-recursive glob is how this repo's test gates hid 188 tests for days.
    const read = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? read(path.join(dir, e.name))
        : e.name.endsWith('.css') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []);
    const all = read(path.join(UI, 'css')).join('\n');
    for (const token of ['--orb-speaking', '--orb-listening']) {
      assert.match(all, new RegExp(token + '\\s*:\\s*#?\\w'), token + ' must be defined');
    }
  });
});
