'use strict';

// immune/announcer.js — RW of NOVA app/lib/voice/checkpoint-announcer.js. Speaks
// significant immune-system events (health diagnoses at major/critical severity,
// successful heals, post-crash recovery).
//
// `speak` is required at construction — never a silent no-op (this is the one place
// in Phase 6 where a missing dependency is NOT tolerated at call time, because the
// alternative is a silently-swallowed announcement with no trace anywhere). Until
// Phase 7 ships a real voice effector, main.js wires `speak` to re-emit onto the
// 'action' channel so nothing is lost — see Spec Ambiguities Resolved.

const SEVERITY_TO_ANNOUNCE = ['critical', 'major'];

// BUG-030: probes.js re-emits 'health.anomaly' every 4s (no dedup by design — healer.js's
// cooldown depends on anomalies flowing freely) so a standing condition (e.g.
// provider-down) reaches this announcer repeatedly. probes.js/diagnostician.js stay
// untouched; the cooldown belongs here, at the speech point, keyed by kind+target.
// No schema.js key for this (same precedent as breakers.js's maxResetMs) — config
// override exists solely so tests don't have to wait out a real 10-minute window.
const DEFAULT_REANNOUNCE_MS = 10 * 60 * 1000; // re-speak the same standing issue at most once per 10 min

function createAnnouncer({ bus, config, speak }) {
  if (!bus) throw new Error('createAnnouncer requires bus');
  if (typeof speak !== 'function') throw new Error('createAnnouncer requires speak(text)');

  const REANNOUNCE_MS = (config && config.ANNOUNCER_REANNOUNCE_MS) || DEFAULT_REANNOUNCE_MS;
  const spoken = new Map(); // `${kind}:${target}` -> lastSpokenTs

  async function say(text) {
    try {
      await speak(text);
    } catch (_) {
      // announcer must never break the entity
    }
  }

  function onDiagnosed(event) {
    const d = event.payload;
    if (SEVERITY_TO_ANNOUNCE.indexOf(d.severity) === -1) return;
    const key = d.kind + ':' + (d.target || '');
    const now = Date.now();
    const last = spoken.get(key);
    if (last && now - last < REANNOUNCE_MS) return; // already said this recently — skip
    spoken.set(key, now);
    say('Health alert: ' + d.kind + (d.target ? ' on ' + d.target : '') + '.');
  }

  function onHealed(event) {
    const h = event.payload;
    if (h.outcome !== 'applied') return;
    say('Self-healed: ' + h.playbookId + '.');
  }

  function onRecovered() {
    say('Recovered from restart. Resuming.');
  }

  const unsubscribers = [];

  function start() {
    unsubscribers.push(bus.subscribe('health.diagnosed', onDiagnosed));
    unsubscribers.push(bus.subscribe('health.healed', onHealed));
    unsubscribers.push(bus.subscribe('lifecycle.recovered', onRecovered));
  }

  function stop() {
    while (unsubscribers.length) { unsubscribers.pop()(); }
  }

  return { start: start, stop: stop };
}

module.exports = { createAnnouncer: createAnnouncer };
