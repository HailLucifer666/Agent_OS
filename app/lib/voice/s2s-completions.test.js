// s2s-completions.test.js — unit tests for POST /voice/v1/chat/completions's handler,
// exercised directly against createS2sCompletionsRouter with fake req/res objects (no live
// HTTP server needed — same style as this repo's other pure-function-over-req/res modules).
// voiceAgent.handleUtterance is stubbed; isLoopback is injected so both loopback and
// non-loopback paths are exercised deterministically.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createS2sCompletionsRouter, buildCompletion, extractLastUserText } = require('./s2s-completions');

// Minimal fake res — captures status/json calls, same pattern as other req/res-based tests
// in this codebase (rate-limit.js's middleware is exercised the same way upstream).
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function fakeReq({ body = {}, loopback = true } = {}) {
  return { id: 'req-1', body, ip: loopback ? '127.0.0.1' : '203.0.113.5' };
}

describe('s2s-completions', () => {
  test('buildCompletion is an independently callable/exported function with the exact OpenAI shape', () => {
    const completion = buildCompletion('hello there', 'voice-agent');
    assert.equal(typeof completion.id, 'string');
    assert.ok(completion.id.startsWith('chatcmpl-'));
    assert.equal(completion.object, 'chat.completion');
    assert.equal(typeof completion.created, 'number');
    assert.equal(completion.model, 'voice-agent');
    assert.deepEqual(completion.choices, [
      { index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' },
    ]);
  });

  test('buildCompletion defaults model to "voice-agent" when none given', () => {
    const completion = buildCompletion('hi', undefined);
    assert.equal(completion.model, 'voice-agent');
  });

  test('extractLastUserText picks the LAST role:"user" message, not the last array element', () => {
    const messages = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'turn on the lights' },
      { role: 'assistant', content: 'sure' },
    ];
    assert.equal(extractLastUserText(messages), 'turn on the lights');
  });

  test('extractLastUserText returns null for missing/non-array messages', () => {
    assert.equal(extractLastUserText(undefined), null);
    assert.equal(extractLastUserText('not an array'), null);
  });

  test('extractLastUserText returns null when no role:"user" message is present', () => {
    assert.equal(extractLastUserText([{ role: 'system', content: 'x' }]), null);
  });

  test('extractLastUserText returns null for empty/whitespace-only user content', () => {
    assert.equal(extractLastUserText([{ role: 'user', content: '   ' }]), null);
  });

  describe('POST /voice/v1/chat/completions handler', () => {
    test('non-loopback request -> 403, handleUtterance never called', async () => {
      let called = 0;
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async () => { called += 1; return { say: 'x' }; } },
        isLoopback: (req) => req.ip === '127.0.0.1',
      });
      const req = fakeReq({ loopback: false, body: { messages: [{ role: 'user', content: 'hi' }] } });
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 403);
      assert.ok(res.body.error);
      assert.equal(called, 0);
    });

    test('missing messages -> 400, handleUtterance not called', async () => {
      let called = 0;
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async () => { called += 1; return { say: 'x' }; } },
        isLoopback: () => true,
      });
      const res = fakeRes();
      await handler(fakeReq({ body: {} }), res);
      assert.equal(res.statusCode, 400);
      assert.ok(res.body.error);
      assert.equal(called, 0);
    });

    test('empty/whitespace-only user content -> 400, handleUtterance not called', async () => {
      let called = 0;
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async () => { called += 1; return { say: 'x' }; } },
        isLoopback: () => true,
      });
      const res = fakeRes();
      const body = { messages: [{ role: 'user', content: '   ' }] };
      await handler(fakeReq({ body }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(called, 0);
    });

    test('trailing assistant/system message after the target user message does not break extraction', async () => {
      let capturedArgs = null;
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async (args) => { capturedArgs = args; return { say: 'ok' }; } },
        isLoopback: () => true,
      });
      const body = {
        model: 'voice-agent',
        messages: [
          { role: 'user', content: 'what time is it' },
          { role: 'assistant', content: 'placeholder' },
        ],
      };
      const res = fakeRes();
      await handler(fakeReq({ body }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(capturedArgs.text, 'what time is it');
      assert.equal(capturedArgs.ctx.mode, 's2s');
      assert.equal(typeof capturedArgs.ctx.connectionId, 'string');
    });

    test('calls handleUtterance with exactly {text, ctx:{mode:"s2s"}} and returns buildCompletion(say, model)', async () => {
      let capturedArgs = null;
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async (args) => { capturedArgs = args; return { say: 'The time is noon.' }; } },
        isLoopback: () => true,
      });
      const body = { model: 'voice-agent', messages: [{ role: 'user', content: '  what time is it  ' }] };
      const res = fakeRes();
      await handler(fakeReq({ body }), res);
      assert.equal(capturedArgs.text, 'what time is it');
      assert.equal(capturedArgs.ctx.mode, 's2s');
      assert.equal(typeof capturedArgs.ctx.connectionId, 'string');
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.object, 'chat.completion');
      assert.equal(res.body.model, 'voice-agent');
      assert.equal(res.body.choices[0].message.content, 'The time is noon.');
      assert.equal(res.body.choices[0].message.role, 'assistant');
      assert.equal(res.body.choices[0].finish_reason, 'stop');
    });

    test('stream:true is ignored — still returns the same non-streamed JSON, no error', async () => {
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async () => ({ say: 'fine' }) },
        isLoopback: () => true,
      });
      const body = { stream: true, messages: [{ role: 'user', content: 'hi' }] };
      const res = fakeRes();
      await handler(fakeReq({ body }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.object, 'chat.completion');
      assert.equal(res.body.choices[0].message.content, 'fine');
    });

    test('a rejecting handleUtterance -> 500, not a crash', async () => {
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async () => { throw new Error('ollama down'); } },
        isLoopback: () => true,
      });
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      const res = fakeRes();
      await assert.doesNotReject(() => handler(fakeReq({ body }), res));
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'Internal server error.');
      assert.equal(res.body.requestId, 'req-1');
    });
  });

  // Security-review regression: this is a single long-running local process talking through
  // one router instance, not a per-request caller like a WS connection — it must get one
  // STABLE, non-null connectionId for its whole lifetime. Passing null would silently opt this
  // entire live, network-reachable transport out of confirm.js's connection-scoping check
  // (which treats connectionId:null as "no scoping" — an escape hatch meant only for test code).
  describe('connectionId scoping (security review fix)', () => {
    test('ctx.connectionId is never null/undefined and stays the same across multiple requests on one router instance', async () => {
      const seenIds = [];
      const handler = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async (args) => { seenIds.push(args.ctx.connectionId); return { say: 'ok' }; } },
        isLoopback: () => true,
      });
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      await handler(fakeReq({ body }), fakeRes());
      await handler(fakeReq({ body }), fakeRes());
      assert.equal(seenIds.length, 2);
      assert.ok(seenIds[0], 'connectionId must be truthy, never null');
      assert.equal(seenIds[0], seenIds[1], 'the same router instance must reuse one stable connectionId');
    });

    test('two separate router instances (e.g. a hypothetical second s2s process) get DIFFERENT connectionIds', async () => {
      let idA = null;
      let idB = null;
      const handlerA = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async (args) => { idA = args.ctx.connectionId; return { say: 'ok' }; } },
        isLoopback: () => true,
      });
      const handlerB = createS2sCompletionsRouter({
        voiceAgent: { handleUtterance: async (args) => { idB = args.ctx.connectionId; return { say: 'ok' }; } },
        isLoopback: () => true,
      });
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      await handlerA(fakeReq({ body }), fakeRes());
      await handlerB(fakeReq({ body }), fakeRes());
      assert.notEqual(idA, idB);
    });
  });

  // Functional gap found alongside the security fix: this transport has no separate
  // "voice-confirm-reply" message type the way the WS protocol does, so a danger-tier confirm
  // can only ever be resolved by a LATER request recognizing it's an answer to a pending one.
  describe('confirm-accept flow over a stateless HTTP transport', () => {
    function stubConfirm({ acceptReturns = null } = {}) {
      const calls = { accept: [] };
      return { confirm: { accept: (confirmId, connectionId) => { calls.accept.push([confirmId, connectionId]); return acceptReturns; } }, calls };
    }

    test('a confirmPending result is remembered, and a later "yes" resolves it via confirm.accept + executeConfirmedAction — handleUtterance is NOT re-invoked for the accept turn', async () => {
      const action = { tool: 'delete_goal', args: { query: 'ship the voice agent' } };
      const { confirm, calls } = stubConfirm({ acceptReturns: action });
      let handleUtteranceCalls = 0;
      let capturedExecArgs = null;
      const handler = createS2sCompletionsRouter({
        voiceAgent: {
          handleUtterance: async () => {
            handleUtteranceCalls += 1;
            return { say: 'Delete the goal? Say yes to confirm.', confirmPending: { confirmId: 'c-1', ok: false, confirmPending: true } };
          },
          executeConfirmedAction: async (a, opts) => { capturedExecArgs = { a, opts }; return { ok: true, summary: 'Goal deleted.' }; },
        },
        isLoopback: () => true,
        confirm,
      });

      const firstBody = { messages: [{ role: 'user', content: 'delete the goal about shipping the voice agent' }] };
      const firstRes = fakeRes();
      await handler(fakeReq({ body: firstBody }), firstRes);
      assert.equal(firstRes.body.choices[0].message.content, 'Delete the goal? Say yes to confirm.');
      assert.equal(handleUtteranceCalls, 1);

      const secondBody = { messages: [{ role: 'user', content: 'yes' }] };
      const secondRes = fakeRes();
      await handler(fakeReq({ body: secondBody }), secondRes);

      assert.equal(handleUtteranceCalls, 1, 'the accept turn must NOT run a fresh LLM loop');
      assert.deepEqual(calls.accept[0].slice(0, 1), ['c-1']);
      assert.equal(typeof calls.accept[0][1], 'string', 'confirm.accept must be called with the router\'s connectionId');
      assert.deepEqual(capturedExecArgs.a, action);
      assert.equal(capturedExecArgs.opts.ctx.connectionId, calls.accept[0][1]);
      assert.equal(secondRes.body.choices[0].message.content, 'Goal deleted.');
    });

    test('accepts alternate accept phrases ("do it", "confirm", "go ahead")', async () => {
      const { confirm } = stubConfirm({ acceptReturns: { tool: 'kill_session', args: {} } });
      const handler = createS2sCompletionsRouter({
        voiceAgent: {
          handleUtterance: async () => ({ say: 'Kill it? Say yes to confirm.', confirmPending: { confirmId: 'c-2' } }),
          executeConfirmedAction: async () => ({ ok: true, summary: 'Done.' }),
        },
        isLoopback: () => true,
        confirm,
      });
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'kill it' }] } }), fakeRes());
      const res = fakeRes();
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'go ahead' }] } }), res);
      assert.equal(res.body.choices[0].message.content, 'Done.');
    });

    test('a non-accept utterance while a confirm is pending is a silent pivot: confirm.accept is never called, and the new utterance runs a normal fresh turn', async () => {
      const { confirm, calls } = stubConfirm();
      let lastUtteranceText = null;
      const handler = createS2sCompletionsRouter({
        voiceAgent: {
          handleUtterance: async (args) => {
            lastUtteranceText = args.text;
            if (args.text.includes('delete')) return { say: 'Delete? Say yes to confirm.', confirmPending: { confirmId: 'c-3' } };
            return { say: 'Sure, navigating.' };
          },
          executeConfirmedAction: async () => { throw new Error('must not be called'); },
        },
        isLoopback: () => true,
        confirm,
      });
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'delete the goal' }] } }), fakeRes());
      const res = fakeRes();
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'go to the kanban board instead' }] } }), res);

      assert.equal(calls.accept.length, 0, 'confirm.accept must never be called for a non-accept utterance');
      assert.equal(lastUtteranceText, 'go to the kanban board instead');
      assert.equal(res.body.choices[0].message.content, 'Sure, navigating.');
    });

    test('an expired/already-consumed confirmId (confirm.accept returns null) falls through to a normal fresh turn instead of erroring', async () => {
      const { confirm, calls } = stubConfirm({ acceptReturns: null });
      let handleUtteranceCalls = 0;
      const handler = createS2sCompletionsRouter({
        voiceAgent: {
          handleUtterance: async () => { handleUtteranceCalls += 1; return { say: handleUtteranceCalls === 1 ? 'Say yes to confirm.' : 'OK, treated as new.', confirmPending: handleUtteranceCalls === 1 ? { confirmId: 'c-4' } : null };
          },
          executeConfirmedAction: async () => { throw new Error('must not be called'); },
        },
        isLoopback: () => true,
        confirm,
      });
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'delete it' }] } }), fakeRes());
      const res = fakeRes();
      await handler(fakeReq({ body: { messages: [{ role: 'user', content: 'yes' }] } }), res);

      assert.equal(calls.accept.length, 1);
      assert.equal(handleUtteranceCalls, 2, 'a null return from confirm.accept must fall through to a normal handleUtterance call');
      assert.equal(res.body.choices[0].message.content, 'OK, treated as new.');
    });
  });
});
