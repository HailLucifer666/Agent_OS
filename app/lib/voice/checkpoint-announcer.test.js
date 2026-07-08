// checkpoint-announcer.test.js — unit tests for voice pipeline checkpoint announcements.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function mockPipeline(cards = {}) {
  return {
    findCard: (id) => {
      const card = cards[id];
      if (!card) return null;
      return { card, stage: 'execute', file: `Pipeline/execute/${id}.json` };
    },
  };
}

describe('checkpoint-announcer', () => {
  test('announces only voice-origin cards', async () => {
    const broadcasts = [];
    const pipelineStub = mockPipeline({
      'card-voice': { origin: 'voice', text: 'make me a game' },
      'card-dash': { origin: 'dashboard', text: 'dashboard build' },
    });
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    delete require.cache[require.resolve('./checkpoint-announcer')];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({ kind: 'pipeline-execute', cardId: 'card-voice', id: 'job-1', stage: 'generating' });
    await handler({ kind: 'pipeline-execute', cardId: 'card-dash', id: 'job-2', stage: 'generating' });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].cardId, 'card-voice');
    assert.equal(broadcasts[0].checkpoint, true);
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('./checkpoint-announcer')];
  });

  test('deduplicates per jobId:stage', async () => {
    const broadcasts = [];
    const pipelineStub = mockPipeline({ 'card-1': { origin: 'voice', text: 'game' } });
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    delete require.cache[require.resolve('./checkpoint-announcer')];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({ kind: 'pipeline-execute', cardId: 'card-1', id: 'job-1', stage: 'generating' });
    await handler({ kind: 'pipeline-execute', cardId: 'card-1', id: 'job-1', stage: 'generating' });
    assert.equal(broadcasts.length, 1);
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('./checkpoint-announcer')];
  });

  test('tts failure still broadcasts with audioB64:null', async () => {
    const broadcasts = [];
    const pipelineStub = mockPipeline({ 'card-1': { origin: 'voice', text: 'game' } });
    const mockTts = { speak: async () => { throw new Error('edge-tts down'); } };
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    require.cache[require.resolve('./tts')] = { exports: mockTts };
    delete require.cache[require.resolve('./checkpoint-announcer')];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({ kind: 'pipeline-execute', cardId: 'card-1', id: 'job-1', stage: 'generating' });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].audioB64, null);
    assert.equal(broadcasts[0].text, 'Building phase started.');
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('./tts')];
    delete require.cache[require.resolve('./checkpoint-announcer')];
  });

  test('silent for non-pipeline-execute jobs', async () => {
    const broadcasts = [];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({ kind: 'kanban-build', cardId: 'card-1', id: 'job-1', stage: 'generating' });
    assert.equal(broadcasts.length, 0);
  });

  test('silent for unknown cardId', async () => {
    const broadcasts = [];
    const pipelineStub = mockPipeline({});
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    delete require.cache[require.resolve('./checkpoint-announcer')];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({ kind: 'pipeline-execute', cardId: 'missing', id: 'job-1', stage: 'generating' });
    assert.equal(broadcasts.length, 0);
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('./checkpoint-announcer')];
  });

  test('done stage includes artifact title in spoken copy', async () => {
    const broadcasts = [];
    const pipelineStub = mockPipeline({ 'card-1': { origin: 'voice', text: 'game' } });
    require.cache[require.resolve('../pipeline')] = { exports: pipelineStub };
    delete require.cache[require.resolve('./checkpoint-announcer')];
    const { attach } = require('./checkpoint-announcer');
    const handler = attach((msg) => broadcasts.push(msg));
    await handler({
      kind: 'pipeline-execute', cardId: 'card-1', id: 'job-1', stage: 'done',
      artifact: { title: 'Neon Snake', path: '/vault/builds/pipeline/neon-snake.html' },
    });
    assert.equal(broadcasts.length, 1);
    assert.ok(broadcasts[0].text.includes('Neon Snake'));
    assert.equal(broadcasts[0].artifact.title, 'Neon Snake');
    delete require.cache[require.resolve('../pipeline')];
    delete require.cache[require.resolve('./checkpoint-announcer')];
  });
});
