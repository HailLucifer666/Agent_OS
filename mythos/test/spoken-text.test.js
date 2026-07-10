'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSpoken } = require('../src/core/voice/spoken-text');

describe('sanitizeSpoken', () => {
  it('strips bold and italic markers', () => {
    assert.equal(sanitizeSpoken('I will build a **premium** website with *style*.'),
      'I will build a premium website with style.');
  });

  it('expands e.g. / i.e. / etc. / vs.', () => {
    assert.equal(sanitizeSpoken('Frameworks, e.g. React'), 'Frameworks, for example, React');
    assert.equal(sanitizeSpoken('the core, i.e. the brain'), 'the core, that is, the brain');
    assert.equal(sanitizeSpoken('goals, kanban, etc.'), 'goals, kanban, et cetera.');
    assert.equal(sanitizeSpoken('dark vs. light'), 'dark versus light');
  });

  it('strips headers, bullets, links, code', () => {
    assert.equal(sanitizeSpoken('# Plan\n- item one\n- item two\nSee [docs](http://x.y).'),
      'Plan item one item two See docs.');
    assert.equal(sanitizeSpoken('Run `npm install` first.'), 'Run npm install first.');
    assert.equal(sanitizeSpoken('```js\ncode here\n```done'), 'code omitted done');
  });

  it('reads & as and, collapses whitespace, never throws on junk', () => {
    assert.equal(sanitizeSpoken('goals & kanban'), 'goals and kanban');
    assert.equal(sanitizeSpoken('   a\n\n\nb   '), 'a b');
    assert.equal(sanitizeSpoken(null), '');
    assert.equal(sanitizeSpoken(undefined), '');
  });
});
