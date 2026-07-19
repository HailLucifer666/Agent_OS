'use strict';
// W3 regression: the gmailUnread() bound fn used by the gmail triage sensor must
// write an audit line. Pre-W3 it was a raw hub.invoke('gmail_unread', ...) —
// breaker-gated but no audit trail, no goal context (task-957 §24 W3). W3 routes
// it through dispatchAction so each poll is audited. The return shape ({ok,
// result}) the gmail-sensor consumes is unchanged.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

// Reproduce the exact gmailUnread binding main.js constructs post-W3, against
// a fake hub that returns a sample unread batch.
function makeGmailUnread({ auditCalls, hubInvokeResult }) {
  const fakeHub = {
    invoke: async () => hubInvokeResult,
    breakers: { allow: () => true },
  };
  const memory = {
    audit: { write: (entry) => { auditCalls.push(entry); } },
    episodic: { write: async () => ({ ref: 'ep-1' }) },
  };
  return function gmailUnread(args) {
    return dispatchAction(
      { tool: 'gmail_unread', args: args || {} },
      {
        effectors: fakeHub,
        bus: { emit: () => {}, subscribe: () => () => {} },
        memory: memory,
        goals: null,
        config: { ACTION_TIMEOUT_MS: 30000 },
        goalId: null,
        tier: 1,
        channel: 'gmail-sensor',
      }
    );
  };
}

describe('W3: gmailUnread writes an audit line via dispatchAction', () => {
  it('a successful gmail_unread poll writes an audit entry with decision:"completed"', async () => {
    const auditCalls = [];
    const gmailUnread = makeGmailUnread({
      auditCalls,
      hubInvokeResult: { ok: true, result: { messages: [{ id: 'msg-1' }] } },
    });

    const res = await gmailUnread({});
    assert.equal(res.ok, true, 'return shape must stay {ok, result} for the sensor');

    assert.ok(auditCalls.length >= 1, 'expected at least one audit entry');
    const completed = auditCalls.find(a => a.decision === 'completed');
    assert.ok(completed, 'expected decision:"completed" audit entry');
    assert.equal(completed.tool, 'gmail_unread');
    assert.equal(completed.outcome, 'ok');
    assert.equal(completed.tier, 1);
  });

  it('a failing gmail_unread poll (breaker open / unconfigured) still audits as outcome:"fail"', async () => {
    const auditCalls = [];
    const gmailUnread = makeGmailUnread({
      auditCalls,
      hubInvokeResult: { ok: false, result: 'gmail unconfigured' },
    });

    const res = await gmailUnread({});
    assert.equal(res.ok, false);

    const completed = auditCalls.find(a => a.decision === 'completed');
    assert.ok(completed, 'failing polls must still audit');
    assert.equal(completed.outcome, 'fail');
  });

  it('the gmail sensor sees the same return shape — {ok, result} with messages array', async () => {
    // The sensor's poll() reads res.result.messages; that contract is preserved.
    const gmailUnread = makeGmailUnread({
      auditCalls: [],
      hubInvokeResult: { ok: true, result: { messages: [{ id: 'a' }, { id: 'b' }] } },
    });
    const res = await gmailUnread({});
    assert.ok(Array.isArray(res.result.messages));
    assert.equal(res.result.messages.length, 2);
  });
});
