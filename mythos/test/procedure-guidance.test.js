'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillsStore } = require('../src/core/memory/skills');
const { buildTools } = require('../src/core/effectors/from-memory');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { _internal } = require('../src/core/voice/live-tools');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { createGoalSystem } = require('../src/core/goals');

function store() {
  const files = new Map();
  const fs = {
    ensureDir() {}, vaultPath: path => path,
    readJSON: path => files.has(path) ? JSON.parse(files.get(path)) : null,
    writeJSON: (path, value) => files.set(path, JSON.stringify(value)),
    writeText: (path, text) => files.set(path, text),
    readText: path => files.get(path),
    listFiles: (dir = 'Skills') => [...files.keys()].filter(path => path.startsWith(dir + '/')).map(path => ({ path, name: path.split('/').pop() })),
    withLock: async (_, fn) => fn(),
  };
  const skills = createSkillsStore({ fs, config: {}, bus: { emit() {} } });
  return { skills, files, fs };
}
test('procedure parser preserves empty and nested JSON args written by its own writer', () => {
  const { skills } = store();
  const steps = [{ tool: 'read_status', args: {} }, { tool: 'widget', args: { data: { title: 'x' } } }];
  skills.write('status', { id: 'sk-good', when: ['status'], steps });
  assert.deepEqual(skills.get('sk-good').steps, steps);
});

test('CRLF procedure content has the same guidance as the writer output', () => {
  const { skills, files } = store();
  skills.write('clock', { id: 'clock', when: ['clock'], steps: [{ tool: 'get_time', args: {} }] });
  const before = skills.suggest('clock');
  files.set('Skills/clock.md', files.get('Skills/clock.md').replace(/\n/g, '\r\n'));
  assert.deepEqual(skills.suggest('clock'), before);
});

test('invalid historical metadata is flagged without rewriting its bytes', () => {
  const { skills, files } = store();
  for (const metadata of [
    { id: 42 }, { id: 'bad', uses: -1 }, { id: 'bad', uses: 'two' },
    { id: 'bad', successRate: 'unknown' }, { id: 'bad', successRate: 2 },
  ]) {
    const raw = '<!-- ' + JSON.stringify(metadata) + ' -->\n## When\n- clock\n## Steps\n- tool: get_time, args: {}\n';
    files.set('Skills/clock.md', raw);
    const result = skills.suggest('clock');
    assert.equal(result.suggestions.length, 0, JSON.stringify(metadata));
    assert.equal(result.flagged.length, 1);
    assert.equal(files.get('Skills/clock.md'), raw);
  }
});
test('suggestions use recall threshold and success eligibility without recording use or changing vault', async () => {
  const { skills, files } = store();
  for (const [id, uses, successRate] of [['new', 0, 0], ['failed', 2, 0.1], ['good', 2, 0.9]]) {
    skills.write(id, { id, when: ['music'], steps: [{ tool: 'read_status', args: {} }], uses, successRate });
  }
  const before = [...files];
  const tool = buildTools({ memory: { skills } }).find(t => t.name === 'suggest_procedures');
  const result = await tool.fn({ query: 'music' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.suggestions.map(s => s.skillRef), ['new', 'good']);
  assert.deepEqual(skills.suggest('music unmatched terms').suggestions, []);
  assert.deepEqual([...files], before);
  assert.equal((await tool.fn({ query: ' ' })).ok, false);
});
test('malformed and stale runtime targets are flagged, never supplied as guidance or rewritten', () => {
  const { skills, files } = store();
  skills.write('music', { id: 'pid', when: ['music'], steps: [{ tool: 'close_window', args: { pid: 4668 } }] });
  skills.write('pseudo', { id: 'pseudo', when: ['music() == true'], steps: [{ tool: 'read_status', args: {} }] });
  files.set('Skills/bad.md', '<!-- {"id":"bad"} -->\n## When\n- music\n## Steps\n- tool: click, args: {invalid}\n');
  const before = [...files];
  const result = skills.suggest('music');
  assert.equal(result.suggestions.length, 0);
  assert.equal(result.flagged.length, 3);
  assert.match(JSON.stringify(result.flagged), /runtime target/);
  assert.match(JSON.stringify(result.flagged), /invalid step JSON/);
  assert.match(JSON.stringify(result.flagged), /invalid When guidance/);
  assert.deepEqual([...files], before);
});
test('Live metadata is optional and does not replace required tool arguments', () => {
  const decl = _internal.toDeclaration({ name: 'read', params: { query: 'string' } }, true);
  assert.equal(decl.parameters.properties.skillRef.type, 'string');
  assert.deepEqual(decl.parameters.required, ['query']);
});
test('Live attribution requires returned suggestion and matching step; every action still passes leash', async () => {
  const gates = [], dispatched = [];
  const adapter = createLiveToolAdapter({
    leash: { check: decision => { gates.push(decision); return { allow: true, tier: 0 }; } },
    dispatchAction: async decision => { dispatched.push(decision); return { ok: true, result: decision.tool === 'suggest_procedures'
      ? { suggestions: [{ skillRef: 'sk-1', steps: [{ tool: 'open_web', args: {} }] }] } : {} }; },
    bus: { emit() {} }, logger: { info() {}, warn() {} }, connectionId: 'test',
    summarizeActionsForResult: () => '',
  });
  const send = async (id, name, args) => adapter.handleLiveToolCalls([{ id, name, args }], { sendToolResponse() {} });
  await send('1', 'suggest_procedures', { query: 'status' });
  await send('2', 'open_web', { skillRef: 'sk-1' });
  await send('3', 'get_time', { skillRef: 'sk-1' });
  await send('4', 'open_web', { skillRef: 'forged' });
  await send('5', 'open_web', { url: 'unrelated', skillRef: 'sk-1' });
  assert.equal(dispatched.length, 4, 'changing provenance cannot defeat duplicate suppression');
  assert.equal(dispatched[1].skillRef, 'sk-1');
  assert.deepEqual(dispatched[1].args, {});
  assert.equal(dispatched[2].skillRef, undefined);
  assert.equal(gates[1].skillRef, 'sk-1');
  assert.equal(dispatched[3].skillRef, undefined, 'same tool with unrelated arguments must not improve stored procedure reliability');
});

test('real dispatch records only executed outcomes; denied, pending and unverified guidance actions do not count', async () => {
  const { skills } = store();
  skills.write('workflow', { id: 'sk-flow', when: ['workflow'], steps: ['denied', 'pending', 'unverified', 'success', 'failure'].map(url => ({ tool: 'open_web', args: { url } })) });
  const tool = buildTools({ memory: { skills } }).find(t => t.name === 'suggest_procedures');
  const bus = { emit() {} }, records = [];
  const memory = { skills, episodic: { write: row => records.push(row) }, audit: { write() {} } };
  let gate = 'allow', result = { ok: true, result: {} };
  const adapter = createLiveToolAdapter({
    leash: { check: decision => decision.tool === 'suggest_procedures' || gate === 'allow'
      ? { allow: true, tier: 0 } : { allow: false, requireConfirm: gate === 'confirm', tier: 3 },
    confirm: { create: () => 'confirm-procedure' } },
    dispatchAction: (decision, ctx) => dispatchAction(decision, { ...ctx, bus, memory,
      config: { ACTION_TIMEOUT_MS: 500 }, effectors: { breakers: { allow: () => true }, invoke: (_, args) => decision.tool === 'suggest_procedures' ? tool.fn(args) : result } }),
    bus, logger: { info() {}, warn() {} }, connectionId: 'test', summarizeActionsForResult: () => '',
  });
  let id = 0;
  const send = (name, args) => adapter.handleLiveToolCalls([{ id: String(++id), name, args }], { sendToolResponse() {} });
  await send('suggest_procedures', { query: 'workflow' });
  assert.equal(skills.get('sk-flow').uses, 0);
  gate = 'deny';
  await send('open_web', { url: 'denied', skillRef: 'sk-flow' });
  gate = 'confirm';
  await send('open_web', { url: 'pending', skillRef: 'sk-flow' });
  assert.equal(skills.get('sk-flow').uses, 0);
  gate = 'allow';
  result = { ok: true, unverified: true, reason: 'no independent oracle', result: {} };
  await send('open_web', { url: 'unverified', skillRef: 'sk-flow' });
  assert.equal(skills.get('sk-flow').uses, 0);
  result = { ok: true, result: {} };
  await send('open_web', { url: 'success', skillRef: 'sk-flow' });
  assert.equal(skills.get('sk-flow').uses, 1);
  assert.equal(skills.get('sk-flow').successRate, 1);
  result = { ok: false, result: { error: 'failed navigation' } };
  await send('open_web', { url: 'failure', skillRef: 'sk-flow' });
  assert.equal(skills.get('sk-flow').uses, 2);
  assert.equal(skills.get('sk-flow').successRate, 0.9);
  assert.equal(records.filter(row => row.skillRef === 'sk-flow').length, 3);
});

test('autonomous recall rejects entire malformed, pseudo-code and stale-target procedures without partial execution', async () => {
  for (const kind of ['malformed', 'pseudo', 'pid', 'valid']) {
    const { skills, files, fs } = store();
    skills.write('workflow', { id: 'sk-flow', when: [kind === 'pseudo' ? 'workflow() == true' : 'workflow'],
      steps: [{ tool: 'read_status', args: {} }, { tool: 'open_web', args: kind === 'pid' ? { targetPid: 1234 } : { url: 'example' } }] });
    if (kind === 'malformed') files.set('Skills/workflow.md', files.get('Skills/workflow.md') + '\n- tool: close_window, args: {broken}\n');
    const before = files.get('Skills/workflow.md'), events = [];
    const gs = createGoalSystem({ fs, config: {}, bus: { emit: (...args) => events.push(args) }, brain: null });
    const goal = gs.create({ title: 'workflow', drive: 'user-service' });
    const decision = await gs.plan(goal, { memory: { skills } });
    assert.equal(files.get('Skills/workflow.md'), before);
    if (kind === 'valid') {
      assert.equal(decision.tool, 'read_status');
      assert.equal(goal.plan.length, 2);
    } else {
      assert.equal(decision, null, kind + ' must not execute even its valid first step');
      assert.equal((goal.plan || []).length, 0);
      assert.ok(events.some(([name, payload]) => name === 'health.anomaly' && payload.kind === 'procedure-replay-rejected' && payload.warnings.length));
    }
  }
});
