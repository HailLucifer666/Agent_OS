'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools, registerFromResearch } = require('../src/core/effectors/from-research');

function fakeResearch() {
  const calls = [];
  return {
    calls,
    runResearch(topic, depth, opts) { calls.push({ topic, depth, opts }); return { id: 'research-x', stage: 'queued' }; },
    getResearch(id) { return id === 'research-x' ? { id, topic: 't', stage: 'done' } : (calls.length ? { id: 'latest', stage: 'done' } : null); },
    listResearch() { return calls.length ? [{ id: 'research-x' }] : []; },
  };
}

function toolMap(research) {
  const map = {};
  buildTools({ research }).forEach((t) => { map[t.name] = t; });
  return map;
}

test('run_research with a topic starts the orchestrator and threads runCtx', async () => {
  const research = fakeResearch();
  const tools = toolMap(research);
  const r = await tools.run_research.fn({ topic: 'Local LLMs', depth: 'deep' }, { goalId: 7, connectionId: 'c1' });
  assert.equal(r.ok, true);
  assert.equal(r.result.researchId, 'research-x');
  assert.equal(research.calls[0].topic, 'Local LLMs');
  assert.equal(research.calls[0].depth, 'deep');
  assert.equal(research.calls[0].opts.goalId, 7);
  assert.equal(research.calls[0].opts.connectionId, 'c1');
});

test('run_research with a missing topic → ok:false', async () => {
  const tools = toolMap(fakeResearch());
  const r = await tools.run_research.fn({}, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /topic/i);
});

test('research_status with no runs → ok:false', async () => {
  const tools = toolMap(fakeResearch());
  const r = await tools.research_status.fn({}, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /No research/i);
});

test('research_status for a known id → ok:true', async () => {
  const tools = toolMap(fakeResearch());
  const r = await tools.research_status.fn({ researchId: 'research-x' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.result.stage, 'done');
});

test('registerFromResearch registers both tools on the hub', () => {
  const registered = [];
  const hub = { register: (e) => registered.push(e.id) };
  const n = registerFromResearch(hub, { research: fakeResearch() });
  assert.equal(n, 2);
  assert.deepEqual(registered.sort(), ['research_status', 'run_research']);
});

test('run_research and research_status are both danger:false', () => {
  const tools = buildTools({ research: fakeResearch() });
  tools.forEach((t) => assert.equal(t.danger, false));
});
