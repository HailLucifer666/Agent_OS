'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopController } = require('../src/core/desktop/controller');
const { parseRequest } = require('../src/core/desktop/intent');
const { createGoalSystem } = require('../src/core/goals');
const { buildTools } = require('../src/core/effectors/from-desktop');
function rig(override, timing = {}) {
  const files = new Map();
  const goals = createGoalSystem({ fs: { writeJSON: (p, v) => files.set(p, structuredClone(v)) },
    config: {}, bus: { emit() {} }, memory: { episodic: { write() {} } }, brain: null });
  const calls = []; let reads = 0, played = false, paused = false;
  const ctx = { connectionId: 'actual-session' };
  const executeTool = async (name, args, context) => {
    calls.push({ name, args, context });
    if (override) { const custom = await override(name, args, context, calls); if (custom !== undefined) return custom; }
    if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'b', tabId: 1, url: 'https://www.youtube.com/results', active: true }] } };
    if (name === 'browser_click') { played = true; return { ok: true, result: { delivered: true } }; }
    if (name === 'browser_media_control') { played = true; paused = args.action === 'pause'; return { ok: true, result: {} }; }
    reads++;
    return { ok: true, result: {
      target: { browserId: 'b', tabId: 1, frameId: 0, documentId: 'doc', url: 'https://www.youtube.com/watch?v=third', observationId: 'o' + reads, generation: reads },
      items: [1, 2, 3].map((n) => ({ ref: 'ref' + n, videoId: n === 3 ? 'third' : 'other' + n, title: 'Video ' + n })),
      playback: { videoId: played ? 'third' : 'before', currentTime: reads, paused, ad: false },
    } };
  };
  const controller = createDesktopController({ goals, executeTool, wait: async () => {}, ...timing });
  return { controller, goals, files, calls, ctx, executeTool };
}
async function run(r, request = 'Play the third video on YouTube') {
  const ack = r.controller.start({ request }, r.ctx);
  assert.equal(ack.started, true);
  assert.equal(ack.result.state, 'running');
  return r.controller.settled(ack.result.taskId);
}
test('observed third selection completes only after fresh same-video playback progression', async () => {
  const r = rig(), result = await run(r);
  assert.equal(result.result.state, 'completed');
  const click = r.calls.find((c) => c.name === 'browser_click');
  assert.equal(click.args.ref, 'ref3');
  assert.equal(click.args.target.observationId, 'o1');
  assert.ok(r.calls.filter((c) => c.name === 'browser_video_list').length >= 3);
  assert.ok(r.calls.every((c) => c.context.goalId === result.result.taskId && c.context.connectionId === r.ctx.connectionId));
  assert.equal(result.result.evidence.oracle, 'page-state');
  assert.equal(r.files.get('Goals/' + result.result.taskId + '.json').execution.version, 1);
  assert.equal(r.goals.arbitrate([], {}), null, 'desktop execution cannot be selected by Cortex');
});
test('desktop owned goals are never planned even if passed directly to planner', async () => {
  const r = rig(), g = r.goals.create({ execution: { owner: 'desktop' }, status: 'active' });
  let called = false;
  assert.equal(r.goals.arbitrate([], {}), null, 'active desktop goals are excluded before planning');
  assert.equal(await r.goals.plan(g, { brain: { think() { called = true; } } }), null);
  assert.equal(called, false);
});
test('unverified writes stop without retry or completion claim', async () => {
  const r = rig((name) => name === 'browser_click' ? { ok: true, unverified: true, reason: 'unknown delivery' } : undefined);
  const result = await run(r);
  assert.equal(result.result.state, 'blocked');
  assert.equal(result.result.unknownWrite, true);
  assert.equal(r.calls.filter((c) => c.name === 'browser_click').length, 1);
  assert.equal(result.result.evidence, null);
  assert.equal(r.calls.at(-1).name, 'browser_click', 'an unknown write terminates the execution attempt');
});
test('fresh observation failures have exactly two retries and never reach writes', async () => {
  const r = rig((name) => name === 'browser_video_list' ? { ok: false, error: 'stale' } : undefined);
  assert.equal((await run(r)).result.state, 'blocked');
  assert.equal(r.calls.filter((c) => c.name === 'browser_video_list').length, 3);
  assert.equal(r.calls.filter((c) => c.name === 'browser_click').length, 0);
});
test('cancel is a barrier even when a write never resolves; late result cannot complete', async () => {
  let reached, resolveWrite;
  const writing = new Promise((resolve) => { reached = resolve; });
  const r = rig((name) => name === 'browser_click' ? new Promise((resolve) => { resolveWrite = resolve; reached(); }) : undefined);
  const ack = r.controller.start({ request: 'Play third on YouTube' }, r.ctx);
  await writing;
  const cancelled = await r.controller.control({ taskId: ack.result.taskId, action: 'cancel' }, r.ctx);
  const count = r.calls.length;
  assert.equal(cancelled.result.state, 'cancelled');
  assert.equal(cancelled.result.unknownWrite, true);
  resolveWrite({ ok: true, result: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.length, count);
  assert.equal(r.controller.status({ taskId: ack.result.taskId }, r.ctx).result.state, 'cancelled');
});
test('restarted in-flight task needs explicit resume and observes without replaying write', async () => {
  const r = rig();
  const goal = r.goals.create({ status: 'active', execution: { owner: 'desktop', version: 1, state: 'running', phase: 'acting', steps: 2,
    intent: { kind: 'play-third' }, target: { browserId: 'b', tabId: 1 }, expected: { kind: 'playing', videoId: 'third' } } });
  assert.equal(r.controller.status({ taskId: goal.id }, r.ctx).result.requiresResume, true, 'restart discovery is read-only and requires explicit ownership claim');
  assert.equal(r.calls.length, 0);
  assert.equal((await r.controller.control({ taskId: goal.id, action: 'resume' }, r.ctx)).started, true);
  assert.equal((await r.controller.settled(goal.id)).result.state, 'blocked');
  assert.equal(r.calls.some((c) => c.name === 'browser_click'), false);
});
test('model supplied connection identity is ignored by public tool adapter', async () => {
  const r = rig(), tool = buildTools({ controller: r.controller }).find((t) => t.name === 'desktop_task_start');
  assert.equal((await tool.fn({ request: 'Play third on YouTube', connectionId: 'forged' }, {})).ok, false);
  assert.equal(r.calls.length, 0);
});
test('unsupported tasks and missing YouTube context remain closed', () => {
  assert.equal(parseRequest('Buy a laptop and enter payment details'), null);
  assert.equal(parseRequest('pause'), null);
  assert.equal(parseRequest('pause', true).kind, 'pause');
  assert.equal(parseRequest('next video on another app', true), null);
  assert.equal(parseRequest('Do not play the third video on YouTube'), null);
  assert.equal(parseRequest('Play third on YouTube and delete my files'), null);
});
test('pause and resume playback use observed target identity and state oracle', async () => {
  const r = rig(); await run(r);
  assert.equal((await run(r, 'pause')).result.state, 'completed');
  assert.equal((await run(r, 'resume')).result.state, 'completed');
  assert.deepEqual(r.calls.filter((c) => c.name === 'browser_media_control').map((c) => c.args.action), ['pause', 'resume']);
});

test('ad or stationary playback never proves success even when click reports delivery', async () => {
  for (const ad of [true, false]) {
    const r = rig((name) => name === 'browser_video_list' ? { ok: true, result: {
      target: { browserId: 'b', tabId: 1, url: 'https://www.youtube.com/watch?v=third', observationId: 'o' },
      items: [1, 2, 3].map((n) => ({ ref: 'ref' + n, videoId: 'third' })),
      playback: { videoId: 'third', paused: false, currentTime: 10, ad },
    } } : undefined);
    assert.equal((await run(r)).result.state, 'blocked');
    assert.equal(r.calls.filter((c) => c.name === 'browser_click').length, 1);
  }
});

test('next requires changed identity plus progression, never merely a delivered command', async () => {
  let after = false, time = 0;
  const r = rig((name) => {
    if (name === 'browser_media_control') { after = true; return { ok: true, result: {} }; }
    if (name === 'browser_video_list') return { ok: true, result: {
      target: { browserId: 'b', tabId: 1, url: 'https://www.youtube.com/watch?v=' + (after ? 'next' : 'old'), observationId: 'o' + time },
      playback: { videoId: after ? 'next' : 'old', currentTime: ++time, paused: false, ad: false },
    } };
  });
  assert.equal((await run(r, 'next youtube video')).result.state, 'completed');
  assert.equal(r.calls.filter((c) => c.name === 'browser_media_control').length, 1);
});

test('pause prevents pending read from advancing to write; explicit resume reobserves', async () => {
  let reached, release, first = true;
  const entered = new Promise((resolve) => { reached = resolve; });
  const r = rig((name) => {
    if (name === 'browser_video_list' && first) { first = false; return new Promise((resolve) => { release = resolve; reached(); }); }
  });
  const ack = r.controller.start({ request: 'Play third on YouTube' }, r.ctx);
  await entered;
  assert.equal((await r.controller.control({ taskId: ack.result.taskId, action: 'pause' }, r.ctx)).result.state, 'paused');
  release({ ok: false });
  assert.equal(r.calls.some((c) => c.name === 'browser_click'), false);
  await r.controller.control({ taskId: ack.result.taskId, action: 'resume' }, r.ctx);
  assert.equal((await r.controller.settled(ack.result.taskId)).result.state, 'completed');
});

test('persisted exhausted budget blocks before any leaf and unknown record versions stay closed', async () => {
  const r = rig();
  const execution = { version: 1, owner: 'desktop', state: 'paused', phase: 'observing', intent: { kind: 'pause' }, steps: 0 };
  const g = r.goals.create({ execution, budget: { actions: 0 } });
  await r.controller.control({ taskId: g.id, action: 'resume' }, r.ctx);
  assert.equal((await r.controller.settled(g.id)).result.state, 'blocked');
  assert.equal(r.calls.length, 0);
  const future = r.goals.create({ execution: { ...execution, version: 2 } });
  assert.equal((await r.controller.control({ taskId: future.id, action: 'resume' }, r.ctx)).ok, false);
});

test('YouTube absent opens new tab only in unique active browser and reobserves it', async () => {
  const r = rig((name, args) => {
    if (name === 'browser_tabs' && args.action === 'new') return { ok: true, result: { target: { browserId: 'b', tabId: 1 } } };
    if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'b', tabId: 9, active: true, url: 'https://example.org' }] } };
  });
  assert.equal((await run(r, 'Open YouTube')).result.state, 'completed');
  const opened = r.calls.find((c) => c.args.action === 'new');
  assert.equal(opened.args.browserId, 'b');
  assert.equal(opened.args.url, 'https://www.youtube.com/');
  assert.ok(r.calls.findIndex((c) => c.name === 'browser_video_list') > r.calls.indexOf(opened));
  assert.equal(r.calls.some((c) => c.name === 'browser_navigate'), false, 'unrelated current tab is not replaced');
});

test('latest task context and control authority do not cross operator connections', async () => {
  const r = rig(), result = await run(r);
  const stranger = { connectionId: 'another-session' };
  assert.equal(r.controller.status({ taskId: result.result.taskId }, stranger).ok, false);
  assert.equal((await r.controller.control({ taskId: result.result.taskId, action: 'cancel' }, stranger)).ok, false);
  assert.equal(r.controller.status({ taskId: result.result.taskId }, r.ctx).result.state, 'completed', 'rejected control cannot mutate the owner task');
  assert.equal(r.controller.start({ request: 'pause' }, stranger).ok, false, 'other session cannot inherit media context');
  assert.equal(r.controller.status({}, r.ctx).result.taskId, result.result.taskId);
});

test('contextual third request retains owned tab after focus moves to another YouTube tab', async () => {
  let listings = 0;
  const r = rig((name) => {
    if (name === 'browser_tabs') {
      listings++;
      return { ok: true, result: { tabs: [
        { browserId: 'b', tabId: 1, active: listings === 1, url: 'https://www.youtube.com/results' },
        { browserId: 'b', tabId: 2, active: listings !== 1, url: 'https://www.youtube.com/results' },
      ] } };
    }
  });
  await run(r);
  assert.equal((await run(r, 'play the third video')).result.state, 'completed');
  assert.equal(listings, 1, 'contextual task must not choose the newly focused tab');
  assert.ok(r.calls.filter((c) => c.name === 'browser_click').every((c) => c.args.target.tabId === 1));
});

test('ambiguous observed video lists refuse selection without any click', async () => {
  const r = rig((name) => name === 'browser_video_list' ? { ok: true, result: {
    ambiguous: true, target: { browserId: 'b', tabId: 1, url: 'https://www.youtube.com/', observationId: 'o' },
    items: [1, 2, 3].map((n) => ({ ref: 'ref' + n, videoId: 'video' + n })), playback: null,
  } } : undefined);
  assert.equal((await run(r)).result.state, 'blocked');
  assert.equal(r.calls.some((c) => c.name === 'browser_click'), false);
});

test('hydration and navigation readiness can each take 1.5 seconds without repeating the click', async () => {
  let clock = 0, clickedAt = null, serial = 0;
  const r = rig((name) => {
    if (name === 'browser_click') { clickedAt = clock; return { ok: true, result: {} }; }
    if (name !== 'browser_video_list') return;
    const ready = clock >= 1500, playing = clickedAt !== null && clock - clickedAt >= 1500;
    return { ok: true, result: {
      target: { browserId: 'b', tabId: 1, observationId: 'fresh-' + ++serial, url: 'https://www.youtube.com/results' },
      items: ready ? [1, 2, 3].map(n => ({ ref: 'r' + n, videoId: n === 3 ? 'third' : 'other' + n })) : [],
      playback: { videoId: playing ? 'third' : 'before', paused: !playing, ad: false, currentTime: playing ? clock - clickedAt : 0 },
    } };
  }, { now: () => clock, wait: async ms => { clock += ms; } });
  const result = await run(r);
  assert.equal(result.result.state, 'completed', result.result.reason);
  assert.ok(clickedAt >= 1500, 'empty loading results are observed again before mutation');
  assert.ok(clock - clickedAt > 1500, 'navigation must settle then demonstrate advancing time');
  assert.equal(r.calls.filter(c => c.name === 'browser_click').length, 1);
  assert.ok(r.calls.length <= 16); assert.ok(clock < 30000);
});
test('permanently empty results exhaust bounded read readiness without mutation', async () => {
  let clock = 0;
  const r = rig(name => name === 'browser_video_list' ? { ok: true, result: {
    target: { browserId: 'b', tabId: 1, observationId: 'fresh-' + clock, url: 'https://www.youtube.com/results' }, items: [],
  } } : undefined, { now: () => clock, wait: async ms => { clock += ms; } });
  const result = await run(r);
  assert.equal(result.result.state, 'blocked'); assert.equal(result.result.evidence, null);
  assert.match(result.result.reason, /Requested result 3 never appeared in the observed list/);
  assert.equal(r.calls.some(c => c.name === 'browser_click'), false);
  assert.ok(r.calls.length <= 16); assert.ok(clock < 30000);
});
test('cancellation releases a pending readiness wait without waiting for its timer', async () => {
  let waiting;
  const reachedWait = new Promise(resolve => { waiting = resolve; });
  const r = rig(undefined, { wait: () => { waiting(); return new Promise(() => {}); } });
  const ack = r.controller.start({ request: 'Play third on YouTube' }, r.ctx);
  await reachedWait;
  const outcome = await r.controller.control({ taskId: ack.result.taskId, action: 'cancel' }, r.ctx);
  assert.equal(outcome.result.state, 'cancelled');
  assert.equal(r.calls.filter(c => c.name === 'browser_click').length, 1);
  assert.equal(outcome.result.evidence, null);
});
test('disconnect pauses in-flight ownership and only explicit reconnect resume can reclaim it', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const r = rig(name => name === 'browser_click' ? (started(), new Promise(() => {})) : undefined);
  const ack = r.controller.start({ request: 'Play third on YouTube' }, r.ctx);
  await ready;
  const fresh = { connectionId: 'reconnected' };
  assert.equal((await r.controller.control({ taskId: ack.result.taskId, action: 'resume' }, fresh)).ok, false);
  await r.controller.disconnect(r.ctx.connectionId);
  assert.equal(r.goals.get(ack.result.taskId).execution.state, 'paused');
  assert.equal(r.controller.status({}, r.ctx).ok, false);
  assert.equal(r.controller.start({ request: 'Open YouTube' }, r.ctx).ok, false);
  assert.equal((await r.controller.control({ taskId: ack.result.taskId, action: 'resume' }, r.ctx)).ok, false);
  assert.equal((await r.controller.control({ taskId: ack.result.taskId, action: 'pause' }, fresh)).ok, false);
  assert.equal((await r.controller.control({ taskId: ack.result.taskId, action: 'resume' }, fresh)).started, true);
  await r.controller.settled(ack.result.taskId);
  assert.equal(r.calls.filter(c => c.name === 'browser_click').length, 1, 'unknown prior write is only observed on reconnect');
});
test('trusted durable request key prevents replay across reconnect and full goal reload', async () => {
  const r = rig();
  const ack = r.controller.start({ request: 'Next YouTube video' }, { ...r.ctx, requestId: 'durable-next' });
  await r.controller.settled(ack.result.taskId);
  assert.equal(r.calls.filter(c => c.name === 'browser_media_control').length, 1);
  await r.controller.disconnect(r.ctx.connectionId);
  const fresh = { connectionId: 'reconnected', requestId: 'durable-next' };
  for (const request of ['Next YouTube video', 'Open YouTube']) {
    const duplicate = r.controller.start({ request }, fresh);
    assert.equal(duplicate.ok, false); assert.equal(duplicate.taskId, ack.result.taskId);
  }
  const restoredGoals = createGoalSystem({ fs: { ensureDir() {}, listFiles: () => [...r.files.keys()].map(path => ({ path })),
    readJSON: path => structuredClone(r.files.get(path)), writeJSON: (path, value) => r.files.set(path, structuredClone(value)) }, config: {}, bus: { emit() {} } });
  await restoredGoals.init();
  const restored = createDesktopController({ goals: restoredGoals, executeTool: r.executeTool, wait: async () => {} });
  assert.equal(restored.start({ request: 'Next YouTube video' }, fresh).taskId, ack.result.taskId);
  assert.equal(r.calls.filter(c => c.name === 'browser_media_control').length, 1);
  const next = restored.start({ request: 'Open YouTube' }, { ...fresh, requestId: 'explicit-new-request' });
  assert.equal(next.started, true); assert.equal((await restored.settled(next.result.taskId)).result.state, 'completed');
});
test('request keys are bounded trusted context only; model arguments cannot forge them', async () => {
  const r = rig();
  for (const requestId of ['', ' ', 'x'.repeat(161), 7]) assert.equal(r.controller.start({ request: 'Open YouTube' }, { ...r.ctx, requestId }).ok, false);
  assert.equal(r.calls.length, 0);
  const tool = buildTools({ controller: r.controller }).find(t => t.name === 'desktop_task_start');
  const ack = await tool.fn({ request: 'Open YouTube', requestId: 'forged' }, { ...r.ctx, requestId: 'trusted' });
  await r.controller.settled(ack.result.taskId);
  assert.equal(r.goals.get(ack.result.taskId).execution.requestId, 'trusted');
});

test('restart discovery selects newest unowned pending task without granting authority or exposing live owners', async () => {
  const r = rig();
  const old = r.goals.create({ title: 'Older request', execution: { owner: 'desktop', version: 1, state: 'paused', intent: { kind: 'open-youtube' }, steps: 0, updatedAt: 1 } });
  const recent = r.goals.create({ title: 'Open YouTube after restart', execution: { owner: 'desktop', version: 1, state: 'running', intent: { kind: 'open-youtube' }, steps: 0, updatedAt: 2 } });
  const ctx = { connectionId: 'new-connection' };
  const discovered = r.controller.status({}, ctx);
  assert.equal(discovered.result.taskId, recent.id); assert.equal(discovered.result.request, recent.title);
  assert.equal(discovered.result.state, 'paused'); assert.equal(discovered.result.requiresResume, true);
  assert.equal(r.calls.length, 0);
  assert.equal((await r.controller.control({ taskId: recent.id, action: 'pause' }, ctx)).ok, false, 'discovery cannot confer authority');
  assert.equal(r.controller.status({}, { connectionId: 'system' }).ok, false);
  assert.equal((await r.controller.control({ taskId: recent.id, action: 'resume' }, ctx)).started, true);
  assert.equal(r.controller.status({ taskId: recent.id }, r.ctx).ok, false, 'live owner cannot be inspected by other connection');
  assert.equal((await r.controller.settled(recent.id)).result.state, 'completed');
  assert.equal(r.controller.status({}, r.ctx).result.taskId, old.id);
  assert.ok(r.calls.some(c => c.name === 'browser_video_list'));
});
