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

function createAnnouncer({ bus, config, speak }) {
  if (!bus) throw new Error('createAnnouncer requires bus');
  if (typeof speak !== 'function') throw new Error('createAnnouncer requires speak(text)');

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
