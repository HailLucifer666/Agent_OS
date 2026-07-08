// pipeline.js — "From Inbox to Shipped" capture/approve/execute flow.
// Cards live as individual JSON files under vault/Pipeline/<stage>/<id>.json
const fs = require('fs');
const path = require('path');
const vault = require('./vault');

const STAGES = ['capture', 'human-gate', 'execute', 'shipped'];

function stageDir(stage) {
  return path.join('Pipeline', stage);
}

function listStage(stage) {
  return vault.listFiles(stageDir(stage), '.json').map((f) => {
    return vault.readJSON(path.join(stageDir(stage), f.name), null);
  }).filter(Boolean);
}

function listAll() {
  const board = {};
  STAGES.forEach((s) => { board[s] = listStage(s); });
  return board;
}

function capture(text, origin = 'dashboard') {
  const id = `pipe-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const card = {
    id,
    text: text.trim(),
    stage: 'capture',
    progress: 0,
    tags: [],
    created: new Date().toISOString(),
    origin,
  };
  vault.writeJSON(path.join(stageDir('capture'), `${id}.json`), card);
  return card;
}

function findCard(id) {
  for (const stage of STAGES) {
    const file = path.join(stageDir(stage), `${id}.json`);
    const card = vault.readJSON(file, null);
    if (card) return { card, stage, file };
  }
  return null;
}

function moveCard(id, toStage, patch = {}) {
  if (!STAGES.includes(toStage)) throw new Error('invalid stage');
  const found = findCard(id);
  if (!found) throw new Error('card not found');
  const oldFile = vault.vaultPath(found.file);
  const updated = { ...found.card, ...patch, stage: toStage };
  vault.writeJSON(path.join(stageDir(toStage), `${id}.json`), updated);
  if (found.stage !== toStage) {
    try { fs.unlinkSync(oldFile); } catch { /* ignore missing */ }
  }
  return updated;
}

function approve(id) {
  return moveCard(id, 'execute', { progress: 10 });
}

function reject(id) {
  const found = findCard(id);
  if (!found) throw new Error('card not found');
  const file = vault.vaultPath(found.file);
  try { fs.unlinkSync(file); } catch { /* ignore missing */ }
  return { id, deleted: true };
}

function ship(id) {
  return moveCard(id, 'shipped', { progress: 100 });
}

module.exports = { STAGES, listAll, listStage, capture, approve, reject, ship, moveCard, findCard };
