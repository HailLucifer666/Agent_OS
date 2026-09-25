'use strict';

// immune/aether-rebind.js — the `retry-aether-proxy` healer action, with a
// terminal condition.
//
// BUG-379 (2026-08-27). WHY THIS IS A MODULE
//
// It lived inside healer.js's buildActions() and the file-size ratchet refused
// the commit: `mythos/src/core/immune/healer.js: 876 -> 945`. healer.js is
// already an 876-line monolith and the ratchet's message says the baseline is a
// ceiling, not a suggestion. Extracting the one action that grew a state machine
// is the smallest honest answer, and it makes the retry budget testable without
// standing up a whole healer.
//
// WHAT THE TERMINAL CONDITION IS FOR — measured, not assumed
//
// The work order said "a healer playbook retried an unbindable port every few
// minutes for hours". It did not. Ran its own oracle first (a real orphaned
// listener, real bus, real diagnostician, real healer, 38 seconds against a 15s
// cooldown):
//
//   health.anomaly emissions        : 1
//   health.diagnosed emissions      : 1
//   healer audit rows for this kind : 1  (aether-proxy-rebind, error)
//
// One attempt. No loop. The anomaly is emitted from a promise rejection handler
// in main.js which runs once per process, and this action catches its own bind
// error without re-emitting, so within one process it cannot repeat. The 65
// records of 2026-08-08/09 were 65 PROCESSES, and 63 of them predate this
// playbook existing at all (added 2026-08-13, Wave 7) — their healer outcome was
// `no-match`, not a retry.
//
// So the cap is a GUARD, not a fix for an observed loop, and it is worth having
// because the healer's own design assumes anomalies repeat: probes re-emit
// health.anomaly every 4s and healer.js's cooldown is the dedup (recorded in the
// immune announcer before BUG-447 deleted it, 2026-09-23). This playbook declares no verifyMs, so it never
// creates a pendingVerifications entry, never trips the recurrence detector and
// can never emit heal-failed — meaning if any future source did start repeating
// this kind, it would retry every 15 seconds forever with nothing recording that
// the retries were futile.

// Three, then OFFLINE. A stale MYTHOS releasing its ports exits in well under a
// second (scanner-proxy.js's own start()/stop() comments say a same-port retry
// after a short cooldown is the sanctioned recovery), so three attempts across
// three 15s cooldowns is ~45 seconds of patience — long enough for that, short
// enough that a genuinely-held port stops being retried the same minute.
const MAX_ATTEMPTS = 3;

function createAetherRebindAction(deps) {
  const d = deps || {};
  const getScannerProxy = d.getScannerProxy;
  const maxAttempts = typeof d.maxAttempts === 'number' ? d.maxAttempts : MAX_ATTEMPTS;

  // Per-instance, NOT module-level, on purpose: module state would be shared
  // between two healers in one process (the suite builds many) and a budget
  // exhausted by one test would silently disable the action for the next.
  let attempts = 0;
  let holderText = null;

  return async function retryAetherProxy(diagnosis) {
    const proxy = getScannerProxy && getScannerProxy();
    if (!proxy) return { ok: false, reason: 'missing-dependency:scanner-proxy' };

    // THE HOLDER IS READ, NEVER RE-LOOKED-UP HERE. main.js's bind-failure
    // handler already resolved it once and put it on the anomaly, and the
    // diagnostician carries the whole anomaly through as `evidence`
    // (diagnostician.js:66), so it is sitting right here.
    //
    // The first draft of this action called findPortHolder() itself. That
    // spawned netstat on the heal path — up to two child processes per retry —
    // and it broke an existing test (aether-proxy-rebind-playbook.test.js,
    // "a retry that fails again ... reports outcome:error") whose 10ms window
    // the added latency raced past. The failing test was right: a remediation
    // path is the wrong place to start doing detective work.
    const evidence = (diagnosis && diagnosis.evidence) || {};
    if (typeof evidence.holder === 'string' && evidence.holder.trim()) {
      holderText = evidence.holder.trim();
    }

    if (attempts >= maxAttempts) {
      return {
        ok: false,
        terminal: true,
        reason: 'aether-proxy-offline-after-retries',
        detail: 'Gave up rebinding the Aether scanner-proxy after ' + maxAttempts
          + ' attempts. ' + (holderText || 'The port is held by another process.')
          + ' The proxy stays OFFLINE until whatever holds the port exits; nothing '
          + 'will retry it again this session.',
      };
    }

    attempts += 1;
    try {
      proxy.start();
      await proxy.whenReady();
      attempts = 0;          // a real recovery restores the full budget
      holderText = null;
      return {
        ok: true,
        result: { ports: typeof proxy.ports === 'function' ? proxy.ports() : null },
      };
    } catch (err) {
      // Name the squatter here too, not only at boot: this is the surface an
      // operator reads once the first message has scrolled away, and
      // "bind-failed-again" alone was the least actionable string in the vault.
      return {
        ok: false,
        reason: 'bind-failed-again',
        detail: ((err && err.message) || 'bind failed')
          + (holderText ? ' — ' + holderText : ''),
        attempt: attempts,
        attemptsRemaining: Math.max(0, maxAttempts - attempts),
      };
    }
  };
}

module.exports = { createAetherRebindAction, MAX_ATTEMPTS };
