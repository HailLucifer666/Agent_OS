// tts.test.js — sentence-boundary truncation + null-when-unavailable / never-throws contract.
// Mocks providers/edge-tts.js in place (same module-singleton pattern used elsewhere in this
// codebase's tests) so no real Python service or network call is required.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const edgeTts = require('../providers/edge-tts');
const tts = require('./tts');

describe('tts.js', () => {
  let originalIsAvailable;
  let originalSynthesize;

  beforeEach(() => {
    originalIsAvailable = edgeTts.isAvailable;
    originalSynthesize = edgeTts.synthesize;
  });

  afterEach(() => {
    edgeTts.isAvailable = originalIsAvailable;
    edgeTts.synthesize = originalSynthesize;
  });

  describe('truncateAtSentenceBoundary', () => {
    test('returns short text unchanged', () => {
      assert.equal(tts.truncateAtSentenceBoundary('Short reply.'), 'Short reply.');
    });

    test('cuts at a sentence boundary when one exists within the limit', () => {
      const text = `${'A'.repeat(340)}. This sentence goes past the limit and should be dropped entirely.`;
      const result = tts.truncateAtSentenceBoundary(text);
      assert.ok(result.length <= 350);
      assert.ok(result.endsWith('.'), `expected to end at a sentence boundary, got: "${result.slice(-20)}"`);
      assert.ok(!result.includes('should be dropped'), 'text past the sentence boundary must not appear');
    });

    test('never cuts mid-word when no sentence boundary exists — falls back to a whitespace boundary', () => {
      const text = 'word '.repeat(100); // no punctuation at all, well over 350 chars
      const result = tts.truncateAtSentenceBoundary(text);
      assert.ok(result.length <= 350);
      assert.ok(!/\bwor$/.test(result) && !/\bwo$/.test(result), 'must not end mid-word');
      // Every char up to the cut should be a complete "word" token (ends cleanly with 'd' or is empty).
      assert.ok(result === '' || /d$/.test(result.trim()), `expected a clean word boundary, got: "${result.slice(-10)}"`);
    });

    test('hard-cuts as a last resort when there is no whitespace at all', () => {
      const text = 'x'.repeat(500);
      const result = tts.truncateAtSentenceBoundary(text);
      assert.equal(result.length, 350);
    });

    test('respects a custom maxChars override', () => {
      const text = 'One. Two. Three. Four. Five.';
      const result = tts.truncateAtSentenceBoundary(text, 10);
      assert.ok(result.length <= 10);
    });
  });

  describe('speak()', () => {
    test('returns null (never throws) when edge-tts is unavailable', async () => {
      edgeTts.isAvailable = async () => false;
      edgeTts.synthesize = async () => { throw new Error('should not be called'); };
      const result = await tts.speak('Hello there.');
      assert.equal(result, null);
    });

    test('returns null for empty/whitespace-only text without calling edge-tts', async () => {
      let synthCalled = false;
      edgeTts.isAvailable = async () => true;
      edgeTts.synthesize = async () => { synthCalled = true; return Buffer.from([]); };
      const result = await tts.speak('   ');
      assert.equal(result, null);
      assert.equal(synthCalled, false);
    });

    test('returns the synthesized Buffer when edge-tts is available', async () => {
      const fakeBuf = Buffer.from([0xff, 0xfb, 0x01, 0x02]);
      edgeTts.isAvailable = async () => true;
      edgeTts.synthesize = async () => fakeBuf;
      const result = await tts.speak('Hello there.');
      assert.ok(Buffer.isBuffer(result));
      assert.deepEqual(result, fakeBuf);
    });

    test('passes the truncated text (not the original) to synthesize()', async () => {
      const longText = 'word '.repeat(200);
      let capturedText = null;
      edgeTts.isAvailable = async () => true;
      edgeTts.synthesize = async ({ text }) => { capturedText = text; return Buffer.from([1]); };
      await tts.speak(longText);
      assert.ok(capturedText.length <= 350);
      assert.notEqual(capturedText, longText.trim());
    });

    test('returns null (never throws) when synthesize() itself throws', async () => {
      edgeTts.isAvailable = async () => true;
      edgeTts.synthesize = async () => { throw new Error('service crashed mid-call'); };
      const result = await tts.speak('Hello there.');
      assert.equal(result, null);
    });

    test('uses VOICE_TTS_VOICE default when no voice option is passed', async () => {
      let capturedVoice = null;
      edgeTts.isAvailable = async () => true;
      edgeTts.synthesize = async ({ voice }) => { capturedVoice = voice; return Buffer.from([1]); };
      await tts.speak('Hi.');
      assert.equal(typeof capturedVoice, 'string');
      assert.ok(capturedVoice.length > 0);
    });
  });
});
