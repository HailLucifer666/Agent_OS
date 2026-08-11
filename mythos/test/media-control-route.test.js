'use strict';

// media-control-route.test.js — a dashboard transport click is a human action:
// it must reach the leash WITH a connectionId (so operator-present trust can
// apply) and must return the refusal reason in the body when the leash says no.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mountMediaRoutes } = require('../server/routes/media');

function appWith(leashResult, calls) {
  const app = express();
  mountMediaRoutes(app, {
    leash: { check: (action, ctx) => { calls.push({ action, ctx }); return leashResult; } },
    dispatchAction: async () => ({ ok: true }),
  });
  return app;
}

async function post(app, body) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/media/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();   // a leaked listener turns a failed assert into a suite hang
  }
}

test('the leash sees a connectionId for a dashboard click', async () => {
  const calls = [];
  const app = appWith({ allow: true, tier: 2 }, calls);
  const res = await post(app, { key: 'play_pause' });
  assert.equal(res.status, 200);
  assert.ok(calls[0].ctx.connectionId, 'expected a connectionId on the leash context');
});

test('a refusal returns its reason in the body', async () => {
  const calls = [];
  const app = appWith({ allow: false, requireConfirm: true, tier: 2, reason: 'tier-2-requires-confirm' }, calls);
  const res = await post(app, { key: 'next_track' });
  assert.equal(res.status, 403);
  assert.equal(res.json.reason, 'tier-2-requires-confirm');
  assert.equal(res.json.requireConfirm, true);
});
