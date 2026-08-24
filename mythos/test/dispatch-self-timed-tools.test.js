'use strict';

// test/dispatch-self-timed-tools.test.js — REVIEW of a0c82fe found a regression
// in the H1 fix: hub enforcement made dispatch-action's default 30s signal
// BINDING for every tool. Tools whose effectors carry their own, larger,
// documented budgets (DSH builds: DSH_TEXT_BUILD_TIMEOUT_MS defaults to
// 600000 in build-engine.js:156) were therefore killed at 30s mid-build.
//
// THE CONTRACT UNDER TEST: tools in dispatch-action's SELF_TIMED_TOOLS set are
// invoked WITHOUT the dispatcher's default signal (their effector budget
// governs); an explicit caller signal still applies.
//
// Fixture discipline: uses the REAL createEffectorHub as ctx.effectors — the
// first draft of this file mocked effectors and thereby bypassed the exact
// code under test (hub.raceSignal), passing green while testing nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { createEffectorHub } = require('../src/core/effectors/hub');

// A self-timed effector: sleeps past ACTION_TIMEOUT_MS, ignores any signal —
// exactly how the real long runners behaved before forwarding signals.
function hungishEffector(hub, id, ms) {
  hub.register({
    id,
    invoke: async function () {
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, result: 'built' };
    },
  });
}

function makeCtx(tools) {
  const bus = { emit() {} };
  const hub = createEffectorHub({ bus, config: {} });
  for (const [id, ms] of tools) hungishEffector(hub, id, ms);
  const ctx = {
    bus, memory: null, goals: null, effectors: hub,
    config: { ACTION_TIMEOUT_MS: 100 }, // deliberately shorter than each tool's sleep
  };
  return ctx;
}

describe('dispatchAction must not impose its default budget on self-timed tools', () => {
  it('build_project longer than ACTION_TIMEOUT_MS still succeeds', async () => {
    // Drives the REAL hub: if the dispatcher attaches its 100ms default signal,
    // hub enforcement kills this call and res.ok is false.
    const ctx = makeCtx([['build_project', 250]]);
    const res = await dispatchAction({ tool: 'build_project', args: {} }, ctx);
    assert.equal(res.ok, true,
      'a self-timed build must not be killed by the dispatcher default signal (got '
      + JSON.stringify(res.result) + ')');
  });

  it('every SELF_TIMED_TOOLS entry survives a budget shorter than its work', async () => {
    for (const tool of ['revise_project', 'start_project', 'dsh_task',
      'kanban_build_card', 'kanban_assemble', 'index_project', 'document_ingest',
      'security_scan', 'run_mission', 'pipeline_execute']) {
      const ctx = makeCtx([[tool, 180]]);
      const res = await dispatchAction({ tool, args: {} }, ctx);
      assert.equal(res.ok, true, `${tool} was killed by the dispatcher default signal`);
    }
  });

  it('NEGATIVE CONTROL: ordinary tools keep the default budget', async () => {
    // An ordinary tool sleeping PAST the budget must be killed by enforcement.
    const ctx = makeCtx([['get_time', 300]]);
    const res = await dispatchAction({ tool: 'get_time', args: {} }, ctx);
    assert.equal(res.ok, false, 'an ordinary tool over budget must be enforced');
    assert.match(String(res.result), /tool-timeout/);
  });
});
