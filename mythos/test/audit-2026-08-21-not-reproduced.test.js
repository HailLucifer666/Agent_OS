'use strict';

// test/audit-2026-08-21-not-reproduced.test.js
//
// Four items from the 2026-08-21 remediation plan that were NOT built, because
// measuring their premises against the live vault contradicted them. This file
// exists so none of the four is re-opened on the same reasoning — the same job
// bug-284-browser-capability-not-reproduced.test.js does for its ticket.
//
// Each section states what the plan claimed, what the evidence actually showed,
// and pins the property that would have been damaged by building it. These are
// real assertions, not comments: mutate the code and they fail.
//
// ===========================================================================
// 1. "The Aether healer loops on EADDRINUSE forever" — PREMISE FALSE.
// The plan said aud-* records show retry-aether-proxy -> bind-failed-again
// every 15s for hours, and proposed a give-up counter after 6 attempts.
// The live vault contains ZERO retry-aether-proxy records, ever. The 63 real
// records are {"kind":"aether-proxy-bind-failed","playbookId":null,
// "outcome":"no-match"} — the healer never ran the action at all — and every
// one of them is dated 2026-08-08/09, BEFORE the Wave 7 playbook was added on
// 08-13. EADDRINUSE 4480 last appears 2026-08-13; the healer has run every day
// since (156 records on 08-20) with no recurrence.
// So the give-up counter would have guarded an action with zero executions in
// recorded history — a mechanism nobody could prove works, on a path that has
// not fired in a week. What IS worth pinning is that the playbook now exists,
// since its absence is what produced those 63 no-match records.
//
// 2. "browser_navigate is unreachable from voice" — BAR NOT MET.
// The plan cited 41 "UNAVAILABLE — browser_navigate" log lines. Those are
// emitted once per BOOT from a capability snapshot, not once per failure. The
// audit shows 140 SUCCESSFUL browser_navigate calls and browser_launch_debug
// at 15 ok / 1 fail. BUG-284 already considered and rejected this exact
// reasoning, setting the bar explicitly: "it needs a session where the
// withholding demonstrably cost something." 140 successes is the opposite of
// that. Adding browser_navigate to the capability rule's `except` list would
// also have broken a deliberate assertion in
// bug-276-f1-browser-recovery-tool-survives-offline.test.js.
//
// 3. "see_and_click's miss class is the CLICK" — EXACTLY BACKWARDS.
// The plan proposed a cua_click fallback for when click_at fails. All 8
// recorded see_and_click failures are "I cannot see X on screen" (7) or "PC
// automation is OFFLINE" (1) — the OCR grounding step. click_at is 1 ok / 0
// fail: it has never failed. from-pc.js returns at the no-hits branch long
// before any click, so the proposed rung is unreachable from every recorded
// failure — dead code that would read as a fix.
//
// 4. "forget_fact needs a looser recall floor" — REMEDY IS DESTRUCTIVE.
// forget_fact is 0 ok / 2 fail. The plan proposed lowering
// semantic.forget()'s MIN_RECALL_SCORE, arguing it is safe because forget()
// refuses ambiguity. It does not: `candidates.length === 1` DELETES with no
// confirmation, and only >1 asks. Simulated against the real 78-fact
// user-facts.md, the audited query "prioritize children over technical
// projects" yields 0 candidates at 0.5 (honest refusal) and exactly ONE at
// 0.4 — silently deleting the unrelated, correct fact "Operator expects MYTHOS
// to improve contextual understanding...". Both real failures passed a
// paraphrase of a fact that was never stored; refusing was correct behaviour.
// ===========================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('audit 2026-08-21 #1 — the Aether healer HAS a playbook (no give-up counter needed)', () => {
  const { SEED_PLAYBOOKS } = require('../src/core/immune/healer');

  it('a playbook matches aether-proxy-bind-failed, so the 63 no-match records cannot recur', () => {
    const pb = SEED_PLAYBOOKS.find((p) => p && p.when && p.when.kind === 'aether-proxy-bind-failed');
    assert.ok(pb, 'the Wave 7 (2026-08-13) playbook is what closed the no-match records');
    assert.ok(
      pb.then.some((step) => step && step.do === 'retry-aether-proxy'),
      'it must still route to the same-port retry'
    );
  });

  it('the retry stays a same-port retry — the port order is a documented contract', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'immune', 'healer.js'), 'utf8');
    // The plan's rejected alternative was port-walking. healer.js says the port
    // order is the contract because an external aggregator's --peers points at
    // these exact ports; a quiet renumbering breaks it silently.
    assert.match(src, /PORT ORDER IS THE CONTRACT/,
      'the reasoning that forbids port-walking must stay next to the code');
  });
});

describe('audit 2026-08-21 #2 — browser_navigate stays gated while the browser is offline', () => {
  const { RULES } = require('../src/core/voice/tool-capability');

  it('the browser rule excepts only the launcher and the switcher', () => {
    const rule = RULES.find((r) => r.id === 'browser');
    assert.ok(rule, 'the browser capability rule must exist');
    assert.equal(rule.except('browser_launch_debug'), true, 'the launcher must stay reachable');
    assert.equal(rule.except('browser_switch'), true, 'its remedy must stay reachable');
    assert.equal(
      rule.except('browser_navigate'), false,
      'browser_navigate is deliberately NOT excepted. BUG-284 set the bar for overturning ' +
      'this — a session where the withholding demonstrably cost something — and the audit ' +
      'shows 140 successful browser_navigate calls, which is the opposite. ' +
      'bug-276-f1 also asserts it is undeclared while offline.'
    );
  });
});

describe('audit 2026-08-21 #3 — see_and_click fails at OCR grounding, never reaching the click', () => {
  const Module = require('node:module');
  const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
  const originalRequire = Module.prototype.require;

  // The repo's existing pc-child mocking harness (caret-owner-and-send-key-
  // ladder.test.js). An earlier draft of this file used a
  // `__setAdapterForTests` seam that DOES NOT EXIST on from-pc.js, so the test
  // silently ran against the real adapter and passed because nothing clicked —
  // vacuous, and it reached for live pc-child. Mock the module instead.
  function withMockedPcChild(mock, fn) {
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/pc-child') return mock;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[FROM_PC_PATH];
    try { return fn(require(FROM_PC_PATH)); }
    finally { Module.prototype.require = originalRequire; delete require.cache[FROM_PC_PATH]; }
  }

  it('an OCR miss returns without ever attempting a click of any kind', async () => {
    const sent = [];
    // OCR succeeds and returns real text — just not the requested label. This is
    // the exact shape of all 7 "I cannot see X on screen" failures: the screen
    // was readable, the target was not on it.
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        sent.push(cmd && cmd.cmd);
        if (cmd && cmd.cmd === 'screen_read_text') {
          return { ok: true, result: { text: ['MYTHOS', 'File Edit View', 'Window', 'Help'].join('\n') } };
        }
        return { ok: true, result: {} };
      },
    };
    const out = await withMockedPcChild(mock, (mod) => mod.see_and_click({ text: 'Video call' }));

    assert.equal(out.ok, false, 'an unmatched target must fail rather than click something else');
    assert.match(String(out.result), /cannot see/i);
    // The mechanism, not the return value: NO click command reached the adapter.
    // A cua_click fallback placed after the click step therefore cannot fire for
    // any of the 8 recorded failures — it would be dead code reading as a fix.
    const clickCmds = sent.filter((c) => /click/i.test(String(c || '')));
    assert.deepEqual(clickCmds, [], 'no click may be attempted when the text was never located');
    // Negative control: prove the OCR step DID run, so the empty click list is
    // a real observation and not an early bail before anything happened.
    assert.ok(sent.includes('screen_read_text'), 'the OCR read must actually have been attempted');
  });

  it('the no-hits branch returns BEFORE the click step in the source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-pc.js'), 'utf8');
    const miss = src.indexOf('I cannot see "');
    assert.ok(miss > 0, 'the OCR-miss refusal must exist');
    const missReturn = src.lastIndexOf('return fail(', miss);
    const clickAfter = src.indexOf('click_at', miss);
    assert.ok(clickAfter > 0, 'there must be a click step after the miss branch');
    assert.ok(
      missReturn > 0 && missReturn < clickAfter,
      'the OCR miss must return before any click is reached'
    );
  });
});

describe('audit 2026-08-21 #4 — forget() refuses rather than deleting on a weak match', () => {
  const { createSemanticStore } = require('../src/core/memory/semantic');

  // The two facts that matter from the real 78-fact user-facts.md: the one the
  // audited query would have destroyed at a looser floor, and a decoy.
  const REAL_FACTS = [
    '## user-facts',
    '',
    // VERBATIM from the live vault — do NOT shorten. The trailing clause is
    // load-bearing: "Prioritize ... over time" is what gives the audited query
    // ("prioritize children over technical projects") a 2/5 = 0.40 token
    // overlap. Truncating this sentence was enough to make the 0.4-floor
    // mutation stop failing, i.e. to make this whole pin decorative.
    "- Operator expects MYTHOS to improve contextual understanding, track conversational references more accurately, and be both proactive and reactive in responses. Prioritize clarity in ambiguous scenarios and adapt to operator's speaking style over time.",
    '- Family, specifically mom and dad, matters above all priorities. Person is single and not married.',
    '- The operator really enjoys playing jazz piano',
    '',
  ].join('\n');

  function storeOverFacts() {
    const files = { 'Semantic/user-facts.md': REAL_FACTS };
    const fakeFs = {
      readText: (p, fb) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : fb),
      writeText: (p, text) => { files[p] = text; return true; },
      listDir: () => ['user-facts.md'],
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      readJSONStrict: (p, fb) => fb,
      readJSON: (p, fb) => fb,
      writeJSON: () => true,
    };
    return {
      store: createSemanticStore({ fs: fakeFs, config: {}, bus: { emit() {} }, logger: null }),
      files,
    };
  }

  it('the audited query deletes NOTHING — it matched no stored fact', () => {
    const { store, files } = storeOverFacts();
    const before = files['Semantic/user-facts.md'];
    const out = store.forget('prioritize children over technical projects', { topic: 'user-facts' });
    assert.deepEqual(out.removed, [],
      'this query names a fact that was never stored; the two real failures were the model ' +
      'passing a paraphrase, not a matching-floor problem');
    assert.equal(files['Semantic/user-facts.md'], before,
      'the file must be untouched — at a 0.4 floor this query silently removes the unrelated, ' +
      'correct "improve contextual understanding" fact, because forget() deletes on a single ' +
      'fuzzy candidate with no confirmation');
  });

  it('an exact substring still forgets, so the refusal above is not just a dead store', () => {
    // Negative control: without this, the assertion above could pass because
    // forget() never works at all in this fixture.
    const { store } = storeOverFacts();
    const out = store.forget('really enjoys playing jazz piano', { topic: 'user-facts' });
    assert.equal(out.removed.length, 1, 'a genuine match must still be removed: ' + JSON.stringify(out));
    assert.match(out.removed[0], /jazz piano/);
  });
});
