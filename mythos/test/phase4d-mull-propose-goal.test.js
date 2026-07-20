'use strict';

// Phase 4 / Area D — V8 mull() → propose_goal suggestions.
//
// Pre-Phase-4: mull() emitted cortex.thought events that had zero subscribers.
// The cortex could think during quiet moments but couldn't ACT on those
// thoughts — specifically, it couldn't surface goal suggestions. Spec V8.
//
// Phase 4 fix: mull()'s brain prompt now also asks for 0-2 goal proposals.
// Each becomes a status:'proposed' goal via the propose_goal effector (T1,
// audit-logged). Caps at 2 per pass (safety bound).
//
// mull() is closure-private inside cortex/index.js, so we test the CONTRACT
// via source-shape guards: the prompt content, the events emitted, and the
// end-to-end loop wiring (the actual proposal creation is exercised by
// phase4d-propose-goal.test.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORTEX_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'cortex', 'index.js'), 'utf8');

describe('Phase 4 / Area D — mull() prompt asks for proposals (V8)', function () {

  it('the mull brain prompt includes the proposals request', function () {
    assert.ok(CORTEX_SRC.indexOf('GOALS the operator might want to add') !== -1,
      'mull prompt must ask for goal proposals');
  });

  it('the mull prompt references the propose_goal channel (one-tap acceptance)', function () {
    assert.ok(CORTEX_SRC.indexOf('propose') !== -1,
      'mull prompt must mention the proposal channel');
    assert.ok(CORTEX_SRC.indexOf('accepts/rejects') !== -1,
      'mull prompt must explain the operator-acceptance flow');
  });

  it('the mull schemaHint includes the proposals field', function () {
    assert.ok(CORTEX_SRC.indexOf('proposals: Array<') !== -1,
      'schemaHint must declare the proposals field so the brain returns structured output');
  });

});

describe('Phase 4 / Area D — mull() routes proposals through propose_goal (V8)', function () {

  it('cortex/index.js invokes effectors.invoke("propose_goal", ...) when the brain returns proposals', function () {
    assert.ok(CORTEX_SRC.indexOf("effectors.invoke('propose_goal'") !== -1,
      'mull must route proposals through the propose_goal effector (leash + audit)');
  });

  it('mull caps proposals at 2 per pass (safety bound)', function () {
    assert.ok(CORTEX_SRC.indexOf('.slice(0, 2)') !== -1,
      'mull must cap proposals per pass — prevents flooding the proposal queue');
  });

  it('mull skips proposal routing silently when effectors are absent (test isolation)', function () {
    // The "if (effectors && typeof effectors.invoke === 'function')" guard
    // means tests that construct cortex without effectors don't NPE.
    assert.ok(CORTEX_SRC.indexOf("if (effectors && typeof effectors.invoke === 'function')") !== -1,
      'mull must guard the effectors.invoke call so cortex can be tested without effectors');
  });

  it('cortex/index.js emits cortex.proposed when a goal is proposed', function () {
    assert.ok(CORTEX_SRC.indexOf("bus.emit('cortex.proposed'") !== -1,
      'cortex.proposed event must fire so the dashboard can react');
  });

});
