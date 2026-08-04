'use strict';

// test/b5-reminder-fire-action.test.js — Track B5: reminders get a
// fire-action field ({tool, args}) so a reminder can drive a real tool
// (e.g. phone_whatsapp_send / whatsapp_send) when it fires, not just speak
// text. This is the prerequisite the roadmap deferred WhatsApp desktop
// scheduling on: from-calendar.js's reminder_add previously accepted only
// {text, when}.
//
// Invariants this file proves, red-first:
//   1. reminder_add accepts an optional `action` and, for a T3+ tool, anchors
//      it on a companion goal — unapproved by default.
//   2. Fire-time dispatch goes through the SAME leash.check() ->
//      dispatchAction() path every other action uses (AD-1: the effector-hub
//      invoke call lives only in dispatch-action.js). An unapproved T3 action
//      does NOT execute just because its timer fired.
//   3. reminder_approve_action grants EXACTLY the one tool named on the
//      reminder — never the tier, never a different T3 tool on the same
//      goal (mirrors test/leash-grant-scope.test.js's security gate).
//   4. leash.check() writes exactly one audit line per gate decision (AD-2).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCalendarEffector } = require('../src/core/effectors/from-calendar');
const { createGoalSystem } = require('../src/core/goals');
const { createLeash } = require('../src/core/leash');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { TIER_TABLE } = require('../src/core/leash/tiers');

function realBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
    CHECKPOINT_TTL_MS: 1800000,
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function recordingAuditWriter() {
  const writes = [];
  return { write: function(e) { writes.push(e); return { ok: true }; }, _writes: function() { return writes; } };
}

// A vault fs fake that holds parsed objects — same shape used by
// test/p21-reminders.test.js and test/from-calendar-timer.test.js.
function fakeFs() {
  const store = {};
  return {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    readJSONStrict: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = JSON.parse(JSON.stringify(d)); },
    ensureDir: () => {},
    listFiles: () => [],
  };
}

// Records every tool the fake effector hub was asked to invoke — this is the
// oracle for "did the outward action actually run".
function fakeEffectorHub() {
  const invoked = [];
  return {
    invoke: async function(tool, args) {
      invoked.push({ tool, args });
      return { ok: true, result: { sent: true }, evidence: { simulated: true } };
    },
    get: function() { return undefined; },
    breakers: { allow: function() { return true; } },
    _invoked: () => invoked.slice(),
  };
}

function harness() {
  const bus = realBus();
  const config = fakeConfig();
  const goals = createGoalSystem({ fs: fakeFs(), config, bus, memory: null, brain: null });
  const auditWriter = recordingAuditWriter();
  const effectors = fakeEffectorHub();
  const leash = createLeash({
    bus, config, identity: noopIdentity(),
    auditWriter, goals, effectors
  });
  const cal = createCalendarEffector({ fs: fakeFs(), bus, goals });
  return { bus, config, goals, leash, auditWriter, cal, effectors };
}

// Mirrors reminder-sensor.js's own dispatch logic exactly (leash.check() then
// dispatchAction()) so this test proves the real fire-time contract rather
// than a paraphrase of it.
async function fireAction(rem, ctx) {
  const decision = { tool: rem.action.tool, args: rem.action.args || {} };
  const gate = ctx.leash.check(decision, { goalId: rem.goalId || null });
  if (!gate.allow) return { fired: false, gate };
  const result = await dispatchAction(decision, {
    effectors: ctx.effectors, bus: ctx.bus, memory: null, goals: ctx.goals, config: ctx.config,
    goalId: rem.goalId || null, tier: gate.tier, channel: 'reminder-fire'
  });
  return { fired: true, gate, result };
}

describe('B5: reminder fire-action field', () => {
  it('reminder_add with a T0 action needs no approval and stores the action', () => {
    const h = harness();
    const res = h.cal.addReminder({ text: 'ping', when: 'in 1 minute', action: { tool: 'get_time', args: {} } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.reminder.action, { tool: 'get_time', args: {} });
    assert.equal(res.result.reminder.actionApproved, true, 'a sub-T3 action needs no approval');
    assert.equal(res.result.needsApproval, undefined);
  });

  it('reminder_add with a T3 action (whatsapp_send) anchors an unapproved goal grant', () => {
    const h = harness();
    assert.equal(TIER_TABLE.whatsapp_send, 3, 'fixture check: whatsapp_send must be T3');
    const res = h.cal.addReminder({
      text: 'send the report', when: 'in 10 minutes',
      action: { tool: 'whatsapp_send', args: { contact: 'Bob', text: 'the report is ready' } }
    });
    assert.equal(res.ok, true);
    const rem = res.result.reminder;
    assert.equal(rem.action.tool, 'whatsapp_send');
    assert.equal(rem.actionApproved, false, 'a T3 action must start unapproved');
    assert.ok(rem.goalId, 'a companion goal must anchor the future grant');
    assert.equal(res.result.needsApproval, true);
  });

  it('RED: an unapproved T3 action does not fire when its reminder is due — the gate denies, dispatch never runs', async () => {
    const h = harness();
    const add = h.cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: { contact: 'Bob', text: 'ready' } }
    });
    const rem = add.result.reminder;

    const outcome = await fireAction(rem, h);
    assert.equal(outcome.fired, false, 'an unapproved T3 action must not dispatch');
    assert.equal(outcome.gate.allow, false);
    assert.equal(outcome.gate.requireConfirm, true);
  });

  it('the underlying effector hub is never invoked for an unapproved action', async () => {
    const bus = realBus();
    const config = fakeConfig();
    const goals = createGoalSystem({ fs: fakeFs(), config, bus, memory: null, brain: null });
    const hub = fakeEffectorHub();
    const leash = createLeash({ bus, config, identity: noopIdentity(), auditWriter: recordingAuditWriter(), goals, effectors: hub });
    const cal = createCalendarEffector({ fs: fakeFs(), bus, goals });

    const add = cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: { contact: 'Bob', text: 'ready' } }
    });
    const rem = add.result.reminder;

    const outcome = await fireAction(rem, { leash, goals, effectors: hub, bus, config });
    assert.equal(outcome.fired, false);
    assert.deepEqual(hub._invoked(), [], 'whatsapp_send must never actually run without approval');
  });

  it('reminder_approve_action grants exactly the one tool the reminder carries, then it fires normally', async () => {
    const h = harness();
    const add = h.cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: { contact: 'Bob', text: 'ready' } }
    });
    const rem = add.result.reminder;

    const approve = h.cal.approveReminderAction({ query: 'send the report' });
    assert.equal(approve.ok, true);
    assert.equal(approve.result.reminder.actionApproved, true);
    assert.ok(approve.evidence, 'approval must return oracle-backed evidence, not bare ok:true');
    assert.deepEqual(approve.evidence.grants, ['whatsapp_send'], 'the grant must be an array naming exactly this tool, never a bare tier boolean');

    const outcome = await fireAction(rem, h);
    assert.equal(outcome.fired, true, 'once approved, the SAME reminder must fire without a second confirm');
    assert.equal(outcome.gate.allow, true);
    assert.equal(outcome.gate.reason, 'goal-granted');
    assert.equal(outcome.result.ok, true);
  });

  it('SECURITY: approving one reminder action does not grant a different T3 tool on the same goal', () => {
    const h = harness();
    const add = h.cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: { contact: 'Bob', text: 'ready' } }
    });
    const rem = add.result.reminder;
    h.cal.approveReminderAction({ query: 'send the report' });

    const mustStillConfirm = ['gmail_send', 'delete_file', 'run_command', 'phone_call', 'delete_goal'];
    for (const tool of mustStillConfirm) {
      assert.equal(TIER_TABLE[tool], 3, tool + ' expected to be T3 for this test to mean anything');
      const gate = h.leash.check({ tool, args: {} }, { goalId: rem.goalId });
      assert.equal(gate.allow, false, tool + ' must not be allowed by the whatsapp_send-only grant');
      assert.notEqual(gate.reason, 'goal-granted');
    }
  });

  it('a legacy bare-boolean grant on the reminder\'s goal is not honoured (fails closed)', () => {
    const h = harness();
    const add = h.cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: {} }
    });
    const rem = add.result.reminder;
    const goal = h.goals.get(rem.goalId);
    goal.grants['3'] = true; // simulate a pre-fix persisted goal record

    const gate = h.leash.check({ tool: 'whatsapp_send', args: {} }, { goalId: rem.goalId });
    assert.equal(gate.allow, false, 'a legacy tier-wide grant must fail closed even for a reminder-anchored goal');
  });

  it('AD-2: leash.check() writes exactly one audit line for the fire-time decision', () => {
    const h = harness();
    const add = h.cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: {} }
    });
    const rem = add.result.reminder;
    h.cal.approveReminderAction({ query: 'send the report' });

    const before = h.auditWriter._writes().length;
    h.leash.check({ tool: rem.action.tool, args: rem.action.args }, { goalId: rem.goalId });
    const after = h.auditWriter._writes().length;
    assert.equal(after - before, 1, 'leash.check() must write exactly one audit line per decision (AD-2)');
  });

  it('reminder_add with no goals system still stores the action but cannot be approved (honest degrade)', () => {
    const bus = realBus();
    const cal = createCalendarEffector({ fs: fakeFs(), bus }); // no goals passed
    const res = cal.addReminder({
      text: 'send the report', when: 'in 1 minute',
      action: { tool: 'whatsapp_send', args: {} }
    });
    assert.equal(res.ok, true);
    assert.equal(res.result.reminder.goalId, null, 'no goals system means no grant anchor');
    assert.equal(res.result.reminder.actionApproved, false);

    const approve = cal.approveReminderAction({ query: 'send the report' });
    assert.equal(approve.ok, false, 'approval must fail honestly, not fabricate success');
  });
});
