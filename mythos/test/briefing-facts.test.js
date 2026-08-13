'use strict';

// TASK B2 — buildBriefingFacts() behavioral coverage.
//
// server/index.js's deliverBootGreeting() used to assemble its fact list
// inline, which only source-shape tests could pin. It is now extracted to
// src/core/conversation/briefing.js (same rationale as electron/child-exit.js's
// extraction: testable behavior, not just source-shape). This file drives
// buildBriefingFacts() directly with fake deps: each fact present when its
// source works, skipped when its source times out, skipped when its source
// throws, and the two update-report phrasings.
//
// Run: cd mythos && node --test test/briefing-facts.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildBriefingFacts } = require('../src/core/conversation/briefing');

// Small so timeout tests stay fast; large enough that a resolved promise on
// the same tick always wins the race.
const FAST_TIMEOUT_MS = 30;

function never() {
  // A promise that deliberately never settles — the only honest way to
  // exercise the timeout branch of a real Promise.race.
  return new Promise(() => {});
}

describe('buildBriefingFacts: pre-existing facts still assemble', () => {
  it('local time fact is always present', async () => {
    const facts = await buildBriefingFacts({ factTimeoutMs: FAST_TIMEOUT_MS });
    assert.ok(facts.some((f) => f.startsWith('Local time: ')), JSON.stringify(facts));
  });

  it('goals fact present when goalsEffector.stats() works', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: { stats: () => ({ active: 2, done: 5 }) },
    });
    assert.ok(facts.includes('Goals: 2 active, 5 done'), JSON.stringify(facts));
  });

  it('goals fact skipped when goalsEffector.stats() throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: { stats: () => { throw new Error('boom'); } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Goals:')), JSON.stringify(facts));
  });

  it('goals fact skipped when goalsEffector.stats() hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: { stats: () => never() },
    });
    assert.ok(!facts.some((f) => f.startsWith('Goals:')), JSON.stringify(facts));
  });

  it('provider-health fact reports down providers by name', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      probes: { getStatus: async () => ({ providers: {} }) },
      isProviderDown: (id) => id === 'groq',
    });
    assert.ok(facts.includes('AI providers down: groq'), JSON.stringify(facts));
  });

  it('provider-health fact says all online when none are down', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      probes: { getStatus: async () => ({ providers: {} }) },
      isProviderDown: () => false,
    });
    assert.ok(facts.includes('All AI providers online'), JSON.stringify(facts));
  });

  it('provider-health fact skipped when probes.getStatus() throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      probes: { getStatus: async () => { throw new Error('offline'); } },
      isProviderDown: () => false,
    });
    assert.ok(!facts.some((f) => f.indexOf('providers') !== -1), JSON.stringify(facts));
  });

  it('provider-health fact skipped when probes.getStatus() hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      probes: { getStatus: () => never() },
      isProviderDown: () => false,
    });
    assert.ok(!facts.some((f) => f.indexOf('providers') !== -1), JSON.stringify(facts));
  });

  it('gitRef upgrade fact present when bootUpgrade.upgraded is true', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      bootUpgrade: { upgraded: true, changes: ['fix(voice): thing'] },
    });
    assert.ok(facts.some((f) => f.indexOf('code upgrade') !== -1 && f.indexOf('fix(voice): thing') !== -1), JSON.stringify(facts));
  });

  it('gitRef upgrade fact absent when bootUpgrade.upgraded is false', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      bootUpgrade: { upgraded: false, changes: [] },
    });
    assert.ok(!facts.some((f) => f.indexOf('code upgrade') !== -1), JSON.stringify(facts));
  });

  it('last-conversations fact present when episodic.recall() returns hits', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { episodic: { recall: () => [{ record: { summary: 'we talked about X' } }] } },
    });
    assert.ok(facts.includes('Last time we spoke: we talked about X'), JSON.stringify(facts));
  });

  it('last-conversations fact skipped when episodic.recall() throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { episodic: { recall: () => { throw new Error('no vault'); } } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Last time we spoke:')), JSON.stringify(facts));
  });

  it('last-conversations fact skipped when episodic.recall() hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { episodic: { recall: () => never() } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Last time we spoke:')), JSON.stringify(facts));
  });
});

describe('buildBriefingFacts: update-report phrasing (TASK B1 carryover)', () => {
  it('success branch names the new version and includes release notes', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      updateReport: { completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: 'Fixed the thing.' },
    });
    const fact = facts.find((f) => f.indexOf('updated to v') !== -1);
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('0.2.0') !== -1, fact);
    assert.ok(fact.indexOf('Fixed the thing.') !== -1, fact);
  });

  it('failure branch states it did not complete and includes both versions ("from" present)', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      updateReport: { completed: false, version: '0.2.0', from: '0.1.9', releaseNotes: '' },
    });
    const fact = facts.find((f) => f.indexOf('did not complete') !== -1);
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('0.2.0') !== -1, fact);
    assert.ok(fact.indexOf('from') !== -1 || fact.indexOf('0.1.9') !== -1, fact);
    // Explicit per the task: the failure phrasing must include "from" — this
    // repo's own wording is "still on v<from>", which literally contains "from"
    // only as the variable's value, so pin the still-on-v0.1.9 clause directly.
    assert.ok(fact.indexOf('still on v0.1.9') !== -1, fact);
  });

  it('no update fact when updateReport is null', async () => {
    const facts = await buildBriefingFacts({ factTimeoutMs: FAST_TIMEOUT_MS, updateReport: null });
    assert.ok(!facts.some((f) => f.indexOf('updated to v') !== -1 || f.indexOf('did not complete') !== -1), JSON.stringify(facts));
  });
});

describe('buildBriefingFacts: new fact — weather (via get_weather effector)', () => {
  it('present when the get_weather effector succeeds', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      dispatch: async (tool) => {
        assert.equal(tool, 'get_weather');
        return { ok: true, result: { location: 'Testville', temperatureC: 21, condition: 'Clear' } };
      },
    });
    const fact = facts.find((f) => f.startsWith('Weather'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('Testville') !== -1 && fact.indexOf('21') !== -1 && fact.indexOf('Clear') !== -1, fact);
  });

  it('skipped when the effector reports ok:false', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      dispatch: async () => ({ ok: false, result: 'Weather is unavailable right now.' }),
    });
    assert.ok(!facts.some((f) => f.startsWith('Weather')), JSON.stringify(facts));
  });

  it('skipped when the effector throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      dispatch: async () => { throw new Error('network down'); },
    });
    assert.ok(!facts.some((f) => f.startsWith('Weather')), JSON.stringify(facts));
  });

  it('skipped when the effector hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      dispatch: () => never(),
    });
    assert.ok(!facts.some((f) => f.startsWith('Weather')), JSON.stringify(facts));
  });

  it('reaches the hub only through the injected dispatch function (AD-1: no raw effectors.invoke in briefing.js)', async () => {
    let invoked = false;
    await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      dispatch: async () => { invoked = true; return { ok: true, result: { temperatureC: 1 } }; },
    });
    assert.ok(invoked, 'expected the weather fact to reach the hub via deps.dispatch');
  });
});

describe('buildBriefingFacts: new fact — system conditions (snapshotSystemMetrics)', () => {
  it('present when snapshotSystemMetrics resolves usable numbers', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      systemSampleGapMs: 0,
      snapshotSystemMetrics: async () => ({ metrics: { cpu: { loadPercent: 42 }, mem: { usedPercent: 60 } } }),
    });
    const fact = facts.find((f) => f.startsWith('System:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('42%') !== -1 && fact.indexOf('60%') !== -1, fact);
  });

  it('skipped when snapshotSystemMetrics throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      systemSampleGapMs: 0,
      snapshotSystemMetrics: async () => { throw new Error('os.cpus failed'); },
    });
    assert.ok(!facts.some((f) => f.startsWith('System:')), JSON.stringify(facts));
  });

  it('skipped when snapshotSystemMetrics hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      systemSampleGapMs: 0,
      snapshotSystemMetrics: () => never(),
    });
    assert.ok(!facts.some((f) => f.startsWith('System:')), JSON.stringify(facts));
  });

  it('skipped when neither cpu.loadPercent nor mem.usedPercent is a number (e.g. cold-start null)', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      systemSampleGapMs: 0,
      snapshotSystemMetrics: async () => ({ metrics: { cpu: { loadPercent: null }, mem: { usedPercent: null } } }),
    });
    assert.ok(!facts.some((f) => f.startsWith('System:')), JSON.stringify(facts));
  });

  // FIX 3 (code review, 2026-08-13): snapshotSystemMetrics(undefined) used to
  // diff a single os.cpus() sample against itself — zero elapsed time, so
  // cpu.loadPercent was null on every real boot and the CPU clause could never
  // populate. buildBriefingFacts now takes two samples (systemSampleGapMs apart)
  // and diffs the second against the first. Proves it with the REAL
  // snapshotSystemMetrics from server/routes/system.js, not a fake, so a
  // regression back to the single-sample self-diff would fail this test.
  it('the CPU clause actually populates against the real snapshotSystemMetrics (not structurally dead)', async () => {
    const { snapshotSystemMetrics } = require('../server/routes/system');
    const facts = await buildBriefingFacts({
      factTimeoutMs: 5000,
      systemSampleGapMs: 120,
      snapshotSystemMetrics,
    });
    const fact = facts.find((f) => f.startsWith('System:'));
    assert.ok(fact, 'expected a System: fact from the real snapshotSystemMetrics: ' + JSON.stringify(facts));
    assert.match(fact, /CPU \d+%/, 'CPU clause must carry a real number, not stay permanently null: ' + fact);
  });
});

describe('buildBriefingFacts: new fact — spend (spend.getStats().today, no dollars)', () => {
  it('present when spend.getStats() reports calls today', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      spend: { getStats: () => ({ successRate: 97, today: { calls: 12, tokensIn: 500, tokensOut: 300 } }) },
    });
    const fact = facts.find((f) => f.startsWith('Today so far:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('12 brain calls') !== -1, fact);
    assert.ok(fact.indexOf('800 tokens') !== -1, fact);
    assert.ok(fact.indexOf('97%') !== -1, fact);
    // FIX 4 (code review, 2026-08-13): successRate spans the whole in-memory
    // recent-call buffer, not just today — the fact must say so rather than
    // implying "97% success" is itself today-scoped like the calls/tokens are.
    assert.match(fact, /not today-scoped/i, 'success-rate clause must disclose it is not today-scoped: ' + fact);
    assert.ok(!/\$/.test(fact), 'spend fact must never invent a dollar figure: ' + fact);
  });

  it('skipped when there were no calls today', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      spend: { getStats: () => ({ successRate: 100, today: { calls: 0, tokensIn: 0, tokensOut: 0 } }) },
    });
    assert.ok(!facts.some((f) => f.startsWith('Today so far:')), JSON.stringify(facts));
  });

  it('skipped when spend.getStats() throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      spend: { getStats: () => { throw new Error('boom'); } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Today so far:')), JSON.stringify(facts));
  });

  it('skipped when spend.getStats() hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      spend: { getStats: () => never() },
    });
    assert.ok(!facts.some((f) => f.startsWith('Today so far:')), JSON.stringify(facts));
  });
});

describe('buildBriefingFacts: new fact — needs-done (goals + kanban + proposals + reminders)', () => {
  it('combines all four sources into one line', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: {
        stats: () => ({ active: 3, done: 1 }),
        listProposals: () => [{ id: 'p1' }, { id: 'p2' }],
      },
      kanbanEffector: {
        listBoard: () => ({ cards: [{ lane: 'backlog' }, { lane: 'building' }, { lane: 'done' }] }),
      },
      dispatch: async (tool) => {
        if (tool === 'reminder_list') {
          return { ok: true, result: { reminders: [{ dueAt: Date.now() - 1000, fired: false }, { dueAt: Date.now() + 100000, fired: false }] } };
        }
        return { ok: true };
      },
    });
    const fact = facts.find((f) => f.startsWith('On your plate:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('3 active goals') !== -1, fact);
    assert.ok(fact.indexOf('2 kanban cards in progress') !== -1, fact);
    assert.ok(fact.indexOf('2 pending proposals') !== -1, fact);
    assert.ok(fact.indexOf('1 due reminder') !== -1, fact);
  });

  it('skipped entirely when every source is empty/absent', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: { stats: () => ({ active: 0, done: 0 }) },
      kanbanEffector: { listBoard: () => ({ cards: [] }) },
    });
    assert.ok(!facts.some((f) => f.startsWith('On your plate:')), JSON.stringify(facts));
  });

  it('does not throw when one of the four sources throws — the others still contribute', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      goalsEffector: {
        stats: () => { throw new Error('goals down'); },
        listProposals: () => [{ id: 'p1' }],
      },
      kanbanEffector: { listBoard: () => ({ cards: [] }) },
    });
    const fact = facts.find((f) => f.startsWith('On your plate:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('1 pending proposal') !== -1, fact);
    assert.ok(fact.indexOf('active goal') === -1, fact);
  });

  it('skipped (not hung) when the reminder lookup inside needs-done hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      // Goals resolve fine synchronously, but the whole needs-done fact still
      // must not out-live the timeout just because the reminder lookup hangs —
      // proves the outer Promise.race actually bounds this fact's wall time.
      goalsEffector: { stats: () => ({ active: 4, done: 0 }) },
      dispatch: () => never(),
    });
    assert.ok(!facts.some((f) => f.startsWith('On your plate:')), JSON.stringify(facts));
  });
});

describe('buildBriefingFacts: new fact — self-healing since last boot (memory.audit.query, TASK B4)', () => {
  const NOW = Date.now();
  // No deps.previousBootAt supplied -> briefing.js falls back to its
  // DEFAULT_SELF_HEALING_WINDOW_MS (24h), so these tests can predict the
  // "in the last 24 hours" wording without depending on that constant's
  // literal value from outside the module.
  const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;
  // A previousBootAt this far back drives the window via the real
  // since-last-boot path (FIX 1) instead of the fallback.
  const CUSTOM_WINDOW_MS = 2 * 3600 * 1000; // 2h
  const previousBootAtFor = (windowMs) => NOW - windowMs;

  it('present and phrased from playbookId + count when applied heal records exist in the window', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
            { ts: NOW - 2000, decision: 'heal', playbookId: 'search-provider-degrade', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing in the last 24 hours:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('2 heals') !== -1, fact);
    assert.ok(fact.indexOf('stall restart once') !== -1, fact);
    assert.ok(fact.indexOf('search provider degrade once') !== -1, fact);
    assert.ok(fact.indexOf('at least') === -1, 'a small, uncapped result must not claim partial coverage: ' + fact);
  });

  it('counts repeated playbookIds instead of listing each occurrence separately', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
            { ts: NOW - 2000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing in the last 24 hours:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('stall restart 2 times') !== -1, fact);
  });

  it('ABSENT when there are no heal records at all', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { audit: { query: () => [] } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Self-healing')), JSON.stringify(facts));
  });

  it('ABSENT (not a vague "nothing to report") when every record in range failed (outcome !== applied)', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'rotate-nim-key', outcome: 'error' },
          ],
        },
      },
    });
    assert.ok(!facts.some((f) => f.startsWith('Self-healing')), JSON.stringify(facts));
  });

  it('skipped when memory.audit.query throws', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { audit: { query: () => { throw new Error('audit unreadable'); } } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Self-healing')), JSON.stringify(facts));
  });

  it('skipped when memory.audit.query hangs past the timeout', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { audit: { query: () => never() } },
    });
    assert.ok(!facts.some((f) => f.startsWith('Self-healing')), JSON.stringify(facts));
  });

  // This is the assertion that proves the window is real rather than
  // decorative: a record well outside the window must not count toward the
  // fact, even though the exact same record would be counted (and change
  // the phrasing) if it were inside the window. Uses previousBootAt (FIX 1)
  // to drive a real, non-default window rather than the 24h fallback.
  it('excludes records outside the window — a record from 2x the window ago does not count', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      previousBootAt: previousBootAtFor(CUSTOM_WINDOW_MS),
      memory: {
        audit: {
          query: () => [
            { ts: NOW - (2 * CUSTOM_WINDOW_MS), decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
          ],
        },
      },
    });
    assert.ok(!facts.some((f) => f.startsWith('Self-healing')), JSON.stringify(facts));
  });

  it('an in-window record is still reported when mixed with an out-of-window record, and the window is named by hours since previousBootAt', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      previousBootAt: previousBootAtFor(CUSTOM_WINDOW_MS),
      memory: {
        audit: {
          query: () => [
            { ts: NOW - (2 * CUSTOM_WINDOW_MS), decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
            { ts: NOW - 1000, decision: 'heal', playbookId: 'search-provider-degrade', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing in the last 2 hours:'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('search provider degrade once') !== -1, fact);
    assert.ok(fact.indexOf('stall restart') === -1, fact);
  });

  // FIX 1: previousBootAt drives the window, capped at MAX_SELF_HEALING_WINDOW_MS
  // (7 days) so a long-idle machine cannot stretch the fact's scope into an
  // absurd claim. A gap far beyond the cap must still describe itself using
  // the CAPPED window, not the raw (much larger) gap.
  it('caps an unusually long since-last-boot gap instead of reporting it verbatim', async () => {
    const hugeGapMs = 30 * 24 * 3600 * 1000; // 30 days
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      previousBootAt: previousBootAtFor(hugeGapMs),
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('in the last 168 hours:') !== -1, // 7 days, the cap
      'expected the fact to name the CAPPED window (168h), not the raw 720h gap: ' + fact);
  });

  // FIX 2: query({decision:'heal', limit}) walks newest-first and stops at
  // `limit` matches regardless of outcome — a noisy window (a playbook
  // re-firing on a short cooldown writes decision:'heal' every time, not
  // just on outcome:'applied') can fill every slot with non-applied rows
  // and push genuine in-window applied heals out of the result set. If this
  // were ignored, the fact would silently report a smaller number than the
  // truth. Simulates hitting the cap: SELF_HEALING_QUERY_LIMIT (500)
  // records, all still inside the default 24h window, so the oldest
  // returned record does NOT prove the window is fully covered.
  it('detects truncation at the query cap and says "at least" instead of a false-complete count', async () => {
    const CAP = 500;
    const records = [];
    for (let i = 0; i < CAP; i++) {
      // Mostly noise (re-fired cooldown/no-match rows also carry
      // decision:'heal'), 3 genuine applied heals mixed in among them.
      const outcome = (i === 10 || i === 200 || i === 400) ? 'applied' : 'cooldown';
      records.push({ ts: NOW - (i * 1000), decision: 'heal', playbookId: 'search-provider-degrade', outcome });
    }
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: { audit: { query: () => records } },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('at least 3 heals') !== -1,
      'expected an honest lower-bound count flagged as partial, not a bare (and misleadingly exact-looking) 3: ' + fact);
  });

  it('does NOT say "at least" when the result is well under the query cap (no truncation)', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('at least') === -1, fact);
    assert.ok(fact.indexOf('1 heal —') !== -1, fact);
  });

  // FIX 3: the sentence must not name an unbounded number of distinct
  // playbooks — same precedent as the last-conversations fact's
  // slice(0, 3) and needs-done's four fixed sub-counts.
  it('caps the number of distinct playbooks named and folds the rest into "+N more"', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      memory: {
        audit: {
          query: () => [
            { ts: NOW - 1000, decision: 'heal', playbookId: 'stall-restart', outcome: 'applied' },
            { ts: NOW - 2000, decision: 'heal', playbookId: 'search-provider-degrade', outcome: 'applied' },
            { ts: NOW - 3000, decision: 'heal', playbookId: 'rotate-nim-key', outcome: 'applied' },
            { ts: NOW - 4000, decision: 'heal', playbookId: 'mem-consolidate', outcome: 'applied' },
            { ts: NOW - 5000, decision: 'heal', playbookId: 'budget-pause', outcome: 'applied' },
          ],
        },
      },
    });
    const fact = facts.find((f) => f.startsWith('Self-healing'));
    assert.ok(fact, JSON.stringify(facts));
    assert.ok(fact.indexOf('stall restart once') !== -1, fact);
    assert.ok(fact.indexOf('search provider degrade once') !== -1, fact);
    assert.ok(fact.indexOf('rotate nim key once') !== -1, fact);
    assert.ok(fact.indexOf('mem consolidate') === -1, 'expected the 4th distinct playbook to be folded away: ' + fact);
    assert.ok(fact.indexOf('budget pause') === -1, 'expected the 5th distinct playbook to be folded away: ' + fact);
    assert.ok(fact.indexOf('2 more') !== -1, fact);
  });
});

describe('buildBriefingFacts: no dependencies at all', () => {
  it('never throws and still produces the local-time fact', async () => {
    const facts = await buildBriefingFacts();
    assert.ok(Array.isArray(facts));
    assert.ok(facts.some((f) => f.startsWith('Local time: ')));
  });
});

// FIX 1 (code review, 2026-08-13): sources used to gather one at a time, so
// each ~timeoutMs cap STACKED — several slow sources in a row added seconds
// of latency in front of the 12s brain-compose race. Gathering with
// Promise.all bounds the wall-clock cost to the slowest single source.
describe('buildBriefingFacts: sources gather in parallel (FIX 1)', () => {
  it('total wall time stays close to one slow source, not the sum of several', async () => {
    const SLOW_MS = 60; // well under FAST_TIMEOUT_MS's usual 30ms elsewhere, but this test needs the source to actually finish, not time out
    const slow = () => new Promise((resolve) => setTimeout(() => resolve(true), SLOW_MS));
    const started = Date.now();
    await buildBriefingFacts({
      factTimeoutMs: 500,
      systemSampleGapMs: 0,
      // Three independently slow sources. Sequential gathering would cost
      // roughly 3 x SLOW_MS; parallel gathering should cost roughly 1x.
      probes: { getStatus: async () => { await slow(); return { providers: {} }; } },
      isProviderDown: () => false,
      dispatch: async (tool) => { await slow(); return tool === 'get_weather' ? { ok: true, result: { temperatureC: 1 } } : { ok: true }; },
      spend: { getStats: async () => { await slow(); return { successRate: 100, today: { calls: 1, tokensIn: 1, tokensOut: 1 } }; } },
    });
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < SLOW_MS * 2,
      `expected parallel gathering to cost roughly one SLOW_MS (${SLOW_MS}ms), took ${elapsedMs}ms — looks sequential`);
  });

  it('preserves the original fact order regardless of which source resolves first', async () => {
    const facts = await buildBriefingFacts({
      factTimeoutMs: FAST_TIMEOUT_MS,
      systemSampleGapMs: 0,
      goalsEffector: { stats: () => ({ active: 1, done: 0 }) },
      probes: { getStatus: async () => ({ providers: {} }) },
      isProviderDown: () => false,
      bootUpgrade: { upgraded: true, changes: ['x'] },
      updateReport: { completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: '' },
      memory: { episodic: { recall: () => [{ record: { summary: 'hi' } }] } },
      dispatch: async (tool) => (tool === 'get_weather'
        ? { ok: true, result: { temperatureC: 5 } }
        : { ok: true, result: { reminders: [] } }),
      snapshotSystemMetrics: async () => ({ metrics: { cpu: { loadPercent: 1 }, mem: { usedPercent: 2 } } }),
      spend: { getStats: () => ({ successRate: 100, today: { calls: 1, tokensIn: 1, tokensOut: 1 } }) },
      kanbanEffector: { listBoard: () => ({ cards: [] }) },
    });
    const order = ['Local time:', 'Goals:', 'All AI providers online', 'You received a code upgrade',
      'I was updated to v', 'Last time we spoke:', 'Weather', 'System:', 'Today so far:', 'On your plate:'];
    const indices = order.map((prefix) => facts.findIndex((f) => f.indexOf(prefix) === 0));
    assert.ok(indices.every((i) => i !== -1), 'expected every fact to be present: ' + JSON.stringify(facts));
    for (let i = 1; i < indices.length; i++) {
      assert.ok(indices[i - 1] < indices[i], `expected "${order[i - 1]}" before "${order[i]}": ${JSON.stringify(facts)}`);
    }
  });
});
