'use strict';

// REMEDIATION P2-12 (2026-07-29 audit): the audit trail could not answer the
// questions it exists to answer. Two independent defects, pinned here:
//   1. dispatchAction()'s audit.write() call never passed `actor` at all, so
//      audit-writer's own default ("cortex") silently applied to EVERY
//      record regardless of true origin — even though ctx.channel (voice,
//      cortex, dashboard-media-widget, confirm-accept) was already threaded
//      through correctly for episodic. `traceId` is new: correlates a record
//      back to the specific turn (voice reqId / confirmId / cortex tick).
//   2. /api/media/control (the HUD media widget's play/pause/volume buttons)
//      called effectors.invoke() directly, bypassing dispatchAction entirely
//      — 42 of 43 media_key audit records from the incident had no outcome
//      recorded at all. It now routes through dispatchAction like every
//      other dispatch surface.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { mountMediaRoutes } = require('../server/routes/media');

function fakeMemory(auditCalls, episodicCalls) {
  return {
    audit: { write: (entry) => { auditCalls.push(entry); } },
    episodic: { write: async (entry) => { episodicCalls.push(entry); return { ref: 'ep-1' }; } },
  };
}

describe('P2-12: dispatchAction records the real actor and a traceId', () => {
  it('actor comes from ctx.channel, not audit-writer\'s cortex default', async () => {
    const auditCalls = [];
    const episodicCalls = [];
    const fakeHub = { invoke: async () => ({ ok: true, result: { sent: true } }), breakers: { allow: () => true } };

    await dispatchAction(
      { tool: 'media_key', args: { key: 'volume_down' } },
      {
        effectors: fakeHub,
        bus: { emit: () => {}, subscribe: () => () => {} },
        memory: fakeMemory(auditCalls, episodicCalls),
        goals: null, config: {}, goalId: null, tier: 2,
        channel: 'dashboard-media-widget',
        traceId: 'trace-abc-123',
      }
    );

    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].actor, 'dashboard-media-widget', 'actor must reflect the real caller, not a hardcoded default');
    assert.equal(auditCalls[0].traceId, 'trace-abc-123');
    assert.equal(episodicCalls[0].traceId, 'trace-abc-123', 'episodic should carry the same correlation id');
  });

  it('actor still defaults sanely (cortex) when no channel is given, and traceId is null (not undefined-shaped)', async () => {
    const auditCalls = [];
    const episodicCalls = [];
    const fakeHub = { invoke: async () => ({ ok: true, result: {} }), breakers: { allow: () => true } };

    await dispatchAction(
      { tool: 'read_status', args: {} },
      { effectors: fakeHub, bus: { emit: () => {}, subscribe: () => () => {} }, memory: fakeMemory(auditCalls, episodicCalls), goals: null, config: {}, goalId: null, tier: 0 }
    );

    assert.equal(auditCalls[0].actor, 'cortex');
    assert.equal(auditCalls[0].traceId, null);
  });

  it('a failed action still gets a real actor recorded (not just on the happy path)', async () => {
    const auditCalls = [];
    const episodicCalls = [];
    const fakeHub = { invoke: async () => ({ ok: false, result: 'boom' }), breakers: { allow: () => true } };

    await dispatchAction(
      { tool: 'media_key', args: { key: 'volume_up' } },
      {
        effectors: fakeHub, bus: { emit: () => {}, subscribe: () => () => {} },
        memory: fakeMemory(auditCalls, episodicCalls), goals: null, config: {}, goalId: null, tier: 2,
        channel: 'voice', traceId: 'reqid-42',
      }
    );

    assert.equal(auditCalls[0].outcome, 'fail');
    assert.equal(auditCalls[0].actor, 'voice');
    assert.equal(auditCalls[0].traceId, 'reqid-42');
  });
});

describe('P2-12: /api/media/control dispatches through dispatchAction (not a raw effectors.invoke)', () => {
  function startServer(dispatchSpy) {
    const app = express();
    const leash = { check: () => ({ allow: true, tier: 2 }) };
    const effectors = { invoke: async () => { throw new Error('media.js must not call effectors.invoke directly anymore'); } };
    mountMediaRoutes(app, { pcChild: null, leash, effectors, dispatchAction: dispatchSpy });
    return new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
  }

  function post(server, path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        { hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  it('routes media_key through the shared dispatchAction with channel:dashboard-media-widget', async () => {
    const calls = [];
    const dispatchSpy = async (decision, ctx) => {
      calls.push({ decision, ctx });
      return { ok: true, result: { sent: true } };
    };
    const server = await startServer(dispatchSpy);
    try {
      const res = await post(server, '/api/media/control', { key: 'next_track' });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].decision.tool, 'media_key');
      assert.equal(calls[0].decision.args.key, 'next_track');
      assert.equal(calls[0].ctx.channel, 'dashboard-media-widget');
    } finally {
      server.close();
    }
  });
});
