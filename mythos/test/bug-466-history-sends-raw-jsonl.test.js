'use strict';

// bug-466-history-sends-raw-jsonl.test.js — the conversation panel's Episodic
// half never showed a row, because GET /api/conversation/history joined
// readLines()'s PARSED objects with Array.join: every row reached the HUD as the
// text "[object Object]", and the client's parser (built to skip torn lines)
// skipped all of them. The route now sends the file's raw JSONL text, which is
// the contract its own comment always described.
//
// The chain under test is the real one end to end: the real Episodic writer
// (createEpisodicStore over createFsStore) -> the real route over HTTP -> the
// HUD's real parser and merge (ui/public/js/views/transcript-model.js, loaded
// as the browser ES module it is). A fixture written by hand, or a route
// response checked only for "is a string", would pass on the broken code too.
//
// Mutation probe (g), 2026-10-05, recorded with the BUGS.md entry: restoring
// the readLines(...).join('\n') expression reddens (a) and (b).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEpisodicStore } = require('../src/core/memory/episodic');
const { dayKey } = require('../src/core/util/day-key');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const MODEL_URL = pathToFileURL(path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'transcript-model.js')).href;

let vaultRoot;
let fsStore;
let episodic;
let server;
let port;
let model;

before(async () => {
  model = await import(MODEL_URL);
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-466-vault-'));
  const bus = createBus({ historySize: 50 });
  fsStore = createFsStore(() => vaultRoot, bus);
  episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: null, logger: SILENT });
  server = createServer({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: SILENT,
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fsStore },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  });
  await server.ready;
  port = server.httpServer.address().port;
});

after(async () => {
  if (server) await server.stop();
  if (vaultRoot) fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function getHistory() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/conversation/history' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const todayFile = () => path.join(vaultRoot, 'Episodic', dayKey() + '.jsonl');

describe('BUG-466 — the history route sends the Episodic file as raw JSONL', () => {
  it('(a) a turn written by the real Episodic writer reaches the HUD transcript', async () => {
    fs.rmSync(path.join(vaultRoot, 'Episodic'), { recursive: true, force: true });
    episodic.write({ kind: 'conversation', channel: 'voice', summary: 's', detail: { text: 'what time is it', reply: 'It is nine.' }, salience: 0.5 });
    const { status, json } = await getHistory();
    assert.equal(status, 200);
    assert.ok(!String(json.episodic).includes('[object Object]'), 'rows must not be stringified objects');
    const messages = model.buildTranscript(null, json.episodic);
    const texts = messages.map((m) => m.role + ':' + m.text);
    assert.deepEqual(texts, ['user:what time is it', 'assistant:It is nine.']);
  });

  it('(b) Unicode and a torn final line: good rows survive, the torn one is skipped', async () => {
    fs.rmSync(path.join(vaultRoot, 'Episodic'), { recursive: true, force: true });
    episodic.write({ kind: 'conversation', channel: 'voice', summary: 's', detail: { text: 'আজ কেমন আছো — नमस्ते', reply: 'ভালো' }, salience: 0.5 });
    fs.appendFileSync(todayFile(), '{"kind":"conversation","detail":{"text":"torn wri');
    const { json } = await getHistory();
    const messages = model.buildTranscript(null, json.episodic);
    assert.deepEqual(messages.map((m) => m.text), ['আজ কেমন আছো — नमस्ते', 'ভালো']);
  });

  it('(c) no file yet today is an empty string, not an error (must keep working)', async () => {
    fs.rmSync(path.join(vaultRoot, 'Episodic'), { recursive: true, force: true });
    const { status, json } = await getHistory();
    assert.equal(status, 200);
    assert.equal(json.episodic, '');
    assert.deepEqual(model.buildTranscript(null, json.episodic), []);
  });
});
