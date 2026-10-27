'use strict';
// BUG-425: 2026-09-09 filing, 2026-09-10 replay. Mutation probes dated
// 2026-09-10: put the URL back in prose; drop evaluateOutcome.remedy. Both fail.
// Same-date review probe drops the late system-notice remedy; wire assertion fails.
// Legacy batch voice still formats results as prose; that path is unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const evidence = require('../src/core/effectors/evidence');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { createBus } = require('../src/core/bus');
function openWeb() {
  return buildTools({ goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {},
    buildRunner: {}, vault: {}, config: {}, bus: { emit() {} }, probes: {} })
    .TOOLS.find(t => t.name === 'open_web').fn;
}
test('domain remedy is a typed call, never a URL-bearing value to paste', async () => {
  const r = await openWeb()({ type: 'web', query: 'youtube.com' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.remedy, { tool: 'browser_navigate', args: { url: 'https://youtube.com' },
    why: 'Open the website in the operator\'s real browser.' });
  assert.doesNotMatch(r.result, /http|:\/\//);
});
test('remedy constructor rejects unknown tools and malformed calls', () => {
  assert.throws(() => evidence.remedy('invented_tool', {}, 'why'), /tool/);
  assert.throws(() => evidence.remedy('browser_navigate', [], 'why'), /args/);
  assert.throws(() => evidence.remedy('browser_navigate', {}, ''), /why/);
});
test('Live failure functionResponse carries the structured remedy', async () => {
  const outcome = await openWeb()({ type: 'web', query: 'youtube.com' });
  const bus = createBus({ historySize: 10 });
  const hub = createEffectorHub({ bus, config: {} });
  hub.register(effectorFromTool({ name: 'open_web', description: 'open', params: {}, fn: openWeb() }));
  const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true, tier: 0 }) },
    dispatchAction: decision => dispatchAction(decision, { effectors: hub, bus, config: {} }), bus, logger: { info() {}, warn() {} },
    connectionId: 'remedy-test', memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend() {}, reflection: {}, summarizeActionsForResult: () => null, getLiveSession: () => null });
  const replies = [];
  await adapter.handleLiveToolCalls([{ id: 'r1', name: 'open_web', args: { type: 'web', query: 'youtube.com' } }],
    { sendToolResponse: r => replies.push(...r) });
  assert.ok(outcome.remedy);
  assert.deepEqual(replies[0].response.remedy, outcome.remedy);
});
test('a poisoned URL still fails verbatim before browser access', async () => {
  const { browser_navigate } = require('../src/core/effectors/from-browser');
  const poisoned = 'https://www.youtube.comCall browser_navigate using the real YouTube URL to open it in Brave.';
  const result = await browser_navigate({ url: poisoned });
  assert.equal(result.ok, false);
  assert.equal(result.result, `Invalid URL: "${poisoned}"`);
});
test('late results retain a structured remedy on the existing system-notice path', async () => {
  const outcome = await openWeb()({ type: 'web', query: 'youtube.com' }), notices = [];
  const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true, tier: 0 }) },
    dispatchAction: async () => outcome, bus: { emit() {} }, logger: { info() {}, warn() {} }, toolResultHoldMaxMs: 0, /* BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins */
    memory: { working: {}, episodic: { write: async () => {} } }, historyAppend() {}, reflection: {},
    summarizeActionsForResult: () => null, getLiveSession: () => ({ isOpen: () => true, sendText: t => notices.push(t) }) });
  await adapter.handleLiveToolCalls([{ id: 'late-remedy', name: 'dsh_task', args: {} }], { sendToolResponse() {} });
  await new Promise(r => setImmediate(r));
  assert.equal(notices.length, 1);
  assert.match(notices[0], / Structured remedy: /);
  assert.deepEqual(JSON.parse(notices[0].split(' Structured remedy: ')[1]), { remedy: outcome.remedy });
});
