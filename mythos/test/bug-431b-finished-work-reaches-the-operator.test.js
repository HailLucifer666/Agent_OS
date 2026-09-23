'use strict';
// Filed 2026-09-09; replayed 2026-09-10. Mutation probes (2026-09-10): remove
// late speech or laneFallback in sensors/job -> wire red while unit stays green.
// Review probes, same date: remove sanitizer, per-call DSH selection, voice
// rollback, or rejected-send fallback; bury model facts after a long reply. Red.
// No retry of a notice lost during rotation: the operator hears the outcome,
// but the model's context cannot receive it without a new open session (H8).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lateOutcomeSpeech } = require('../src/core/voice/action-outcome-summary');
const { completionForJob } = require('../src/core/effectors/completion-status');
const { createJobSensor } = require('../src/core/sensors/job');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { createConversationAnnouncer } = require('../src/core/conversation/announcer');
const { createBus } = require('../src/core/bus');
const { createBuildEngine } = require('../src/core/effectors/build-engine');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
test('each build retains its own selected-model evidence across overlapping calls', async () => {
  const dir = tempVaultDir(); let finishFirst;
  const adapter = { runTask: async (_prompt, opts) => {
    if (!finishFirst) { opts.onModelSelected({ rejected: ['head'] }); return new Promise(r => { finishFirst = r; }); }
    opts.onModelSelected({ rejected: [] }); return '<h1>second</h1>';
  } };
  try {
    const engine = createBuildEngine({ engine: adapter, vault: createFsStore(() => dir, null) });
    const first = engine.generate({ prompt: 'first' });
    const second = await engine.generate({ prompt: 'second' });
    finishFirst('<h1>first</h1>');
    assert.equal((await first).laneFallback, true); assert.equal(second.laneFallback, false);
  } finally { cleanupVaultDir(dir); }
});
for (const enabled of [true, false]) test(`fallback completion narration honors voice rollback=${!enabled}`, async () => {
  const bus = createBus({ historySize: 30 }), spoken = [];
  const announcer = createConversationAnnouncer({ bus, config: { LIVE_VOICE_HONESTY_ENABLED: enabled }, brain: { think: async () => ({ offline: true }) }, speak: t => spoken.push(t) });
  announcer.start();
  try {
    bus.emit('perception.job', { jobId: 'fallback-job', status: 'done', reviewVerdict: 'approve', engine: 'dsh', laneFallback: true });
    await new Promise(r => setImmediate(r));
    assert.equal(spoken.length, 1);
    if (enabled) { assert.match(spoken[0], /fallback model/); assert.match(spoken[0], /attention/); }
    else { assert.doesNotMatch(spoken[0], /fallback model|attention/); assert.match(spoken[0], /ready/); }
  } finally { announcer.stop(); }
});
test('late speech is plain and fast outcomes stay silent', () => {
  assert.match(lateOutcomeSpeech('dsh_task', { ok: true, result: { summary: 'Built the page.' } }, 90000), /finished/i);
  assert.equal(lateOutcomeSpeech('dsh_task', { ok: true }, 100), null);
  assert.doesNotMatch(lateOutcomeSpeech('dsh_task', { ok: true }, 90000), /\[SYSTEM|\{/);
});
test('fallback model evidence survives the job sensor', () => {
  let update; const rows = [];
  const sensor = createJobSensor({ bus: { emit: (type, p) => rows.push(p) },
    buildRunner: { onJobUpdate: fn => { update = fn; return () => {}; } } });
  sensor.start(); update({ id: 'j1', kind: 'build', status: 'done', reviewVerdict: 'approve', engine: 'dsh', laneFallback: true });
  assert.equal(rows[0].laneFallback, true);
  assert.equal(completionForJob(rows[0]).status, 'needs-work'); sensor.stop();
});
test('closed Live speaks a slow outcome once; open Live sends only context', async () => {
  for (const [open, enabled, age, reject] of [[false, true, 90000], [true, true, 90000], [false, false, 90000], [false, true, 100], [true, true, 90000, true]]) {
    let resolve; const spoken = [], notices = [];
    let now = 0;
    const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true, tier: 0 }) },
      dispatchAction: () => new Promise(r => { resolve = r; }), bus: { emit() {} }, logger: { info() {}, warn() {} },
      memory: { working: {}, episodic: { write: async () => {} } }, historyAppend() {}, reflection: {},
      summarizeActionsForResult: () => null, now: () => now, config: { LIVE_VOICE_HONESTY_ENABLED: enabled },
      speakWhenClosed: text => spoken.push(text), getLiveSession: () => ({ isOpen: () => open, sendText: t => reject ? false : notices.push(t) }) });
    await adapter.handleLiveToolCalls([{ id: 'slow', name: 'dsh_task', args: {} }], { sendToolResponse() {} });
    now = age; resolve({ ok: true, result: 'page built' });
    await new Promise(r => setImmediate(r));
    assert.equal(spoken.length, (!open || reject) && enabled && age >= 30000 ? 1 : 0); assert.equal(notices.length, open && !reject ? 1 : 0);
    if (spoken.length) assert.doesNotMatch(spoken[0], /\[SYSTEM/);
  }
});
test('late failure speech passes through the adapter sanitizer', async () => {
  let resolve, now = 0; const spoken = [];
  const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true, tier: 0 }) },
    dispatchAction: () => new Promise(r => { resolve = r; }), bus: { emit() {} }, logger: { info() {}, warn() {} },
    memory: { working: {}, episodic: { write: async () => {} } }, historyAppend() {}, reflection: {},
    summarizeActionsForResult: () => null, now: () => now, getLiveSession: () => null,
    sanitizeErrorForClient: err => String(err.message || err).replaceAll('SECRET_PATH_MARKER', '[redacted]'),
    speakWhenClosed: text => spoken.push(text) });
  await adapter.handleLiveToolCalls([{ id: 'private-failure', name: 'dsh_task', args: {} }], { sendToolResponse() {} });
  now = 90000; resolve({ ok: false, result: 'Cannot read SECRET_PATH_MARKER' });
  await new Promise(r => setImmediate(r));
  assert.equal(spoken.length, 1); assert.doesNotMatch(spoken[0], /SECRET_PATH_MARKER/);
  assert.match(spoken[0], /\[redacted\]/);
});
for (const open of [false, true]) test(`real dsh_task keeps model evidence across overlap and long reply; Live open=${open}`, async () => {
  const engine = require('../adapters/dsh-agent'), beforeRun = engine.runTask, beforeStatus = engine.getStatus;
  const previousRoot = process.env.MYTHOS_DSH_TASK_ROOT, dir = tempVaultDir();
  process.env.MYTHOS_DSH_TASK_ROOT = dir;
  let finishFirst, selected, now = 0; const spoken = [], results = [], notices = [];
  engine.runTask = async (task, opts) => {
    selected = { model: task, rejected: task === 'first' ? ['head unavailable'] : [] };
    opts.onModelSelected?.(selected);
    return task === 'first' ? new Promise(r => { finishFirst = r; }) : 'second reply';
  };
  engine.getStatus = () => ({ state: 'ONLINE', model: selected });
  try {
    const tool = require('../src/core/effectors/from-dsh').buildTools()[0].fn;
    const adapter = createLiveToolAdapter({ leash: { check: () => ({ allow: true, tier: 0 }) },
      dispatchAction: () => tool({ task: 'first' }).then(r => { results.push(r); return r; }),
      bus: { emit() {} }, logger: { info() {}, warn() {} }, memory: { working: {}, episodic: { write: async () => {} } },
      historyAppend() {}, reflection: {}, summarizeActionsForResult: () => null, now: () => now,
      getLiveSession: () => ({ isOpen: () => open, sendText: t => notices.push(t) }), speakWhenClosed: t => spoken.push(t) });
    await adapter.handleLiveToolCalls([{ id: 'fallback-direct', name: 'dsh_task', args: {} }], { sendToolResponse() {} });
    await tool({ task: 'second' }); now = 90000; finishFirst('first reply '.repeat(1000));
    await new Promise(r => setImmediate(r));
    assert.equal(results[0].result.laneFallback, true);
    assert.equal(results[0].result.status.model.model, 'first');
    if (open) {
      assert.equal(spoken.length, 0); assert.equal(notices.length, 1);
      const notice = notices[0].replaceAll('\\"', '"');
      assert.match(notice, /"laneFallback":true/); assert.match(notice, /"model":"first"/);
    } else assert.match(spoken[0], /fallback model/);
  } finally {
    engine.runTask = beforeRun; engine.getStatus = beforeStatus;
    if (previousRoot === undefined) delete process.env.MYTHOS_DSH_TASK_ROOT; else process.env.MYTHOS_DSH_TASK_ROOT = previousRoot;
    cleanupVaultDir(dir);
  }
});
