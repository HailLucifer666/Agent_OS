'use strict';

// health-channel-non-faults.test.js — B3 of the 2026-08-14 session repair.
//
// MEASURED: 68 heal -> no-match records against 6 applied, and at one point 15
// live-reconnect-failed inside 30 seconds (12:29:51 -> 12:30:21), one every ~2s,
// each getting a full diagnose -> heal -> announce -> two-episodic-writes round
// trip. Three separate causes wearing one coat:
//
//   1. NON-FAULTS ON THE FAULT CHANNEL. live-reasoning-leak (24x) is a report that
//      a filter WORKED. live-tool-outcome-late-for-turn (14x) is — for one of its
//      two conditions — the designed behaviour of BUG-128's started/pending ack.
//   2. A PLAYBOOK THAT MATCHED TOO NARROWLY. provider-down was hardcoded to
//      target:{eq:'nim'}, so groq and mistral going down (15:50:37) got no-match.
//   3. NO STORM DAMPING for repeats that no playbook handles.
//
// The wave plan proposed moving both kinds off health.anomaly wholesale. Reading
// the code changed that for one of them — see the late-for-turn suite below. The
// deferral rule stands either way: a playbook that exists only to silence a log
// line is worse than the log line, so the correct outcome for a non-fault is not
// raised at all rather than raised-and-matched.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHealer, SEED_PLAYBOOKS } = require('../src/core/immune/healer');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

function busSpy() {
  const emitted = [];
  const handlers = {};
  return {
    emitted,
    emit(type, payload) {
      emitted.push({ type, payload });
      (handlers[type] || []).forEach((h) => h({ type, payload }));
    },
    subscribe(type, h) {
      (handlers[type] = handlers[type] || []).push(h);
      return () => {};
    },
  };
}

function healerWithClock(bus, extra) {
  let now = 1000;
  const healer = createHealer(Object.assign({
    bus, config: {}, memory: null,
    getCortex: () => null, getGoals: () => null,
    now: () => now,
  }, extra || {}));
  healer.start();
  return { healer, tick: (ms) => { now += ms; }, at: () => now };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('B3.2 the provider-down playbook follows the provider that actually failed', () => {
  it('groq going down now matches a playbook instead of falling through to no-match', async () => {
    const bus = busSpy();
    const { healer } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'provider-down', target: 'groq' });
    await sleep(10);
    const healed = bus.emitted.find((e) => e.type === 'health.healed');
    assert.ok(healed);
    assert.notEqual(healed.payload.outcome, 'no-match',
      'on 2026-08-14 groq and mistral both went down and the immune system had nothing to do about either, '
      + 'because the only provider-down playbook was pinned to the one provider whose key can be rotated');
    assert.equal(healed.payload.playbookId, 'rotate-nim-key');
    healer.stop();
  });

  it('mistral too — the match is on the kind, not an allowlist of providers', async () => {
    const bus = busSpy();
    const { healer } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'provider-down', target: 'mistral' });
    await sleep(10);
    assert.notEqual(bus.emitted.find((e) => e.type === 'health.healed').payload.outcome, 'no-match');
    healer.stop();
  });

  it('nim still matches, since it is the provider the whole playbook was written for', async () => {
    const bus = busSpy();
    const { healer } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'provider-down', target: 'nim' });
    await sleep(10);
    assert.equal(bus.emitted.find((e) => e.type === 'health.healed').payload.playbookId, 'rotate-nim-key');
    healer.stop();
  });

  it('the spoken title no longer names NVIDIA, because it now fires for any provider', () => {
    // BUG-162 added titles so the announcer could say WHAT was healed, which makes
    // the title operator-facing text. "NVIDIA provider key rotation" spoken over a
    // mistral outage would be a plain falsehood — and it was already inaccurate,
    // since probe-provider ignores its args and does a global registry.refresh().
    const pb = SEED_PLAYBOOKS.find((p) => p.id === 'rotate-nim-key');
    assert.ok(pb, 'the id is load-bearing in stored audit rows and must not be renamed');
    assert.doesNotMatch(pb.title, /NVIDIA/i);
    assert.doesNotMatch(pb.title, /key rotation/i, 'the action does not rotate a key');
    assert.match(pb.title, /provider/i, 'but it must still say what it is about');
  });

  it('the widening does not raise the ceilings — cooldown is unchanged', async () => {
    const bus = busSpy();
    const { healer, tick } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'provider-down', target: 'groq' });
    await sleep(10);
    tick(1000);
    bus.emit('health.diagnosed', { kind: 'provider-down', target: 'groq' });
    await sleep(10);
    const outcomes = bus.emitted.filter((e) => e.type === 'health.healed').map((e) => e.payload.outcome);
    assert.ok(outcomes.includes('cooldown') || outcomes.includes('heal-failed'),
      'three providers flapping must not become three remediations a second — the match widened, '
      + 'the cooldown and recurrence ceilings did not; got ' + JSON.stringify(outcomes));
    healer.stop();
  });
});

describe('B3.3 a no-match storm is diagnosed once, and says how many it swallowed', () => {
  it('15 identical no-match anomalies in 30 seconds produce ONE verdict', async () => {
    // The measured burst: live-reconnect-failed, one every ~2s for 30s.
    const bus = busSpy();
    const { healer, tick } = healerWithClock(bus);
    for (let i = 0; i < 15; i += 1) {
      bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-resume' });
      await sleep(1);
      tick(2000);
    }
    const healed = bus.emitted.filter((e) => e.type === 'health.healed');
    assert.equal(healed.length, 1,
      'each of the 15 used to get a full diagnose -> heal -> announce -> two-writes round trip; got ' + healed.length);
    healer.stop();
  });

  it('after the window, the next verdict reports what was suppressed — nothing vanishes', async () => {
    const bus = busSpy();
    const { healer, tick } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-resume' });
    await sleep(1);
    for (let i = 0; i < 4; i += 1) {
      tick(1000);
      bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-resume' });
      await sleep(1);
    }
    tick(40000);   // past the 30s damping window
    bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-resume' });
    await sleep(1);

    const healed = bus.emitted.filter((e) => e.type === 'health.healed');
    assert.equal(healed.length, 2, 'one before the window, one after');
    assert.equal(healed[1].payload.detail.suppressedCount, 4,
      'a storm must be visible as a NUMBER rather than as 15 identical records or as silence');
    healer.stop();
  });

  it('a DIFFERENT target is not damped by the first one', async () => {
    const bus = busSpy();
    const { healer } = healerWithClock(bus);
    bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-a' });
    await sleep(1);
    bus.emit('health.diagnosed', { kind: 'live-reconnect-failed', target: 'session-b' });
    await sleep(1);
    assert.equal(bus.emitted.filter((e) => e.type === 'health.healed').length, 2,
      'damping is keyed kind:target, so two different subjects are two different problems');
    healer.stop();
  });

  it('damping NEVER applies to an outcome that did something — that is the safety property', async () => {
    // Damping identical kind:target regardless of outcome would have been simpler
    // and could suppress a real remediation: budget-pause deliberately runs with
    // cooldownMs: 0 ("immediate, every time"). Scoping to no-match means the branch
    // is only reachable when nothing was going to happen anyway.
    const bus = busSpy();
    const paused = [];
    const { healer } = healerWithClock(bus, {
      getGoals: () => ({ pause: (id, reason) => { paused.push({ id, reason }); return true; } }),
    });
    for (let i = 0; i < 3; i += 1) {
      bus.emit('health.diagnosed', { kind: 'budget-exhausted', target: 'goal-1' });
      await sleep(5);
    }
    const healed = bus.emitted.filter((e) => e.type === 'health.healed');
    assert.ok(healed.length >= 3,
      'every budget-exhausted must still get a verdict — cooldownMs is 0 for this playbook on purpose; got '
      + healed.length);
    assert.equal(healed.some((h) => h.payload.outcome === 'no-match'), false,
      'and none of them may read as no-match, which is the only outcome damping can touch');
    healer.stop();
  });
});

describe('B3.1 late-for-turn: the noisy half is separated from the real signal', () => {
  // The wave plan filed this whole KIND as "not a fault since BUG-128". Reading
  // the code, only one of the two conditions reaching that branch is designed
  // behaviour, so the kind stays on the health channel and the noise is removed.
  function adapter(bus) {
    return createLiveToolAdapter({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'ok' }),
        confirm: { create: () => 'c1' },
      },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus,
      logger: { warn() {}, info() {} },
      connectionId: 'conn-b3',
      memory: { working: { tick: 1 }, episodic: { write: () => {} } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: () => {} }),
      toolAckDeadlineMs: 20,
    });
  }

  it('a pending ACK whose turn closed during the wait raises nothing', async () => {
    // Designed behaviour: the ack is written after up to 1500ms of raceDeadline,
    // and reportLateOutcome still delivers the real result afterwards. Nothing was
    // misattributed, so a fault-channel entry here is pure noise — this is the 14.
    const bus = busSpy();
    const a = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'ok' }), confirm: { create: () => 'c1' } },
      dispatchAction: async () => { await sleep(200); return { ok: true, result: {} }; },
      bus,
      logger: { warn() {}, info() {} },
      connectionId: 'conn-b3',
      memory: { working: { tick: 1 }, episodic: { write: () => {} } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: () => {} }),
      toolAckDeadlineMs: 20,
    });
    // Close the turn while the dispatch is still in flight, so the started ack
    // lands against a stale generation.
    const walking = a.handleLiveToolCalls(
      [{ id: 'x1', name: 'browser_navigate', args: { url: 'https://example.com' } }],
      { sendToolResponse: () => {} },
    );
    a.onLiveTurnComplete({ userText: 'go', assistantText: 'Opening it.', turnId: 1 });
    await walking;
    await sleep(50);

    const late = bus.emitted.filter((e) => e.type === 'health.anomaly'
      && e.payload.kind === 'live-tool-outcome-late-for-turn');
    assert.equal(late.length, 0,
      'a started/pending ack arriving after its turn closed is the ack mechanism working as designed');
  });

  it('a real OUTCOME that missed its turn still raises it — that signal must not be lost', async () => {
    const bus = busSpy();
    const a = adapter(bus);
    // Drive commitAction directly through a completed dispatch whose turn has
    // already advanced. A non-started entry here IS the misattribution risk
    // BUG-105 was filed for (the explainer said "the music playback tool was late"
    // when the late tool was list_windows).
    const walking = a.handleLiveToolCalls(
      [{ id: 'x2', name: 'list_windows', args: {} }],
      { sendToolResponse: () => {} },
    );
    a.onLiveTurnComplete({ userText: 'go', assistantText: 'Looking.', turnId: 1 });
    await walking;
    await sleep(30);
    const late = bus.emitted.filter((e) => e.type === 'health.anomaly'
      && e.payload.kind === 'live-tool-outcome-late-for-turn');
    assert.equal(late.length, 1, 'a resolved outcome landing in the wrong turn is a genuine anomaly');
    assert.equal(late[0].payload.target, 'list_windows',
      'BUG-105: target must be set, or the explainer invents a component');
  });
});

describe('B3.1 the reasoning strip left the fault channel without going silent', () => {
  it('voice.live.reasoning-filtered is registered, so the conformance gate accepts it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'event-name-conformance.test.js'), 'utf8');
    assert.match(src, /'voice\.live\.reasoning-filtered'/,
      'an unregistered event name fails the conformance scan — moving a channel is a two-file change');
  });

  it('live-session.js no longer puts a working filter on health.anomaly', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'voice', 'live-session.js'), 'utf8');
    assert.doesNotMatch(src, /kind: 'live-reasoning-leak'/,
      'it fired 24 times in one session, producing 24 no-match heal round trips for a filter doing its job');
    assert.match(src, /voice\.live\.reasoning-filtered/);
    assert.match(src, /live\.reasoning-stripped/,
      'BUG-170: a strip is never silent. The logger.warn must survive the channel move.');
  });
});
