'use strict';

// BUG-336 (2026-08-24): provider-fault classification in chain.js used three
// regexes over err.message prose alone. Incident B1 (2026-08-14, documented
// in chain.js) is the measured consequence: NIM sat at the head of the vision
// lane answering nothing for a whole day because "This operation was
// aborted" matched none of the patterns, so no cooldown was ever taken.
//
// Fix: classifyProviderError() reads typed identity first — err.kind,
// err.status (now attached at openai-compat/ollama/openrouter throw sites),
// libuv err.code — and demotes message-prose to a last-resort tier that the
// caller logs once per lane per hour, so wording drift becomes visible
// instead of silently deciding provider health.
//
// The regression proof is the table case with a status-carrying error whose
// MESSAGE matches nothing: pre-fix code had only prose, so it could not cool
// that provider down. Mutation proof: delete the status branch — that case
// flips to basis 'none' and this file goes red.

const test = require('node:test');
const assert = require('node:assert');

const chain = require('../src/core/brain/chain.js');
const classifyProviderError = chain._internal.classifyProviderError;

test('status-only errors classify even when the message matches no prose pattern', () => {
  // The B1-class regression case: typed status, unhelpful prose.
  const rateLimited = Object.assign(new Error('groq chat failed: quota exhausted for today'), { status: 429 });
  assert.deepStrictEqual(classifyProviderError(rateLimited), { basis: 'status', kind: 'rate-limit' });

  const serverDown = Object.assign(new Error('nim chat failed: upstream gave up'), { status: 503 });
  assert.deepStrictEqual(classifyProviderError(serverDown), { basis: 'status', kind: 'server' });
});

test('priority order: explicit kind beats status beats code beats prose', () => {
  assert.deepStrictEqual(
    classifyProviderError(Object.assign(new Error('contains : 429 prose'), { kind: 'network', status: 502 })),
    { basis: 'kind', kind: 'network' }
  );
  assert.deepStrictEqual(
    classifyProviderError(Object.assign(new Error('ECONNRESET while reading'), { code: 'ECONNRESET', message: 'plain words only' })),
    { basis: 'code', kind: 'network' }
  );
  assert.deepStrictEqual(
    classifyProviderError(new Error('nim chat failed: 429 too many requests')),
    { basis: 'prose', kind: 'rate-limit' },
    'legacy prose-only errors must still classify (backward compatibility)'
  );
});

test('non-provider faults stay unclassified so they never cool a healthy lane down', () => {
  assert.deepStrictEqual(classifyProviderError(new Error('This operation was aborted')), { basis: 'none', kind: null });
  const callerAbort = new Error('This operation was aborted');
  callerAbort.name = 'AbortError';
  assert.deepStrictEqual(classifyProviderError(callerAbort), { basis: 'none', kind: null });
  // A 400 prose message matches no fault tier: bad requests mean the provider
  // is healthy and the request was wrong (comment contract in chain.js).
  assert.deepStrictEqual(classifyProviderError(new Error('groq chat failed: 400 bad request shape')), { basis: 'none', kind: null });
});

test('4xx statuses other than 429 are not provider faults', () => {
  const badRequest = Object.assign(new Error('openai-compat chat failed: 400 bad shape'), { status: 400 });
  assert.notStrictEqual(classifyProviderError(badRequest).kind, 'rate-limit');
  assert.notStrictEqual(classifyProviderError(badRequest).kind, 'server');
});
