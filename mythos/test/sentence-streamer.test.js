'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSentenceStreamer, splitSentences } = require('../src/core/effectors/voice');

// P20: incremental counterpart to splitSentences() — feed text deltas as they
// arrive from a streaming LLM token-by-token and get back only the sentences
// that are provably complete, so TTS can start on sentence 1 while sentence 2+
// is still generating.
describe('createSentenceStreamer', () => {
  it('emits nothing until a sentence-ending delta arrives', () => {
    const s = createSentenceStreamer();
    assert.deepEqual(s.push('The sky '), []);
    assert.deepEqual(s.push('is blue'), []);
    assert.deepEqual(s.push(' today'), []);
  });

  it('emits a completed sentence (>= MIN_CHUNK_CHARS) exactly once terminal punctuation arrives', () => {
    const s = createSentenceStreamer();
    s.push('The sky is a lovely shade');
    const out = s.push(' of blue this morning. ');
    assert.deepEqual(out, ['The sky is a lovely shade of blue this morning.']);
  });

  it('never re-emits a sentence already returned by a prior push()', () => {
    const s = createSentenceStreamer();
    const first = s.push('Ok, sure thing. ');
    const second = s.push('Another sentence follows right after. ');
    assert.ok(first.length + second.length >= 1);
    // whatever was emitted in `first` never reappears in `second`
    for (const c of first) assert.ok(!second.includes(c));
  });

  it('groups short fragments with their successor, same threshold as splitSentences', () => {
    const s = createSentenceStreamer();
    const out1 = s.push('Ok. Sure. ');
    // "Ok." and "Sure." are both under MIN_CHUNK_CHARS — held back, not emitted yet
    assert.deepEqual(out1, []);
    const out2 = s.push('Here is a much longer sentence that explains things in detail. ');
    assert.equal(out2.length, 1);
    assert.ok(out2[0].startsWith('Ok. Sure.'));
  });

  it('flush() returns the dangling tail with no terminal punctuation, including any short sentence held back by the grouping threshold', () => {
    const s = createSentenceStreamer();
    const out1 = s.push('Hello there.'); // under MIN_CHUNK_CHARS — held back, not emitted
    const out2 = s.push(' and one more clause with no ending'); // no terminal punctuation yet
    assert.deepEqual(out1, []);
    assert.deepEqual(out2, []);
    assert.equal(s.flush(), 'Hello there. and one more clause with no ending');
  });

  it('flush() returns null when nothing is left', () => {
    const s = createSentenceStreamer();
    s.push('Complete sentence right here. ');
    assert.equal(s.flush(), null);
  });

  it('streaming char-by-char reconstructs the same chunks as splitSentences on the full text', () => {
    const text = 'One sentence here. Another sentence follows right after. And a final one closes it out.';
    const s = createSentenceStreamer();
    let streamed = [];
    for (const ch of text) streamed = streamed.concat(s.push(ch));
    const tail = s.flush();
    if (tail) streamed.push(tail);

    const batch = splitSentences(text);
    assert.equal(streamed.join(' ').replace(/\s+/g, ' ').trim(), batch.join(' ').replace(/\s+/g, ' ').trim());
  });
});
