'use strict';

// sensors/metric.js — probes + quota poll every 4s. Emits 'perception.metric' (exact
// string, do not paraphrase) so cortex can eventually reason about degraded infra.
// The health-channel side of low-quota/provider-down (the side the Healer acts on)
// is emitted separately, inside immune/probes.js itself — this sensor only feeds the
// cognitive OODA loop's perception queue, per §12's role split.
//
// Mirrors sensors/timer.js's REAL shape (start() takes no `emit` argument, closures
// over an injected bus instead) rather than §12's abstract "start(emit)" comment —
// see Spec Ambiguities Resolved #17.

function createMetricSensor({ bus, config, probes }) {
  if (!bus) throw new Error('createMetricSensor requires bus');
  if (!probes || typeof probes.getStatus !== 'function') throw new Error('createMetricSensor requires probes');

  let timer = null;

  function poll() {
    return probes.getStatus().then(function(status) {
      const lowQuota = status.quotas.some(function(q) {
        return !q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10;
      });
      // 'perception.metric' — exact string, do not paraphrase. Field name is
      // `salience` (matching the REAL consumer, cortex/ooda.js:14), not the doc's
      // `salienceHint` — see Spec Ambiguities Resolved #14.
      bus.emit('perception.metric', {
        summary: 'infra metrics poll',
        channel: 'metric',
        kind: 'metric',
        salience: lowQuota ? 0.9 : 0.2,
        status: status
      });
    }).catch(function() { /* honest-inert: a failed poll is not a crash */ });
  }

  function start() {
    timer = setInterval(poll, 4000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop, _internal: { poll: poll } };
}

module.exports = { createMetricSensor: createMetricSensor };
