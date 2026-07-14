'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyAffirmation } = require('../src/core/voice/affirmation');

describe('classifyAffirmation — zero-LLM yes/no intent for pending gates', () => {
  it('classifies plain yes words', () => {
    ['yes', 'Yeah', 'yep', 'sure', 'proceed', 'ok', 'okay', 'approved'].forEach((w) => {
      assert.equal(classifyAffirmation(w), 'yes', w);
    });
  });
  it('classifies plain no words', () => {
    ['no', 'nope', 'cancel', 'stop', 'deny', 'wait'].forEach((w) => {
      assert.equal(classifyAffirmation(w), 'no', w);
    });
  });
  it('classifies short affirmative/negative phrases', () => {
    assert.equal(classifyAffirmation('go ahead'), 'yes');
    assert.equal(classifyAffirmation('do it'), 'yes');
    assert.equal(classifyAffirmation('sounds good'), 'yes');
    assert.equal(classifyAffirmation('no thanks'), 'no');
    assert.equal(classifyAffirmation("don't"), 'no');
    assert.equal(classifyAffirmation('hold on'), 'no');
  });
  it('falls through (null) on long or ambiguous replies', () => {
    assert.equal(classifyAffirmation('yes but also change the color to blue please'), null); // > maxWords
    assert.equal(classifyAffirmation('maybe later we can'), null);
    assert.equal(classifyAffirmation('the weather'), null);
  });
  it('does not mistake similar-prefixed words for yes/no', () => {
    assert.equal(classifyAffirmation('yesterday'), null);
    assert.equal(classifyAffirmation('nobody'), null);
  });
  it('null on empty/whitespace, tolerant of trailing punctuation', () => {
    assert.equal(classifyAffirmation(''), null);
    assert.equal(classifyAffirmation('   '), null);
    assert.equal(classifyAffirmation('yes.'), 'yes');
    assert.equal(classifyAffirmation('no!'), 'no');
  });
});
