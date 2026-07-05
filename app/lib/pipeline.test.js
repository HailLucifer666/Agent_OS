const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const pipeline = require('./pipeline');

describe('pipeline.js', () => {
  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('listAll() returns all 4 stages as empty arrays on a fresh vault', () => {
    const board = pipeline.listAll();
    assert.deepEqual(Object.keys(board).sort(), [...pipeline.STAGES].sort());
    assert.equal(board.capture.length, 0);
    assert.equal(board['human-gate'].length, 0);
    assert.equal(board.execute.length, 0);
    assert.equal(board.shipped.length, 0);
  });

  test('capture() creates a card with the right shape and trims text', () => {
    const card = pipeline.capture('  my idea  ');
    assert.equal(card.text, 'my idea');
    assert.equal(card.stage, 'capture');
    assert.equal(card.progress, 0);
    assert.deepEqual(card.tags, []);
    assert.ok(card.id.startsWith('pipe-'));
    assert.ok(!Number.isNaN(Date.parse(card.created)), 'created should be ISO-parseable');

    const all = pipeline.listAll();
    assert.ok(all.capture.some((c) => c.id === card.id), 'card should appear in capture');
  });

  test('moveCard() moves the card between stages and deletes the old file', () => {
    const card = pipeline.capture('move me');
    const before = pipeline.listAll().capture.length;

    const moved = pipeline.moveCard(card.id, 'human-gate', { progress: 5 });
    assert.equal(moved.stage, 'human-gate');
    assert.equal(moved.progress, 5);

    const after = pipeline.listAll();
    assert.equal(after.capture.length, before - 1, 'old stage should have one fewer card');
    assert.ok(after['human-gate'].some((c) => c.id === card.id), 'card should now be in human-gate');

    // Old file deleted — findCard still finds it, but only in the new stage.
    const found = pipeline.findCard(card.id);
    assert.ok(found, 'findCard should still locate the card');
    assert.equal(found.stage, 'human-gate');
    assert.ok(!after.capture.some((c) => c.id === card.id), 'card must not be in both stages');
  });

  test('moveCard() throws "invalid stage" for an unknown stage', () => {
    const card = pipeline.capture('oops');
    assert.throws(
      () => pipeline.moveCard(card.id, 'invalid-stage'),
      /invalid stage/,
    );
  });

  test('moveCard() throws "card not found" for a missing id', () => {
    assert.throws(
      () => pipeline.moveCard('nonexistent', 'capture'),
      /card not found/,
    );
  });

  test('approve() moves the card to execute with progress 10', () => {
    const card = pipeline.capture('approve me');
    const approved = pipeline.approve(card.id);
    assert.equal(approved.stage, 'execute');
    assert.equal(approved.progress, 10);
    assert.ok(pipeline.listAll().execute.some((c) => c.id === card.id));
  });

  test('reject() deletes the card entirely', () => {
    const card = pipeline.capture('reject me');
    const result = pipeline.reject(card.id);
    assert.deepEqual(result, { id: card.id, deleted: true });
    assert.equal(pipeline.findCard(card.id), null, 'findCard should return null after reject');
  });

  test('ship() moves the card to shipped with progress 100', () => {
    const card = pipeline.capture('ship me');
    const shipped = pipeline.ship(card.id);
    assert.equal(shipped.stage, 'shipped');
    assert.equal(shipped.progress, 100);
    assert.ok(pipeline.listAll().shipped.some((c) => c.id === card.id));
  });

  test('findCard() returns {card, stage, file} for an existing card, null otherwise', () => {
    const card = pipeline.capture('find me');
    const found = pipeline.findCard(card.id);
    assert.ok(found);
    assert.equal(found.card.id, card.id);
    assert.equal(found.stage, 'capture');
    assert.ok(found.file.includes('capture'), 'file path should include the stage dir');

    assert.equal(pipeline.findCard('does-not-exist'), null);
  });

  test('captured card persists with all fields intact on a fresh listAll()', () => {
    const card = pipeline.capture('persist me');
    const reloaded = pipeline.listAll().capture.find((c) => c.id === card.id);
    assert.ok(reloaded);
    assert.equal(reloaded.text, card.text);
    assert.equal(reloaded.stage, card.stage);
    assert.equal(reloaded.progress, card.progress);
    assert.deepEqual(reloaded.tags, card.tags);
    assert.equal(reloaded.created, card.created);
    assert.equal(reloaded.id, card.id);
  });
});
