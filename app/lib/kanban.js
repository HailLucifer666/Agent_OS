// kanban.js — Agent Kanban board CRUD persisted to vault/Kanban.json
const vault = require('./vault');

const FILE = 'Kanban.json';
const LANES = ['backlog', 'building', 'review', 'done'];

function load() {
  return vault.readJSON(FILE, { cards: [] });
}

function save(board) {
  vault.writeJSON(FILE, board);
}

function listBoard() {
  return load();
}

function addCard(title, lane = 'backlog') {
  const board = load();
  const card = {
    id: `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: title.trim(),
    lane: LANES.includes(lane) ? lane : 'backlog',
    created: new Date().toISOString(),
  };
  board.cards.push(card);
  save(board);
  return card;
}

function moveCard(id, lane) {
  if (!LANES.includes(lane)) throw new Error('invalid lane');
  const board = load();
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new Error('card not found');
  card.lane = lane;
  save(board);
  return card;
}

function deleteCard(id) {
  const board = load();
  board.cards = board.cards.filter((c) => c.id !== id);
  save(board);
}

function addCards(specs, lane = 'backlog') {
  const board = load();
  const created = specs.map((spec) => ({
    id: `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: String(spec.title || '').trim().slice(0, 200),
    detail: String(spec.detail || '').trim().slice(0, 2000),
    lane: LANES.includes(lane) ? lane : 'backlog',
    created: new Date().toISOString(),
  }));
  board.cards.push(...created);
  save(board);
  return created;
}

function findCard(id) {
  const board = load();
  return board.cards.find((c) => c.id === id) || null;
}

function patchCard(id, patch) {
  const board = load();
  const card = board.cards.find((c) => c.id === id);
  if (!card) throw new Error('card not found');
  Object.assign(card, patch);
  save(board);
  return card;
}

module.exports = { LANES, listBoard, addCard, addCards, moveCard, patchCard, findCard, deleteCard, FILE };
