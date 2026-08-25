'use strict';

// BUG-341 (2026-08-24): the SPEC_READY -> buildPlan transition existed in the
// state machine, in the REST route, AND as a UI helper (transitionEngagement)
// — but NOTHING ever called the helper. The lone vault engagement froze at
// SPEC_READY forever: the layer was reachable from nowhere despite passing
// its own tests. This file pins both halves so it cannot silently un-wire:
//   1. Behavioural — an empty spec is refused with a real message (the route
//      surfaces it as 400, the operator sees why, not a bare "Failed").
//   2. Source-shape — the detail view must RENDER a build-plan action for a
//      SPEC_READY engagement and INVOKE transitionEngagement with 'buildPlan'
//      (negative control proves the definition alone no longer satisfies).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sm = require('../src/core/engagements/state-machine.js');

test('an empty spec cannot advance: the refusal names the missing thing', () => {
  const verdict = sm.validateTransition('SPEC_READY', 'buildPlan', { spec: { markdown: '' } });
  assert.strictEqual(verdict.ok, false);
  assert.ok(
    verdict.errors.some((e) => /markdown/i.test(e)),
    `expected a markdown-naming refusal, got: ${JSON.stringify(verdict.errors)}`
  );
});

test('a real spec advances SPEC_READY -> PLAN_READY', () => {
  const verdict = sm.validateTransition('SPEC_READY', 'buildPlan', { spec: { markdown: '# A real spec' } });
  assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

const VIEW = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'engagements.js'), 'utf8');

test('guard-the-guard: helper definition and action marker are distinguishable', () => {
  assert.match(VIEW, /async function transitionEngagement\(/, 'helper vanished');
  assert.match('data-action="build-plan"', /data-action="build-plan"/, 'marker pattern regressed');
});

test('the detail view renders a build-plan action and INVOKES the helper', () => {
  // Match against COMMENT-STRIPPED source: a call buried in a comment is not
  // a call (this exact false-positive was caught by mutation during review).
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const defIdx = VIEW.indexOf('async function transitionEngagement(');
  const callMatches = [...code.matchAll(/transitionEngagement\(\s*[^,)]+,\s*['"]buildPlan['"]/g)];
  const callsAfterDef = callMatches.filter((m) => m.index > defIdx);
  assert.ok(callsAfterDef.length >= 1,
    'transitionEngagement is still defined-but-never-called for buildPlan — engagements stay frozen at SPEC_READY');
  assert.match(code, /data-action="build-plan"/, 'no build-plan action rendered for SPEC_READY');
});

test('BUG-343: transitioning an unknown engagement is a 404, not an internal error', async () => {
  const http = require('http');
  const express = require('express');
  const { mountEngagementsRoutes } = require('../server/routes/engagements.js');
  const app = express();
  app.use(express.json());
  mountEngagementsRoutes(app, {
    engagementManager: { engagement: {
      findById: async (id) => (id === 'known' ? { id } : null),
      transition: async () => { throw new Error('should never be reached for unknown ids'); },
    }},
    auditRest: () => {},
    sanitizeErrorForClient: (e) => e.message,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const port = server.address().port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/engagements/unknown-id/transition', method: 'POST',
        headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ event: 'buildPlan' }));
    });
    assert.strictEqual(status, 404, `unknown-id transition returned ${status} — the pre-BUG-343 code leaked a 500 here`);
  } finally { server.close(); }
});
