'use strict';

// immune/announcer.js — RW of NOVA app/lib/voice/checkpoint-announcer.js. Speaks
// significant immune-system events: successful heals and post-crash recovery.
//
// W6 (Phase 2 — Wiring Integrity): this module NO LONGER subscribes to
// health.diagnosed. Both immune/announcer and conversation/announcer were
// speaking on that channel, so the operator heard every diagnosis twice.
// conversation/announcer is now the single speaker for health.diagnosed
// (it generates a brain-natural sentence instead of the canned "Health alert:
// <kind>" string). This module keeps breaker/heal lifecycle speech only.
//
// `speak` is required at construction — never a silent no-op (this is the one place
// in Phase 6 where a missing dependency is NOT tolerated at call time, because the
// alternative is a silently-swallowed announcement with no trace anywhere). Until
// Phase 7 ships a real voice effector, main.js wires `speak` to re-emit onto the
// 'action' channel so nothing is lost — see Spec Ambiguities Resolved.

// BUG-030: probes.js re-emits 'health.anomaly' every 4s (no dedup by design — healer.js's
// cooldown depends on anomalies flowing freely). No schema.js key for the window (same
// precedent as breakers.js's maxResetMs) — config override exists solely so tests
// don't have to wait out a real 10-minute window.
//
// BUG-273 (2026-08-19) — THE MAP BELOW WAS DECLARED, DOCUMENTED AND NEVER APPLIED.
// Its comment used to end "today no subscriber uses it but the cooldown precedent
// stays documented", and onHealed spoke on every single applied heal. A condition
// that keeps recurring gets re-healed on the playbook's cooldown forever, so the
// operator heard "Self-healed: cortex restart after a stall. Trigger: cortex-stall.
// Action taken: restart-cortex." four times in sixteen minutes — every one of them
// an unprompted spoken turn in the middle of a Live conversation, and the whole of
// what they described as it "rambling on by itself".
//
// A documented-but-unapplied cooldown is worse than none: it tells the next reader
// the case is handled. It is applied now, keyed kind+target+playbook so two
// different faults healing at once are still two announcements.
const DEFAULT_REANNOUNCE_MS = 10 * 60 * 1000; // re-speak the same standing issue at most once per 10 min

function createAnnouncer({ bus, config, speak }) {
  if (!bus) throw new Error('createAnnouncer requires bus');
  if (typeof speak !== 'function') throw new Error('createAnnouncer requires speak(text)');

  const REANNOUNCE_MS = (config && config.ANNOUNCER_REANNOUNCE_MS) || DEFAULT_REANNOUNCE_MS;
  const spoken = new Map(); // `${kind}:${target}:${playbookId}` -> lastSpokenTs

  async function say(text) {
    try {
      await speak(text);
    } catch (_) {
      // announcer must never break the entity
    }
  }

  // BUG-162: "Self-healed: recurring-failure-record." was the whole sentence —
  // a playbook ID and nothing else, and when the operator asked what it fixed
  // (incident 2026-08-07 04:27) nothing could answer. Interpolate ONLY fields
  // actually present on the event (the AD-5/BUG-123 rule: no brain call, no
  // invented causes) and say plainly when detail was not recorded.
  function onHealed(event) {
    const h = event.payload;
    if (h.outcome !== 'applied') return;
    const what = h.title || h.playbookId;
    let line = 'Self-healed: ' + what + '.';
    const cause = [h.kind, h.target].filter(Boolean).join(' on ');
    if (cause) line += ' Trigger: ' + cause + '.';
    if (Array.isArray(h.actions) && h.actions.length) {
      line += ' Action taken: ' + h.actions.join(', ') + '.';
    } else if (!h.title && !cause) {
      line += ' Details were not recorded.';
    }
    // BUG-273: hold a REPEAT of the same fault healing the same way. Q2 — this
    // governs speech only. immune/anomaly-detail.js writes the vault row from the
    // same event on a separate path, which is what triage-incidents.js reads and
    // what made this bug diagnosable after the fact.
    const dedupKey = [h.kind || '', h.target || '', h.playbookId || ''].join(':');
    const now = Date.now();
    const last = spoken.get(dedupKey);
    // No `REANNOUNCE_MS > 0` clause: the constant is read through a `|| DEFAULT`,
    // so it can never be 0 here and such a guard would be a branch that cannot run.
    if (last !== undefined && (now - last) < REANNOUNCE_MS) return;
    spoken.set(dedupKey, now);
    say(line);
  }

  function onRecovered() {
    say('Recovered from restart. Resuming.');
  }

  const unsubscribers = [];

  function start() {
    // W6: health.diagnosed subscription removed — conversation/announcer is the
    // single speaker for diagnoses. Breaker/heal lifecycle speech stays here.
    unsubscribers.push(bus.subscribe('health.healed', onHealed));
    unsubscribers.push(bus.subscribe('lifecycle.recovered', onRecovered));
  }

  function stop() {
    while (unsubscribers.length) { unsubscribers.pop()(); }
  }

  return { start: start, stop: stop };
}

module.exports = { createAnnouncer: createAnnouncer };
