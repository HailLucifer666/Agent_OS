'use strict';

// test/voice-latency.test.js — Task 12 (V2 Decision 1, merged-order step 4).
// Gate: after a synthetic turn, /api/status exposes real
// voiceLatency:{p50,p95,sampleCount}. AD-5: an unmeasured turn contributes NO
// sample rather than an estimate — covered by the "honest baseline" test.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createLatencyTracker } = require('../src/core/voice/latency-tracker');

describe('latency-tracker (pure unit coverage)', () => {
  test('record()/stats() compute real p50/p95 from real samples', () => {
    const tracker = createLatencyTracker({ capacity: 200 });
    for (const ms of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) tracker.record(ms);
    const stats = tracker.stats();
    assert.equal(stats.sampleCount, 10);
    assert.ok(stats.p50 >= 400 && stats.p50 <= 600, `p50 ${stats.p50} out of expected range`);
    assert.ok(stats.p95 >= 900, `p95 ${stats.p95} should be near the top of the distribution`);
  });

  test('AD-5: garbage input (negative, NaN, non-number, undefined) is silently dropped, never recorded as a fake sample', () => {
    const tracker = createLatencyTracker();
    tracker.record(-5);
    tracker.record(NaN);
    tracker.record('250');
    tracker.record(undefined);
    tracker.record(Infinity);
    assert.equal(tracker.stats().sampleCount, 0, 'no invalid input may ever produce a recorded sample');
  });

  test('AD-5: an empty tracker reports null percentiles and sampleCount 0 — never an invented number', () => {
    const tracker = createLatencyTracker();
    const stats = tracker.stats();
    assert.deepEqual(stats, { p50: null, p95: null, sampleCount: 0 });
  });

  test('the ring buffer is capped — oldest samples are dropped, never grows unbounded', () => {
    const tracker = createLatencyTracker({ capacity: 5 });
    for (let i = 1; i <= 20; i++) tracker.record(i * 10);
    assert.equal(tracker.stats().sampleCount, 5);
  });
});

describe('voice-latency (server integration): /api/status exposes real voiceLatency', () => {
  function fakeFs() { return { vaultPath: (...s) => path.join('/test-vault', ...s) }; }
  function baseDeps(bus) {
    return {
      bus,
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
      logger: { info() {}, warn() {}, error() {} },
      memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
      goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
      kanbanEffector: { listBoard: () => ({ cards: [] }) },
      pipelineEffector: { listAll: () => ({}) },
      effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
      leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
      goals: { debitBudget: () => {} },
      probes: { getStatus: async () => ({ ok: true }) },
      agentActions: {
        assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
        buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
        reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
      },
      buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    };
  }
  function httpGetJson(port, pathName) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  test('honest baseline: with no turns measured yet, /api/status reports sampleCount:0 and null percentiles', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const body = await httpGetJson(port, '/api/status');
      assert.ok(body.voiceLatency);
      assert.deepEqual(body.voiceLatency, { p50: null, p95: null, sampleCount: 0 });
    } finally {
      await server.stop();
    }
  });

  test('after a synthetic turn is recorded, /api/status exposes the real measured latency', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      // Simulate what handleUtterance/live-session wiring do on a real turn:
      // record the real mic-stop -> first-audio delta.
      server._internal.voiceLatencyTracker.record(482);
      server._internal.voiceLatencyTracker.record(511);
      const body = await httpGetJson(port, '/api/status');
      assert.equal(body.voiceLatency.sampleCount, 2);
      assert.ok(typeof body.voiceLatency.p50 === 'number');
      assert.ok(typeof body.voiceLatency.p95 === 'number');
    } finally {
      await server.stop();
    }
  });
});
