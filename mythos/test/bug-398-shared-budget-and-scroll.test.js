'use strict';

// test/bug-398-shared-budget-and-scroll.test.js — BUG-398 row 13 and E4.
//
// ROW 13 — think_deeply's cooldown is ONE MODULE-LEVEL CLOCK shared by every
// caller: the cortex autonomous loop, the batch voice path, and every Live voice
// session. So a background tick can rate-limit the operator's conversation, and
// the refusal then said "Deep reasoning was used 2s ago" — true of the process,
// false of the reader, and the reader is the one being told to act on it.
//
// WHAT THIS DOES NOT DO, and why. The dossier's suggested fix was to "raise the
// budget for voice turns", on the strength of a 5-sample correlation between
// think_deeply being available and the narration being honest. The dossier
// itself says to validate that before acting, and it has NOT been validated —
// replaying those turns needs a live session. Splitting the budget per surface
// also doubles what an expensive lane can spend, which is a cost decision for
// the operator rather than one to make quietly inside a bug fix.
//
// So the confirmed half is fixed and the unconfirmed half is left alone: the
// budget is unchanged, and the refusal stops implying the caller spent it. That
// is a strictly smaller claim than the ticket asked for, stated here so nobody
// reads this file as having closed the correlation question.
//
// E4 — voice had NO working way to scroll a page. `scroll_at` is deliberately
// withheld from the voice allowlist (the 2026-08-09 Spotify wandering
// incident), `browser_scroll` needs the CDP browser that was not up, and
// `send_key` answered `Invalid key: "pagedown"`. Three routes, none available.
// The model found send_key unaided, which was good substitution defeated by a
// missing table entry.
//
// MUTATION PROOF — three probes, 2026-09-02, each verified applied:
//   (a) drop the `by` clause from cooldownRefusal → the attribution tests fail;
//       the refusal goes back to implying the caller spent the budget.
//   (b) stop threading `channel` through dispatch-action's invoke ctx → the
//       end-to-end attribution test fails, because the effector can no longer
//       tell the surfaces apart even though the audit line always could.
//   (c) remove 'pageup'/'pagedown' from NAMED_KEYS → the E4 tests fail with the
//       verbatim `Invalid key: "pagedown"` from the session.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const budget = require('../src/core/effectors/deep-think-budget');

describe('BUG-398 row 13 — the shared reasoning budget names who spent it', () => {
  it('(a) says nothing extra when the SAME surface spent it', () => {
    budget.resetDeepThinkBudget();
    budget.stampDeepThink('voice-live');
    const msg = budget.cooldownRefusal(2000, 60000, 'voice-live');
    assert.match(msg, /used 2s ago/, 'the timing is still reported');
    assert.ok(!/not by this conversation/.test(msg),
      'when the caller really did spend it, the old wording was already correct: ' + msg);
  });

  it('(a) names the other surface when somebody ELSE spent it', () => {
    budget.resetDeepThinkBudget();
    budget.stampDeepThink('cortex');
    const msg = budget.cooldownRefusal(2000, 60000, 'voice-live');
    assert.match(msg, /used by cortex/, 'the consumer must be named: ' + msg);
    assert.match(msg, /not by this conversation/,
      'the model has no other way to know it was not its own call: ' + msg);
    assert.match(msg, /one budget is shared/,
      'and it must say the budget is shared, or "used by cortex" is a puzzle');
  });

  it('an unattributed caller falls back to naming the background loop', () => {
    budget.resetDeepThinkBudget();
    budget.stampDeepThink(null);
    assert.match(budget.deepThinkState().lastDeepThinkBy, /background loop/);
  });

  it('the refusal is still not phrased as a fault, and still says what to do', () => {
    // BUG-287's rule, which this must not regress: a message the model reads as
    // broken sends it diagnosing a healthy system.
    budget.resetDeepThinkBudget();
    budget.stampDeepThink('cortex');
    const msg = budget.cooldownRefusal(2000, 60000, 'voice-live');
    assert.match(msg, /Nothing is wrong/);
    assert.match(msg, /Answer this yourself now/);
  });

  it('BOUNDS: the BUDGET itself is unchanged — 60s, and 0 still opts out', () => {
    // The deliberate non-change. If a later session decides to split the budget
    // per surface, this is the assertion it has to come and edit on purpose.
    assert.equal(budget.DEEP_THINK_MIN_INTERVAL_DEFAULT_MS, 60000);
    assert.equal(budget.deepThinkMinIntervalMs({ DEEP_THINK_MIN_INTERVAL_MS: 0 }, null), 0,
      '0 is the documented opt-out and must survive');
    assert.equal(budget.deepThinkMinIntervalMs({ DEEP_THINK_MIN_INTERVAL_MS: 'banana' }, null), 60000,
      'an unparseable value must leave the guard STANDING, never switch it off');
  });

  // A SOURCE-SHAPE TEST WAS DELETED HERE, and the deletion is the finding.
  // It grepped dispatch-action.js for /channel:\s*ctx\.channel/ to assert that
  // the calling surface is threaded into the invoke context. Probe (b) removed
  // that argument from the code — and this test still PASSED, because the
  // sentence explaining the change in the comment above it matched the same
  // pattern. A guard that a comment can satisfy is measuring the wrong artifact.
  // The end-to-end test below proves the same thing by exercising it, and it
  // failed under that probe exactly as it should, so the grep was surface
  // without value. Removed rather than tightened.

  it('(b) end to end: a voice call refused after a cortex call names cortex', async () => {
    const { dispatchAction } = require('../src/core/effectors/dispatch-action');
    const { createEffectorHub } = require('../src/core/effectors/hub');

    // Stubbed at the deep-think MODULE boundary, not at brain.think, for the
    // reason bug-287's own harness records: deepThink() preflights the real
    // provider registry before it ever calls brain.think, so in a test
    // environment a brain stub is never reached and the call returns "the
    // reasoning lane has no live provider". Found here the same way — the
    // premise assertion below failed with exactly that string.
    const DEEP_THINK = path.resolve(__dirname, '../src/core/effectors/deep-think.js');
    require.cache[DEEP_THINK] = {
      id: DEEP_THINK, filename: DEEP_THINK, loaded: true,
      exports: {
        deepThink: async () => ({ content: 'the considered answer', provider: 'p', model: 'm',
          offline: false, timedOut: false, ms: 5 }),
      },
    };
    delete require.cache[path.resolve(__dirname, '../src/core/effectors/from-computer.js')];
    budget.resetDeepThinkBudget();
    const hub = createEffectorHub({ bus: { emit() {} }, config: {} });
    require('../src/core/effectors/from-computer').registerFromComputer(hub, {
      config: {}, brain: { think: async () => ({ content: 'unused' }) }, logger: { warn() {}, info() {} },
    });

    const ctx = (channel) => ({
      effectors: hub, bus: { emit() {} }, goals: null, memory: null,
      config: { ACTION_TIMEOUT_MS: 5000 }, channel,
    });
    const first = await dispatchAction(
      { tool: 'think_deeply', args: { question: 'why' } }, ctx('cortex'));
    assert.equal(first.ok, true, 'premise: the first call must succeed, got '
      + JSON.stringify(first.result));

    const second = await dispatchAction(
      { tool: 'think_deeply', args: { question: 'why again' } }, ctx('voice-live'));
    assert.equal(second.ok, false, 'the cooldown must still bite across surfaces');
    const why = String((second.result && second.result.error) || second.result);
    assert.match(why, /used by cortex/,
      'the voice turn must be told WHO spent the budget: ' + why);
    delete require.cache[DEEP_THINK];
    delete require.cache[path.resolve(__dirname, '../src/core/effectors/from-computer.js')];
  });
});

describe('BUG-398 E4 — voice can scroll a page', () => {
  const fs = require('node:fs');
  const FROM_PC = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
  const PS = path.resolve(__dirname, '../adapters/pc-child/ps-automation.ps1');

  it('(c) pageup and pagedown are accepted key names', () => {
    const src = fs.readFileSync(FROM_PC, 'utf8');
    const list = src.match(/const NAMED_KEYS = \[([\s\S]*?)\];/);
    assert.ok(list, 'NAMED_KEYS must be findable');
    assert.match(list[1], /'pageup'/, 'the session got `Invalid key: "pagedown"` with no route left');
    assert.match(list[1], /'pagedown'/);
  });

  it('(c) the PowerShell side has real VK codes for them', () => {
    // BOTH SIDES, or the node allowlist accepts a key the child cannot send —
    // which would turn an honest refusal into a silent no-op. VK_PRIOR is 0x21
    // and VK_NEXT is 0x22.
    const ps = fs.readFileSync(PS, 'utf8');
    assert.match(ps, /pageup\s*=\s*0x21/i, 'PageUp must map to VK_PRIOR');
    assert.match(ps, /pagedown\s*=\s*0x22/i, 'PageDown must map to VK_NEXT');
  });

  it('the tool description tells the model this is how to scroll', () => {
    // The routes it would otherwise reach for are both unavailable by design,
    // so the description has to point here or the capability stays invisible.
    const src = fs.readFileSync(FROM_PC, 'utf8');
    const desc = src.match(/name: 'send_key', description: '([^']*)'/);
    assert.ok(desc, 'send_key description must be findable');
    assert.match(desc[1], /pagedown/, 'the key must be listed');
    assert.match(desc[1], /SCROLL/i, 'and named as the scroll route');
    assert.match(desc[1], /caret/i,
      'and warn that it follows the caret — the repo has a documented '
      + 'keystrokes-follow-the-caret trap');
  });

  it('BOUNDS: a genuinely invalid key is still refused, and lists the valid ones', () => {
    const src = fs.readFileSync(FROM_PC, 'utf8');
    assert.match(src, /Invalid key: "\$\{key\}"\. Valid: \$\{NAMED_KEYS\.join/,
      'the refusal must still enumerate what IS valid, so a wrong key is '
      + 'self-correcting rather than a dead end');
  });
});
