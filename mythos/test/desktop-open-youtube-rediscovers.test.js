'use strict';
// desktop-open-youtube-rediscovers.test.js — 2026-09-08.
//
// Live failure, 10:12Z: the first "open youtube" opened tab 847337688 and completed.
// The operator closed that tab and said "Open Youtube" again. The controller inherited
// the previous task's target for open-youtube, never called browser_tabs, observed the
// dead tab three times ("No tab with id: 847337688."), tripped the flapping breaker and
// blocked. The simple rule this pins: a fresh "open YouTube" always looks at the
// browser — reuse a live YouTube tab if there is one, open one if not — and never
// inherits a tab from an earlier task. Contextual verbs (pause, resume, next) still do.
//
// Mutation probe, 2026-09-08 (applied, seen to fail the first test, restored):
//   controller.start: give open-youtube `previous?.target` again -> "a fresh open
//   YouTube rediscovers tabs instead of inheriting the last task's tab" fails with the
//   dead-tab observation. The second test (pause still inherits) stays green under it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopController } = require('../src/core/desktop/controller');
const { createGoalSystem } = require('../src/core/goals');

function rig() {
  const goals = createGoalSystem({ fs: { writeJSON() {} }, config: {}, bus: { emit() {} }, memory: { episodic: { write() {} } }, brain: null });
  const calls = []; const ctx = { connectionId: 'operator' };
  const liveTabs = new Set(); let nextTab = 9; // no YouTube tab exists until a task opens one
  const observation = (tabId) => ({ ok: true, result: {
    target: { browserId: 'brave', tabId, frameId: 0, observationId: 'obs-' + tabId + '-' + calls.length, documentId: 'doc', url: 'https://www.youtube.com/', generation: 1 },
    ambiguous: false, items: [], playback: { videoId: null, currentTime: 0, paused: true, ad: false },
  } });
  const controller = createDesktopController({ goals, wait: async () => {}, executeTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_tabs' && args.action === 'new') { const tabId = nextTab++; liveTabs.add(tabId); return { ok: true, result: { target: { browserId: 'brave', tabId, frameId: 0 } } }; }
    if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'brave', tabId: 5, frameId: 0, active: true, url: 'https://example.com/' }] } };
    if (name === 'browser_video_list') return liveTabs.has(args.tabId) ? observation(args.tabId) : { ok: false, code: 'BROWSER_REFUSED', result: 'No tab with id: ' + args.tabId + '.' };
    return { ok: true, result: { commandAccepted: true } };
  } });
  return { controller, goals, calls, ctx, closeTab: (id) => liveTabs.delete(id) };
}
async function run(r, request) {
  const accepted = r.controller.start({ request }, r.ctx);
  assert.equal(accepted.started, true, request + ' must start: ' + JSON.stringify(accepted));
  return { taskId: accepted.result.taskId, state: (await r.controller.settled(accepted.result.taskId)).result };
}

test('a fresh open YouTube rediscovers tabs instead of inheriting the last task\'s tab', async () => {
  const r = rig();
  const first = await run(r, 'open youtube');
  assert.equal(first.state.state, 'completed');
  assert.equal(first.state.evidence.observed.tabId, 9);
  r.closeTab(9);
  const before = r.calls.length;
  const second = await run(r, 'Open Youtube');
  const later = r.calls.slice(before);
  assert.equal(second.state.state, 'completed', second.state.reason);
  assert.equal(later[0].name, 'browser_tabs', 'the second task must start by looking at the browser');
  assert.equal(later.some((c) => c.name === 'browser_video_list' && c.args.tabId === 9), false, 'the closed tab is never observed');
  assert.equal(second.state.evidence.observed.tabId, 10, 'a new YouTube tab was opened and proven');
});

test('contextual verbs still inherit the previous task\'s tab (adjacent case that must keep passing)', async () => {
  const r = rig();
  await run(r, 'open youtube');
  const accepted = r.controller.start({ request: 'pause' }, r.ctx);
  assert.equal(accepted.started, true);
  assert.equal(r.goals.get(accepted.result.taskId).execution.target.tabId, 9);
  await r.controller.settled(accepted.result.taskId);
});
