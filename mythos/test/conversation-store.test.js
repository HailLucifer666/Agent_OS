'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createConversationStore } = require('../src/core/voice/conversation-store');

const CFG = {
  CONVERSATION_MAX_TURNS: 4,
  CONVERSATION_TURN_MAX_CHARS: 20,
  CONVERSATION_TTL_MS: 600000,
  CONVERSATION_RETENTION_DAYS: 30,
};

describe('conversation-store — durable, TTL-served conversation memory', () => {
  let dir, bus, fs;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); });
  afterEach(() => cleanupVaultDir(dir));

  it('ring buffer caps at CONVERSATION_MAX_TURNS and truncates text', async () => {
    const c = createConversationStore({ fs, bus, config: CFG, logger: null });
    await c.init();
    for (let i = 0; i < 6; i++) c.appendTurn('user', 'turn-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxx');
    const turns = c.getRecentTurns();
    assert.equal(turns.length, 4);
    assert.ok(turns[0].content.length <= 20);
    assert.equal(turns[3].content.startsWith('turn-5'), true);
  });

  it('emits conversation.turn on append', async () => {
    const c = createConversationStore({ fs, bus, config: CFG, logger: null });
    await c.init();
    c.appendTurn('assistant', 'hello');
    assert.equal(bus._lastEvent('conversation.turn').payload.text, 'hello');
  });

  it('TTL clears the serving window but the JSONL trail persists', async () => {
    const c = createConversationStore({ fs, bus, config: Object.assign({}, CFG, { CONVERSATION_TTL_MS: -1 }), logger: null });
    await c.init();
    c.appendTurn('user', 'ephemeral');
    assert.deepEqual(c.getRecentTurns(), [], 'past TTL -> empty serving window');
    const onDisk = fs.readDirLines('Conversation', {});
    assert.equal(onDisk.filter(Boolean).some((e) => e.text === 'ephemeral'), true, 'JSONL trail retained');
  });

  it('restart round-trip: a fresh instance rehydrates the tail from disk', async () => {
    const a = createConversationStore({ fs, bus, config: CFG, logger: null });
    await a.init();
    a.appendTurn('user', 'remember me');
    a.appendTurn('assistant', 'i will');

    const b = createConversationStore({ fs, bus: fakeBus(), config: CFG, logger: null });
    await b.init();
    const turns = b.getRecentTurns();
    assert.equal(turns.length, 2);
    assert.equal(turns[0].content, 'remember me');
  });

  it('write failure emits a health.anomaly and does not throw', async () => {
    const throwingFs = Object.assign({}, fs, { appendLine: () => { throw new Error('disk full'); } });
    const c = createConversationStore({ fs: throwingFs, bus, config: CFG, logger: null });
    await c.init();
    assert.doesNotThrow(() => c.appendTurn('user', 'boom'));
    assert.equal(bus._lastEvent('health.anomaly').payload.store, 'conversation');
  });
});
