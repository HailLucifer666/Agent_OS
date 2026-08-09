'use strict';

// immune/explainer.js — self-error explanation (P6 Jarvis upgrade).
//
// The healer's no-match path used to do nothing: a diagnosed anomaly with no
// playbook was logged and forgotten, and the operator heard silence while
// something was visibly broken. This module subscribes to the same
// 'health.healed' events the healer already emits and, on outcome:'no-match'
// (once per kind:target per 10 minutes), speaks a description of the condition
// plus ONE remedy chosen by the brain from a fixed safe menu:
//   suppress_tool  — same map/TTL the 'suppress-tool' playbook action uses
//   probe_provider — a forced registry re-probe (same as 'probe-provider')
//   none           — needs a human; explain only
// Never code edits, never new action types. The line is spoken through the
// existing 'action.speak-requested' → proactiveSpeak path.
// Disable with IMMUNE_EXPLAIN=false.
//
// AD-5, 2026-08-10 — THE SPOKEN PROSE IS NOT GENERATED. It used to be: this
// module asked brain.think for "one or two short spoken sentences: what is
// failing and the likely cause" and spoke the answer. A model handed a bare
// anomaly kind and asked for a cause invents one. On 2026-08-10 the operator
// heard "Something is misfiring when I'm supposedly idle, maybe a tool spinning
// its wheels and triggering a limit" for a `live-idle-exhausted` event — a quiet
// Live session closing itself on purpose. No tool was spinning; there was not
// one rate-limit line in that day's Audit or Episodic log. The existing guard
// ("do not name any tool, provider or subsystem that is not stated above")
// stopped it naming a component and did nothing about it inventing a MECHANISM.
//
// conversation/announcer.js hit exactly this in BUG-123 and was converted to
// deterministic templates on 2026-08-05; this module was missed. It now reuses
// that module's describeCondition()/honestCauseClause() verbatim rather than
// re-implementing the wording. The brain call stays, but ONLY to pick the remedy
// from the three-item menu — a structured choice out of a fixed set cannot
// fabricate a cause.

var healerLib = require('./healer');
var announcerLib = require('../conversation/announcer');

var EXPLAIN_COOLDOWN_MS = 10 * 60 * 1000;
var SUPPRESS_TTL_MS = 60 * 1000;

function createExplainer({ bus, brain, memory, config, logger }) {
  if (!bus) throw new Error('createExplainer requires bus');
  if (!brain) throw new Error('createExplainer requires brain');
  var log = logger || { info: function() {}, warn: function() {} };
  var enabled = String((config && config.IMMUNE_EXPLAIN) || process.env.IMMUNE_EXPLAIN || 'true') !== 'false';
  var lastExplained = {}; // "kind:target" -> ts
  var unsubscribe = null;

  async function explain(payload) {
    var kind = payload.kind || 'anomaly';
    var target = payload.target === undefined || payload.target === null ? '' : String(payload.target);

    // Recent related failures from episodic memory — grounds the explanation
    // in what actually happened rather than the anomaly name alone.
    var recentLines = [];
    try {
      var hits = memory && memory.episodic ? (memory.episodic.recall(target || kind, { limit: 5 }) || []) : [];
      recentLines = hits.map(function(h) {
        return (h.record && h.record.summary) || h.snippet || '';
      }).filter(Boolean);
    } catch (_) {}

    // The condition sentence is BUILT, not generated — see the AD-5 note in the
    // module header. Only fields actually present on the payload are used, and
    // when there is no reason the sentence says so out loud rather than leaving
    // a gap the listener fills in themselves.
    var explanation = 'One of my internal checks has no automatic fix: '
      + announcerLib.describeCondition(payload) + '.'
      + announcerLib.honestCauseClause(payload);

    // The brain is asked for the remedy ONLY. No prose, no cause, no narration.
    // A choice from three fixed values is not a fabrication risk; a sentence is.
    var result = await brain.think({
      lane: 'simple',
      messages: [{
        role: 'user',
        content: [
          'One of your internal anomalies has no automatic fix. Pick the remedy, nothing else.',
          'Anomaly kind: ' + kind,
          'Target: ' + (target || '(none)'),
          'Detail: ' + JSON.stringify(payload.detail || {}).slice(0, 400),
          recentLines.length ? 'Recent related activity:\n' + recentLines.join('\n') : '',
          '',
          'Respond with ONE JSON object, nothing else:',
          '{"remedy": "suppress_tool" | "probe_provider" | "none"}',
          'Choose suppress_tool ONLY if the target is a failing tool that should rest for a minute.',
          'Choose probe_provider ONLY if an AI provider seems down. Otherwise choose none.',
          'Do not include any other field. Do not explain your choice.'
        ].filter(Boolean).join('\n')
      }],
      source: 'immune-explain'
    });
    // A dead or offline brain no longer costs the operator the alert: the
    // condition sentence exists without it, so fall through with remedy 'none'
    // instead of returning null and saying nothing at all.
    var remedy = (result && !result.offline && result.parsed) ? result.parsed.remedy : 'none';

    var remedyNote = '';
    if (remedy === 'suppress_tool' && target && /^[a-z][a-z0-9_-]*$/i.test(target)) {
      healerLib.suppressTool(target, SUPPRESS_TTL_MS);
      remedyNote = " I've suppressed " + target + ' for a minute.';
    } else if (remedy === 'probe_provider') {
      try {
        require('../brain/registry').refresh(true);
        remedyNote = " I'm re-probing the AI providers now.";
      } catch (_) {}
    } else {
      remedyNote = ' This one needs your attention.';
    }

    return { explanation: explanation, remedy: remedy || 'none', spoken: explanation + remedyNote };
  }

  async function onHealed(event) {
    var p = event && event.payload;
    if (!enabled || !p || p.outcome !== 'no-match') return;
    var key = (p.kind || '') + ':' + (p.target || '');
    var now = Date.now();
    if (now - (lastExplained[key] || 0) < EXPLAIN_COOLDOWN_MS) return;
    lastExplained[key] = now;
    try {
      var out = await explain(p);
      if (!out) return;
      log.info('immune-explain', { kind: p.kind, target: p.target, remedy: out.remedy });
      bus.emit('action.speak-requested', { text: out.spoken });
    } catch (err) {
      log.warn('immune-explain.failed', { error: err.message });
    }
  }

  return {
    start() { unsubscribe = bus.subscribe('health.healed', onHealed); },
    stop() { if (unsubscribe) { unsubscribe(); unsubscribe = null; } },
    // exposed for tests
    _onHealed: onHealed
  };
}

module.exports = { createExplainer };
