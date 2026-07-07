// confirm.test.js — pending-confirmation registry: create/accept/reject, TTL, single-use.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.VOICE_CONFIRM_TTL_MS = '30'; // short TTL so expiry tests run fast

// confirm.js reads VOICE_CONFIRM_TTL_MS once at module load, so set the env before requiring.
const confirm = require('./confirm');

describe('confirm.js', () => {
  test('create() returns a confirmId string', () => {
    const id = confirm.create('delete goal X', { tool: 'delete_goal', args: {} });
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  test('accept() returns the stored action for a valid pending confirm', () => {
    const action = { tool: 'delete_goal', args: { id: '2' } };
    const id = confirm.create('delete goal X', action);
    const returned = confirm.accept(id);
    assert.deepEqual(returned, action);
  });

  test('accept() is single-use: a second accept on the same confirmId returns null (no-op)', () => {
    const action = { tool: 'delete_goal', args: {} };
    const id = confirm.create('delete goal X', action);
    const first = confirm.accept(id);
    const second = confirm.accept(id);
    assert.deepEqual(first, action);
    assert.equal(second, null, 'second accept must not re-return the action');
  });

  test('accept() on an unknown confirmId returns null without throwing', () => {
    assert.doesNotThrow(() => {
      const result = confirm.accept('confirm-does-not-exist');
      assert.equal(result, null);
    });
  });

  test('accept() after TTL expiry returns null cleanly, no crash, no stale execution', async () => {
    const action = { tool: 'kill_session', args: { pid: 1234 } };
    const id = confirm.create('kill session 1234', action);
    await new Promise((resolve) => setTimeout(resolve, 60)); // TTL is 30ms in this suite
    const result = confirm.accept(id);
    assert.equal(result, null, 'expired confirm must not return the action');
    // Confirm it is also gone from the registry (peek reflects removal), not just expired-in-place.
    assert.equal(confirm.peek(id), null);
  });

  test('reject() removes a pending confirm and returns true; second reject returns false', () => {
    const id = confirm.create('delete goal Y', { tool: 'delete_goal', args: {} });
    const first = confirm.reject(id);
    const second = confirm.reject(id);
    assert.equal(first, true);
    assert.equal(second, false);
    // Rejected confirm can no longer be accepted.
    assert.equal(confirm.accept(id), null);
  });

  test('reject() on an unknown confirmId returns false without throwing', () => {
    assert.doesNotThrow(() => {
      assert.equal(confirm.reject('nope'), false);
    });
  });

  test('peek() reports summary + expired:false for a fresh confirm', () => {
    const id = confirm.create('assemble kanban plan', { tool: 'kanban_assemble', args: {} });
    const info = confirm.peek(id);
    assert.deepEqual(info, { summary: 'assemble kanban plan', expired: false });
  });

  test('peek() reports expired:true after TTL elapses, without consuming it', async () => {
    const id = confirm.create('build kanban card', { tool: 'kanban_build_card', args: {} });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const info = confirm.peek(id);
    assert.equal(info.expired, true);
  });

  test('peek() on an unknown confirmId returns null', () => {
    assert.equal(confirm.peek('nope'), null);
  });
});
