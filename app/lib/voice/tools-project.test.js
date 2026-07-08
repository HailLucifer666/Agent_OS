// tools-project.test.js — unit tests for the voice-driven auto-pipeline tool.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function mockPipeline(overrides = {}) {
  const cards = new Map();
  const stages = new Map();
  const base = {
    capture: (text, origin) => {
      const id = `pipe-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const card = { id, text, origin, stage: 'capture', progress: 0, tags: [], created: new Date().toISOString() };
      cards.set(id, card);
      stages.set(id, 'capture');
      return card;
    },
    approve: (id) => {
      stages.set(id, 'execute');
      const card = cards.get(id);
      if (card) { card.stage = 'execute'; card.progress = 10; }
      return card;
    },
    findCard: (id) => {
      const card = cards.get(id);
      if (!card) return null;
      return { card, stage: stages.get(id) || 'capture', file: `Pipeline/${stages.get(id) || 'capture'}/${id}.json` };
    },
  };
  return { ...base, ...overrides };
}

function mockAgentActions(overrides = {}) {
  return {
    executePipelineCard: (cardId) => {
      return { job: { id: `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`, kind: 'pipeline-execute', cardId, status: 'queued', stage: 'queued' }, board: {} };
    },
    ...overrides,
  };
}

describe('tools-project', () => {
  test('start_project captures with origin:"voice", approves, and enqueues', async () => {
    const pipelineStub = mockPipeline();
    const actionsStub = mockAgentActions();
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    require.cache[require.resolve('../agent-actions')] = { exports: actionsStub };
    delete require.cache[require.resolve('./tools-project')];
    const { TOOLS } = require('./tools-project');
    const fn = TOOLS.find((t) => t.name === 'start_project').fn;
    const result = await fn({ description: 'make me a snake game' });
    assert.equal(result.ok, true);
    assert.ok(result.cardId);
    assert.ok(result.jobId);
    assert.equal(result.clearIntake, true);
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('../agent-actions')];
    delete require.cache[require.resolve('./tools-project')];
  });

  test('start_project returns ok:false for empty description without throwing', async () => {
    const pipelineStub = mockPipeline();
    const actionsStub = mockAgentActions();
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    require.cache[require.resolve('../agent-actions')] = { exports: actionsStub };
    delete require.cache[require.resolve('./tools-project')];
    const { TOOLS } = require('./tools-project');
    const fn = TOOLS.find((t) => t.name === 'start_project').fn;
    const result = await fn({ description: '' });
    assert.equal(result.ok, false);
    assert.ok(result.summary.includes('required'));
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('../agent-actions')];
    delete require.cache[require.resolve('./tools-project')];
  });

  test('start_project returns ok:false when executePipelineCard throws, without throwing itself', async () => {
    const pipelineStub = mockPipeline();
    const actionsStub = mockAgentActions({
      executePipelineCard: () => { throw new Error('orchestrator down'); },
    });
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    require.cache[require.resolve('../agent-actions')] = { exports: actionsStub };
    delete require.cache[require.resolve('./tools-project')];
    const { TOOLS } = require('./tools-project');
    const fn = TOOLS.find((t) => t.name === 'start_project').fn;
    const result = await fn({ description: 'make me a game' });
    assert.equal(result.ok, false);
    assert.ok(result.summary.includes('Could not start project'));
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('../agent-actions')];
    delete require.cache[require.resolve('./tools-project')];
  });

  test('tool catalog shape is valid: name/description/params/danger/fn', () => {
    const { TOOLS } = require('./tools-project');
    assert.ok(Array.isArray(TOOLS));
    const tool = TOOLS[0];
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.params && typeof tool.params === 'object');
    assert.equal(typeof tool.danger, 'boolean');
    assert.equal(typeof tool.fn, 'function');
  });
});
