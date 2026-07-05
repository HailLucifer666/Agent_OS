const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const kanban = require('./kanban');

describe('kanban.js', () => {
  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('empty vault → listBoard() returns {cards: []}', () => {
    const board = kanban.listBoard();
    assert.deepEqual(board, { cards: [] });
  });

  test('addCard("My task") → card in backlog with trimmed title, ISO created, id prefix', () => {
    const card = kanban.addCard('  My task  ');
    assert.equal(card.lane, 'backlog');
    assert.equal(card.title, 'My task');
    assert.equal(typeof card.created, 'string');
    assert.ok(!Number.isNaN(Date.parse(card.created)), 'created parses as ISO');
    assert.ok(card.id.startsWith('card-'), `id starts with card-: ${card.id}`);
    const board = kanban.listBoard();
    assert.ok(board.cards.some((c) => c.id === card.id));
  });

  test('addCard("X", "review") → explicit lane honored', () => {
    const card = kanban.addCard('X', 'review');
    assert.equal(card.lane, 'review');
  });

  test('addCard("X", "nonsense") → invalid lane falls back to backlog', () => {
    const card = kanban.addCard('X', 'nonsense');
    assert.equal(card.lane, 'backlog');
  });

  test('moveCard(id, "done") → lane changes to done', () => {
    const card = kanban.addCard('mover');
    const moved = kanban.moveCard(card.id, 'done');
    assert.equal(moved.lane, 'done');
    assert.equal(kanban.findCard(card.id).lane, 'done');
  });

  test('moveCard(id, "invalid") → throws "invalid lane"', () => {
    const card = kanban.addCard('guard');
    assert.throws(
      () => kanban.moveCard(card.id, 'invalid'),
      { message: /invalid lane/ },
    );
  });

  test('moveCard("nonexistent-id", "backlog") → throws "card not found"', () => {
    assert.throws(
      () => kanban.moveCard('nonexistent-id', 'backlog'),
      { message: /card not found/ },
    );
  });

  test('addCards([{title:a},{title:b},{title:c}]) → returns 3 cards, all in board', () => {
    const created = kanban.addCards([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    assert.equal(created.length, 3);
    const board = kanban.listBoard();
    for (const c of created) {
      assert.ok(board.cards.some((x) => x.id === c.id));
    }
  });

  test('addCards truncates title to 200 and detail to 2000', () => {
    const longTitle = 'T'.repeat(500);
    const longDetail = 'D'.repeat(5000);
    const [card] = kanban.addCards([{ title: longTitle, detail: longDetail }]);
    assert.equal(card.title.length, 200);
    assert.equal(card.detail.length, 2000);
  });

  test('patchCard merges fields onto card', () => {
    const card = kanban.addCard('patch me');
    const patched = kanban.patchCard(card.id, { lane: 'review', builderOutput: 'x' });
    assert.equal(patched.lane, 'review');
    assert.equal(patched.builderOutput, 'x');
    const refound = kanban.findCard(card.id);
    assert.equal(refound.builderOutput, 'x');
  });

  test('patchCard("bad-id", {}) → throws "card not found"', () => {
    assert.throws(
      () => kanban.patchCard('bad-id', {}),
      { message: /card not found/ },
    );
  });

  test('deleteCard removes the card from the board', () => {
    const card = kanban.addCard('doomed');
    kanban.deleteCard(card.id);
    assert.equal(kanban.findCard(card.id), null);
    const board = kanban.listBoard();
    assert.ok(!board.cards.some((c) => c.id === card.id));
  });

  test('findCard returns the card or null', () => {
    const card = kanban.addCard('finder');
    assert.equal(kanban.findCard(card.id).id, card.id);
    assert.equal(kanban.findCard('nope'), null);
  });
});
