'use strict';

// Phase 3 Jarvis upgrade — the daily_plan tool (from-dashboard.js), exercised
// via a fake planner handle injected through setPlannerHandle (same pattern
// from-pc.js's ambient_awareness test would use for setScreenSensorHandle).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolByName(tools, name) {
  for (const t of tools) if (t.name === name) return t;
  throw new Error('tool not found: ' + name);
}

function fakePlanner() {
  const day = { date: '2026-07-17', focus: [{ goalId: 'g1', title: 'Ship it' }], checkins: [], review: null, morningFiredAt: 123, lastCheckinAt: null, eveningFiredAt: null };
  return {
    day,
    statusCalls: 0,
    replanCalls: 0,
    skipCalls: 0,
    status() { this.statusCalls++; return this.day; },
    async runMorning() { this.replanCalls++; return { text: 'Re-briefed.', focus: this.day.focus }; },
    skipToday() { this.skipCalls++; this.day.morningFiredAt = this.day.morningFiredAt || Date.now(); this.day.eveningFiredAt = Date.now(); return this.day; },
  };
}

describe('daily_plan tool (from-dashboard.js)', () => {
  it('fails honestly when no planner handle has been injected', async () => {
    const built = buildTools({});
    const res = await toolByName(built.TOOLS, 'daily_plan').fn({ action: 'status' });
    assert.equal(res.ok, false);
  });

  it('action:"status" reads the current day file via planner.status()', async () => {
    const built = buildTools({});
    const planner = fakePlanner();
    built.setPlannerHandle(planner);

    const res = await toolByName(built.TOOLS, 'daily_plan').fn({ action: 'status' });
    assert.equal(res.ok, true);
    assert.equal(res.result.day.date, '2026-07-17');
    assert.equal(planner.statusCalls, 1);
  });

  it('action:"replan" re-runs the morning brief (explicit re-brief allowed)', async () => {
    const built = buildTools({});
    const planner = fakePlanner();
    built.setPlannerHandle(planner);

    const res = await toolByName(built.TOOLS, 'daily_plan').fn({ action: 'replan' });
    assert.equal(res.ok, true);
    assert.equal(res.result.text, 'Re-briefed.');
    assert.equal(planner.replanCalls, 1);
  });

  it('action:"skip_today" quiets the day (sets fired-flags)', async () => {
    const built = buildTools({});
    const planner = fakePlanner();
    built.setPlannerHandle(planner);

    const res = await toolByName(built.TOOLS, 'daily_plan').fn({ action: 'skip_today' });
    assert.equal(res.ok, true);
    assert.ok(res.result.day.morningFiredAt);
    assert.ok(res.result.day.eveningFiredAt);
    assert.equal(planner.skipCalls, 1);
  });

  it('defaults to "status" when action is omitted, and rejects unknown actions', async () => {
    const built = buildTools({});
    const planner = fakePlanner();
    built.setPlannerHandle(planner);

    const defaultRes = await toolByName(built.TOOLS, 'daily_plan').fn({});
    assert.equal(defaultRes.ok, true);
    assert.equal(planner.statusCalls, 1);

    const badRes = await toolByName(built.TOOLS, 'daily_plan').fn({ action: 'nonsense' });
    assert.equal(badRes.ok, false);
  });
});
