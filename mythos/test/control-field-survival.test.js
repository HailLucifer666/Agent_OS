'use strict';

// control-field-survival.test.js — THE PAYLOAD-FIELD SURVIVAL GUARD (plan §7.2).
//
// THE FAILURE CLASS THIS EXISTS FOR. A control is keyed on a field its own
// transport discards. The control is real, its tests pass, and it never fires.
//
// BUG-278, 2026-08-20, is the reference instance. BUG-273 C2 gave the gmail
// sensor `needsOperator: true` ("terminal, human-only, do not guess a remedy")
// and a `reason` carrying the whole operator instruction. explainer.js read
// them; healer.js's health.healed emit forwarded neither; diagnostician.js keeps
// the anomaly under `evidence` and the healer never forwarded `evidence`. So the
// control read undefined and MYTHOS answered a revoked OAuth token by re-probing
// the AI providers — one day after the fix shipped, in the operator's own session.
//
// WHY EVERY C2 TEST PASSED. They called `explainer._onHealed({payload: {...}})`
// with the fields injected — a fixture more generous than the wire. A hand-built
// payload cannot detect a field lost in transit, because the hand builds it at
// the destination.
//
// WHAT BUG-278 FIXED, AND WHAT THIS FILE ADDS. That fix asserts two named fields
// survive. This asserts the CLASS: every field the explainer reads off its
// incoming payload is derived from the explainer's own source, and each is
// required to arrive over the real bus. A control field added tomorrow, or a
// forward dropped in a refactor, fails here without anyone remembering to extend
// a list — which is the only version of this guard that survives contact with a
// repo that moves this fast.
//
// The field list is DERIVED, never written down. A written list is the same
// artefact that went stale as SERIOUS_KINDS and as the SEVERITY table; see
// test/anomaly-kind-conformance.test.js for that class.
//
// Run: cd mythos && node --test test/control-field-survival.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createBus } = require('../src/core/bus/index');
const { createDiagnostician } = require('../src/core/immune/diagnostician');
const { createHealer } = require('../src/core/immune/healer');
const { createExplainer } = require('../src/core/immune/explainer');
const { SEED_PLAYBOOKS } = require('../src/core/immune/healer');

const EXPLAINER_SRC = path.join(__dirname, '..', 'src', 'core', 'immune', 'explainer.js');

// Fields the explainer reads off the payload it is handed. Both shapes it uses:
// `payload.X` inside explain(), and `p.X` inside onHealed().
//
// Read out of the source rather than declared here, so the set cannot drift from
// the module that depends on it. Comments are stripped first — the BUG-278 note
// in explainer.js discusses `needsOperator` in prose, and a scan that counted
// prose would report a field the code does not actually read.
function fieldsExplainerReads() {
  const source = fs.readFileSync(EXPLAINER_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const found = new Set();
  for (const match of source.matchAll(/\b(?:payload|p)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g)) {
    found.add(match[1]);
  }
  return found;
}

// A kind with no playbook, so the healer's verdict is 'no-match' — the only
// outcome the explainer acts on. Chosen from the real emitted set rather than
// invented: 'handler-error' is emitted by bus/index.js for a throwing subscriber
// and no SEED_PLAYBOOK matches it. Asserted below rather than assumed, because a
// playbook added for it later would silently turn every test here vacuous.
const NO_PLAYBOOK_KIND = 'handler-error';

function wire() {
  const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
  const healed = [];

  const diag = createDiagnostician({ bus });
  const healer = createHealer({ bus, config: {}, memory: null });
  const explainer = createExplainer({
    bus,
    // Answers 'none' so nothing mechanical is applied. The subject here is what
    // ARRIVES, not what is decided once it has.
    brain: { async think() { return { parsed: { remedy: 'none' }, content: '{"remedy":"none"}', offline: false }; } },
    config: {},
    memory: null,
    logger: { info() {}, warn() {} },
  });

  bus.subscribe('health.healed', (e) => {
    if (e.payload && e.payload.outcome === 'no-match') healed.push(e.payload);
  });

  diag.start(); healer.start(); explainer.start();

  // The bus is asynchronous and the explainer is async on top of it, so a settle
  // window is unavoidable. Every assertion is on captured state, never a race.
  const emit = async (anomaly) => {
    bus.emit('health.anomaly', anomaly);
    await new Promise((r) => setTimeout(r, 300));
  };
  const stop = () => { diag.stop(); healer.stop(); explainer.stop(); };
  return { emit, healed, stop };
}

describe('control-field survival across bus -> diagnostician -> healer -> explainer', () => {
  it('the no-playbook kind this file relies on really has no playbook', () => {
    // Without this, a playbook added for 'handler-error' would flip every
    // outcome to 'applied', the explainer would never run, healed[] would stay
    // empty and the assertions below would pass on nothing at all.
    const matching = SEED_PLAYBOOKS.filter((p) => p && p.when && p.when.kind === NO_PLAYBOOK_KIND);
    assert.deepEqual(matching, [],
      NO_PLAYBOOK_KIND + ' now has a playbook, so the no-match path this file ' +
      'exercises is unreachable. Pick another unplaybooked emitted kind.');
  });

  it('extracts a non-trivial set of payload fields from the explainer source', () => {
    const fields = fieldsExplainerReads();
    assert.ok(fields.size >= 3,
      'extracted only ' + fields.size + ' payload fields from explainer.js — the ' +
      'scan is broken, and the survival assertion below would be vacuous.');
    // The two BUG-278 fields are the reason this file exists. If neither is read
    // any more the control was removed, and that should be a deliberate decision
    // with its own commit, not something this guard passes over in silence.
    assert.ok(fields.has('needsOperator'),
      'explainer.js no longer reads needsOperator. If the BUG-273 C2 control was ' +
      'deliberately removed, update this guard in the same commit.');
  });

  it('every field the explainer reads arrives over the real bus', async () => {
    const fields = [...fieldsExplainerReads()];
    const rig = wire();
    try {
      // Populate every field the explainer depends on with a distinguishable
      // sentinel, then require it on the other side. Built from the emitter's
      // side of the wire — a sensor puts arbitrary fields on the anomaly and the
      // chain is what must carry them.
      const anomaly = { kind: NO_PLAYBOOK_KIND, target: 'survival-probe' };
      for (const field of fields) {
        if (field === 'kind' || field === 'target') continue; // real values, set above
        if (field === 'outcome') continue;                     // the healer's own verdict
        anomaly[field] = field === 'needsOperator' ? true : 'sentinel-' + field;
      }

      await rig.emit(anomaly);

      assert.equal(rig.healed.length, 1,
        'the wired chain produced ' + rig.healed.length + ' no-match verdicts, expected 1 — ' +
        'nothing below is meaningful until one arrives.');

      const delivered = rig.healed[0];
      const dropped = fields.filter((f) => !(f in delivered));
      assert.deepEqual(dropped, [],
        'the explainer reads these fields but the chain never delivers them, so ' +
        'any control keyed on one is inert: ' + dropped.join(', ') +
        '. This is BUG-278 exactly. Forward them from healer.js and assert it ' +
        'here, not on a hand-built payload.');
      // 2026-09-25 (BUG-447): the KEY arriving is not the VALUE arriving. A probe that
      // changed healer.js's forward to `sayToOperator: null` passed the check above,
      // because the key was still there. Each sentinel must come out as it went in.
      // One documented exception: healer.js (Q8) deliberately does not forward the
      // anomaly's `detail` — in the verdict, `detail` means what the heal action did.
      const VALUE_WAIVERS = { detail: 'healer.js Q8: the verdict carries its own detail, not the anomaly\'s' };
      const lostValues = fields.filter((f) => f in anomaly && !(f in VALUE_WAIVERS) && delivered[f] !== anomaly[f]);
      assert.deepEqual(lostValues, [],
        'these fields arrive with a different value than the anomaly sent, so a control keyed on one '
        + 'reads the wrong thing: ' + lostValues.map((f) => f + '=' + JSON.stringify(delivered[f])).join(', '));
    } finally {
      rig.stop();
    }
  });

  it('a value the sensor set is not silently replaced in transit', async () => {
    // Presence is not survival. A field forwarded as a hardcoded default, or
    // coerced to null, satisfies `in` while destroying the information the
    // control reads — which is a strictly worse failure than dropping it,
    // because it looks delivered.
    const rig = wire();
    try {
      await rig.emit({
        kind: NO_PLAYBOOK_KIND,
        target: 'survival-probe',
        needsOperator: true,
        reason: 'the sensor said this needs a human',
      });
      assert.equal(rig.healed.length, 1);
      const delivered = rig.healed[0];
      assert.equal(delivered.needsOperator, true,
        'needsOperator was set on the anomaly and arrived as ' +
        JSON.stringify(delivered.needsOperator) + '. A control that reads === true ' +
        'is inert unless the value itself survives.');
      assert.equal(delivered.reason, 'the sensor said this needs a human',
        'reason arrived as ' + JSON.stringify(delivered.reason) + '. The operator ' +
        'instruction is the whole payload of this field; a null here is what made ' +
        'MYTHOS say "I do not yet know the cause" about an anomaly that shipped ' +
        'a sentence naming the fix.');
    } finally {
      rig.stop();
    }
  });
});
