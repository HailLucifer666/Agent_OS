'use strict';

// effectors/pipeline.js — CA of app/lib/pipeline.js. Verbatim CRUD logic, re-pointed
// from the NOVA singleton `require('./vault')` to an injected fs-store (see Spec
// Ambiguities Resolved mapping table). NOVA's module-level singleton shape doesn't fit
// MYTHOS's DI convention (every other P7 module is `create*({...deps})`), so this is a
// factory — `from-project.js`/`from-dashboard.js` receive the constructed instance via
// ctx rather than `require('./pipeline')` directly (documented deviation from the
// spec's from-project.js worked example, which shows a bare require()).
//
// Uses vault.removeFile (best-effort, already-shipped fs-store helper) instead of
// fs.unlinkSync directly — see Phase 7 Do-Not #6 (no raw fs.unlinkSync in this phase).

var path = require('path');

var STAGES = ['capture', 'human-gate', 'execute', 'shipped'];

function createPipelineEffector({ fs, classifier }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function' || typeof fs.listFiles !== 'function') {
    throw new Error('createPipelineEffector requires a vault fs-store with readJSON/writeJSON/listFiles');
  }

  function stageDir(stage) {
    return path.join('Pipeline', stage);
  }

  function listStage(stage) {
    return fs.listFiles(stageDir(stage), '.json').map(function(f) {
      return fs.readJSON(path.join(stageDir(stage), f.name), null);
    }).filter(Boolean);
  }

  function listAll() {
    var board = {};
    STAGES.forEach(function(s) { board[s] = listStage(s); });
    return board;
  }

  function capture(text, origin) {
    origin = origin || 'dashboard';
    var id = 'pipe-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    var card = {
      id: id,
      text: String(text).trim(),
      stage: 'capture',
      progress: 0,
      tags: [],
      created: new Date().toISOString(),
      origin: origin,
      risk: classifier ? classifier.classify(String(text).trim()) : 'feature'
    };
    fs.writeJSON(path.join(stageDir('capture'), id + '.json'), card);
    return card;
  }

  function findCard(id) {
    for (var i = 0; i < STAGES.length; i++) {
      var file = path.join(stageDir(STAGES[i]), id + '.json');
      var card = fs.readJSON(file, null);
      if (card) return { card: card, stage: STAGES[i], file: file };
    }
    return null;
  }

  function moveCard(id, toStage, patch) {
    patch = patch || {};
    if (STAGES.indexOf(toStage) === -1) throw new Error('invalid stage');
    var found = findCard(id);
    if (!found) throw new Error('card not found');
    var updated = Object.assign({}, found.card, patch, { stage: toStage });
    fs.writeJSON(path.join(stageDir(toStage), id + '.json'), updated);
    if (found.stage !== toStage) {
      fs.removeFile(found.file);
    }
    return updated;
  }

  function approve(id) {
    return moveCard(id, 'execute', { progress: 10 });
  }

  function reject(id) {
    var found = findCard(id);
    if (!found) throw new Error('card not found');
    fs.removeFile(found.file);
    return { id: id, deleted: true };
  }

  function ship(id) {
    return moveCard(id, 'shipped', { progress: 100 });
  }

  return {
    STAGES: STAGES, listAll: listAll, listStage: listStage, capture: capture,
    approve: approve, reject: reject, ship: ship, moveCard: moveCard, findCard: findCard
  };
}

module.exports = { createPipelineEffector, STAGES };
