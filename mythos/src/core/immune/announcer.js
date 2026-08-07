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
// cooldown depends on anomalies flowing freely). The dedup map below is retained for
// any future health-channel subscription this module re-acquires; today no subscriber
// uses it but the cooldown precedent stays documented. No schema.js key for this (same
// precedent as breakers.js's maxResetMs) — config override exists solely so tests
// don't have to wait out a real 10-minute window.
const DEFAULT_REANNOUNCE_MS = 10 * 60 * 1000; // re-speak the same standing issue at most once per 10 min

function createAnnouncer({ bus, config, speak }) {
  if (!bus) throw new Error('createAnnouncer requires bus');
  if (typeof speak !== 'function') throw new Error('createAnnouncer requires speak(text)');

  const REANNOUNCE_MS = (config && config.ANNOUNCER_REANNOUNCE_MS) || DEFAULT_REANNOUNCE_MS;
  const spoken = new Map(); // `${kind}:${target}` -> lastSpokenTs (retained for future health-channel subs)

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
