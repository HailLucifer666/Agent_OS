'use strict';

// effectors/kanban.js — CA of app/lib/kanban.js. Verbatim CRUD logic, re-pointed from
// the NOVA singleton `require('./vault')` to an injected fs-store — same re-pointing
// convention as effectors/pipeline.js (see that file's header comment).
//
// NOTE: `LANES` here (kanban board columns: backlog/building/review/done) is a
// different array from brain/chain.js's `LANES` (brain-lane names: build/simple/voice)
// — same name, unrelated concept. Do not conflate; chain.js's LANES is out of scope
// for this phase (Anti-Drift Checklist item #13).

var FILE = 'Kanban.json';
var LANES = ['backlog', 'building', 'review', 'done'];

function createKanbanEffector({ fs, bus }) {
  if (!fs || typeof fs.readJSONStrict !== 'function' || typeof fs.writeJSON !== 'function') {
    throw new Error('createKanbanEffector requires a vault fs-store with readJSONStrict/writeJSON');
  }

  // Strict read (2026-08-02 audit): Kanban.json is read-mutate-write — every CRUD
  // op loads the board, mutates it, and saves it back. A corrupt file read leniently
  // returns { cards: [] }, which the very next save() would write over the real board,
  // truncating every card behind ok:true (same class as the 2026-07-31 reminders fix).
  // load() now throws on corruption so the mutation refuses instead of wiping the store.
  function load() {
    try {
      return fs.readJSONStrict(FILE, { cards: [] });
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'kanban-read-failed', path: FILE, error: err.message });
      throw err;
    }
  }
  function save(board) { fs.writeJSON(FILE, board); }
  function listBoard() { return load(); }

  function addCard(title, lane) {
    lane = lane || 'backlog';
    var board = load();
    var card = {
      id: 'card-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title: String(title).trim(),
      lane: LANES.indexOf(lane) !== -1 ? lane : 'backlog',
      created: new Date().toISOString()
    };
    board.cards.push(card);
    save(board);
    return card;
  }

  function moveCard(id, lane) {
    if (LANES.indexOf(lane) === -1) throw new Error('invalid lane');
    var board = load();
    var card = board.cards.find(function(c) { return c.id === id; });
    if (!card) throw new Error('card not found');
    card.lane = lane;
    save(board);
    return card;
  }

  function deleteCard(id) {
    var board = load();
    board.cards = board.cards.filter(function(c) { return c.id !== id; });
    save(board);
  }

  function addCards(specs, lane) {
    lane = lane || 'backlog';
    var board = load();
    var created = specs.map(function(spec) {
      return {
        id: 'card-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: String(spec.title || '').trim().slice(0, 200),
        detail: String(spec.detail || '').trim().slice(0, 2000),
        lane: LANES.indexOf(lane) !== -1 ? lane : 'backlog',
        created: new Date().toISOString()
      };
    });
    board.cards.push.apply(board.cards, created);
    save(board);
    return created;
  }

  function findCard(id) {
    var board = load();
    return board.cards.find(function(c) { return c.id === id; }) || null;
  }

  function patchCard(id, patch) {
    var board = load();
    var card = board.cards.find(function(c) { return c.id === id; });
    if (!card) throw new Error('card not found');
    Object.assign(card, patch);
    save(board);
    return card;
  }

  return {
    LANES: LANES, listBoard: listBoard, addCard: addCard, addCards: addCards,
    moveCard: moveCard, patchCard: patchCard, findCard: findCard, deleteCard: deleteCard, FILE: FILE
  };
}

module.exports = { createKanbanEffector, LANES };
