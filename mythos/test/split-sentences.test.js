'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences } = require('../src/core/effectors/voice');

describe('splitSentences', () => {
  it('returns [] for empty/whitespace input', () => {
    assert.deepEqual(splitSentences(''), []);
    assert.deepEqual(splitSentences('   '), []);
    assert.deepEqual(splitSentences(null), []);
  });

  it('returns a single chunk for one short sentence', () => {
    const out = splitSentences('Hello there.');
    assert.deepEqual(out, ['Hello there.']);
  });

  it('splits multi-sentence text into chunks, each >= MIN_CHUNK_CHARS except possibly the last', () => {
    const text = 'The sky is blue today. The grass is green outside. It is a nice warm day out.';
    const out = splitSentences(text);
    assert.ok(out.length >= 2);
    for (let i = 0; i < out.length - 1; i++) {
      assert.ok(out[i].trim().length >= 25, `chunk ${i} too short: "${out[i]}"`);
    }
  });

  it('groups very short fragments with their successor instead of emitting tiny chunks', () => {
    const out = splitSentences('Ok. Sure. Here is a much longer sentence that explains things in detail.');
    for (const c of out) assert.ok(c.trim().length >= 25 || out.indexOf(c) === out.length - 1);
  });

  it('does not produce absurd fragments on abbreviation-like text', () => {
    const out = splitSentences('This costs e.g. ten dollars, i.e. not much at all for what it does.');
    assert.ok(out.length >= 1);
    assert.equal(out.join(' ').replace(/\s+/g, ' ').trim().length > 0, true);
  });

  it('loses no characters — chunks rejoin to (whitespace-normalized) original', () => {
    const text = 'One sentence here. Another sentence follows right after. And a final one closes it out.';
    const out = splitSentences(text);
    const rejoined = out.join(' ').replace(/\s+/g, ' ').trim();
    const normalizedOriginal = text.replace(/\s+/g, ' ').trim();
    assert.equal(rejoined, normalizedOriginal);
  });
});
