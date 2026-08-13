'use strict';

// test/util-reason-text.test.js — Wave 0 (2026-08-13). reasonText() was
// duplicated verbatim inside dispatch-action.js (REMEDIATION P2-12) and is now
// extracted to util/reason-text.js so effectors' own catch blocks can share it
// instead of falling back to `(err.message || err)`, which stringifies a
// non-Error thrown object as the useless literal "[object Object]" — the
// exact defect confirmed in the 2026-07-29 audit's Audit/2026-07-29.jsonl.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reasonText } = require('../src/core/util/reason-text');

describe('reasonText', () => {
  test('a plain string passes through untouched', () => {
    assert.equal(reasonText('boom'), 'boom');
  });

  test('a real Error uses .message', () => {
    assert.equal(reasonText(new Error('gmail send failed')), 'gmail send failed');
  });

  test('an object with .error (an effector fail() shape) uses that', () => {
    assert.equal(reasonText({ error: 'quota exceeded', extra: 1 }), 'quota exceeded');
  });

  test('a plain object with neither .message nor .error falls back to JSON, never "[object Object]"', () => {
    const out = reasonText({ code: 'ECONNRESET', errno: -104 });
    assert.doesNotMatch(out, /\[object Object\]/);
    assert.match(out, /ECONNRESET/);
  });

  test('null/undefined -> empty string, not "null"/"undefined"', () => {
    assert.equal(reasonText(null), '');
    assert.equal(reasonText(undefined), '');
  });

  test('a number or other primitive stringifies plainly', () => {
    assert.equal(reasonText(404), '404');
  });

  test('an unstringifiable object (circular) falls back to String() rather than throwing', () => {
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => reasonText(circular));
  });
});
