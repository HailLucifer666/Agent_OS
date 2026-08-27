'use strict';

// aether/bind-failure.js — build the `aether-proxy-bind-failed` anomaly payload.
//
// BUG-379 (2026-08-27). WHY THIS IS A MODULE AND NOT SIX LINES IN main.js
//
// It started as six lines in main.js and the file-size ratchet refused the
// commit: `mythos/src/main.js: 1373 -> 1406`, with the ratchet's own message
// saying the baseline is a ceiling and the new code belongs somewhere else. That
// was the right call twice over — main.js is a 1373-line boot monolith, and a
// payload builder with three failure modes of its own is exactly the thing that
// should be callable from a test without booting an application.
//
// WHAT WAS WRONG WITH THE OLD PAYLOAD, measured in the operator's vault
//
// 65 `aether-proxy-bind-failed` records between 2026-08-08 and 2026-08-09, each
// one saying "address already in use" three times and naming the holder zero
// times. Two separate defects produced that:
//
//   1. Nothing ever looked up which process held the port — the single fact that
//      would have ended the episode, for a failure that is BY DEFINITION about
//      another process.
//   2. `target` could never name the port either. scanner-proxy's ports()
//      returns an OBJECT ({phone: 4480}), and main.js tested `failedPorts.length`
//      — undefined on an object, so the branch that names the port was
//      unreachable, and `failedPorts.join()` inside it would have THROWN in an
//      error handler if it ever had run. That is why every record in the vault,
//      including aud-4fb4a38232c3, reads "the Aether proxy port range".

const { findPortHolder, describeHolder, portFromBindError } = require('../util/port-holder');

// Deliberately async, and deliberately non-fatal. This runs inside a promise
// rejection handler during boot: a diagnostic that hangs or throws there is
// strictly worse than no diagnostic, so the holder lookup's own failure becomes
// part of the sentence rather than an exception.
async function buildBindFailureAnomaly(opts) {
  const o = opts || {};
  const err = o.err;
  const message = (err && err.message) || String(err || 'unknown bind failure');
  const lookup = o.findPortHolder || findPortHolder;

  // ports() first if it has anything, then the error text, then the configured
  // base — and say which port we settled on, so "the port range" is only ever
  // used when we genuinely could not narrow it.
  const declared = Array.isArray(o.ports) ? o.ports.filter((p) => Number.isInteger(p)) : [];
  const port = portFromBindError(message) || declared[0] || o.portBase || null;

  let holder = 'could not determine what holds it';
  if (port) {
    try {
      holder = describeHolder(await lookup(port));
    } catch (lookupErr) {
      holder = 'could not determine what holds it: the lookup itself failed ('
        + ((lookupErr && lookupErr.message) || 'unknown error') + ')';
    }
  }

  return {
    kind: 'aether-proxy-bind-failed',
    // `error` stays the raw message, byte for byte. The standing lesson: a failure
    // path that improves the message must not overwrite the evidence.
    error: message,
    // `reason` is what gets SPOKEN — immune/explainer.js builds its sentence
    // from this field (AD-5), so the holder has to be here and not only in a
    // structured field a voice path never reads.
    reason: message + ' — ' + holder,
    // And structured, for the healer: it reads this instead of running its own
    // lookup, so one bind failure costs one netstat rather than one per retry.
    holder: holder,
    target: port ? 'port ' + port : 'the Aether proxy port range',
  };
}

module.exports = { buildBindFailureAnomaly };
