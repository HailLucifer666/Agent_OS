// intake.test.js — unit tests for connection-scoped voice intake memory.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const intake = require('./intake');

describe('intake', () => {
  test('get returns empty array for unknown connectionId', () => {
    assert.deepEqual(intake.get('unknown'), []);
  });

  test('append then get round-trips content', () => {
    intake.append('conn-1', 'user', 'hello');
    intake.append('conn-1', 'assistant', 'hi there');
    const history = intake.get('conn-1');
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[0].content, 'hello');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].content, 'hi there');
    intake.clear('conn-1');
  });

  test('clear removes the session', () => {
    intake.append('conn-2', 'user', 'test');
    intake.clear('conn-2');
    assert.deepEqual(intake.get('conn-2'), []);
  });

  test('get returns a defensive copy (mutating returned array does not affect internal state)', () => {
    intake.append('conn-3', 'user', 'x');
    const a = intake.get('conn-3');
    const b = intake.get('conn-3');
    assert.notEqual(a, b);
    a.push({ role: 'user', content: 'mutated' });
    assert.equal(intake.get('conn-3').length, 1);
    intake.clear('conn-3');
  });

  test('history is capped at MAX_TURNS (12)', () => {
    for (let i = 0; i < 20; i++) {
      intake.append('conn-4', 'user', `turn ${i}`);
    }
    const history = intake.get('conn-4');
    assert.equal(history.length, 12);
    assert.equal(history[0].content, 'turn 8');
    assert.equal(history[11].content, 'turn 19');
    intake.clear('conn-4');
  });
});
