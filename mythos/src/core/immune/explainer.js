'use strict';

// immune/explainer.js — self-error explanation (P6 Jarvis upgrade).
//
// The healer's no-match path used to do nothing: a diagnosed anomaly with no
// playbook was logged and forgotten, and the operator heard silence while
// something was visibly broken. This module subscribes to the same
// 'health.healed' events the healer already emits and, on outcome:'no-match'
// (once per kind:target per 10 minutes), asks the brain for a plain-language
// cause plus ONE remedy chosen from a fixed safe menu:
//   suppress_tool  — same map/TTL the 'suppress-tool' playbook action uses
//   probe_provider — a forced registry re-probe (same as 'probe-provider')
//   none           — needs a human; explain only
// Never code edits, never new action types. The explanation is spoken through
// the existing 'action.speak-requested' → proactiveSpeak path.
// Disable with IMMUNE_EXPLAIN=false.

var healerLib = require('./healer');

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

    var result = await brain.think({
      lane: 'simple',
      messages: [{
        role: 'user',
        content: [
          'One of your internal anomalies has no automatic fix. Explain it to your operator and pick a remedy.',
          'Anomaly kind: ' + kind,
          'Target: ' + (target || '(none)'),
          'Detail: ' + JSON.stringify(payload.detail || {}).slice(0, 400),
          recentLines.length ? 'Recent related activity:\n' + recentLines.join('\n') : '',
          // BUG-105: with no target supplied the model filled the gap with a
          // plausible component ("the music playback tool" for a list_windows
          // anomaly). Naming a subsystem that is not in this prompt is a
          // fabrication, same class as AD-5's synthesized metrics.
          'Do not name any tool, provider or subsystem that is not stated above.'
            + (target ? '' : ' No component was identified, so say "a tool" or "something internal" rather than guessing which one.'),
          '',
          'Respond with ONE JSON object, nothing else:',
          '{"explanation": "one or two short spoken sentences: what is failing and the likely cause, plain language",',
          ' "remedy": "suppress_tool" | "probe_provider" | "none"}',
          'Choose suppress_tool ONLY if the target is a failing tool that should rest for a minute.',
          'Choose probe_provider ONLY if an AI provider seems down. Otherwise choose none.'
        ].filter(Boolean).join('\n')
      }],
      source: 'immune-explain'
    });
    if (!result || result.offline || !result.parsed) return null;

    var explanation = String(result.parsed.explanation || '').trim().slice(0, 300);
    if (!explanation) return null;
    var remedy = result.parsed.remedy;

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
