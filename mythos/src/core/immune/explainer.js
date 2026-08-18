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

// BUG-273 C2 (second half) — WHICH TARGETS A PROVIDER RE-PROBE CAN POSSIBLY HELP.
//
// LIVE, 2026-08-18T18:15:48Z, three seconds after boot, in the operator's own
// session: a `gmail-reauth-required` anomaly — a REVOKED GOOGLE OAUTH TOKEN — was
// handed to the brain to choose a remedy, and it chose `probe_provider`. So MYTHOS
// refreshed the AI provider registry and told the operator "I'm re-probing the AI
// providers now". Nothing about re-probing Gemini or Mistral can re-mint a Google
// refresh token, so the operator heard remediation in progress and Gmail went on
// failing — which is exactly how it was reported.
//
// The prose in the prompt below ALREADY said "Choose probe_provider ONLY if an AI
// provider seems down", and the model picked it for a mail account anyway. A
// model's answer is untrusted input: the control has to be here, in code, not in
// the request. Rejected at the edge rather than sanitised downstream.
//
// Deliberately a small, explicit list rather than "ask the registry": the registry
// is exactly the subsystem this remedy perturbs, so consulting it to decide whether
// to perturb it invites the failure mode where a broken registry can no longer
// refuse a refresh. Names are the lanes and the brain itself, which is all the
// remedy has ever been able to act on.
var PROBEABLE_TARGETS = ['brain', 'provider', 'providers', 'llm', 'lane',
  'voice', 'simple', 'vision', 'coding', 'reasoning'];
function canProbeProvider(target) {
  var t = String(target || '').trim().toLowerCase();
  if (!t) return false;
  return PROBEABLE_TARGETS.indexOf(t) !== -1;
}

var EXPLAIN_COOLDOWN_MS = 10 * 60 * 1000;
var SUPPRESS_TTL_MS = 60 * 1000;
// F8: see the call site. The bound exists because episodic recall is a
// synchronous full-scan on the thread serving the live voice socket.
var EXPLAIN_RECALL_WINDOW_DAYS = 1;

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
    // F8 (2026-08-15) — THIS CALL WAS THE LAG.
    //
    // It inherited recall()'s default windowDays of 7, and recall() is
    // synchronous: readDirLines() does a readFileSync + JSON.parse of every line
    // across every day in the window, on the same thread that services the live
    // WebSocket. This vault holds 12,294 episodic entries across 29 files. The
    // 2026-08-14 session recorded loop.stalled twice (1405ms and 312ms against a
    // 250ms threshold), and this is what it was doing.
    //
    // It is causally downstream of the missing playbooks: the explainer only runs
    // on the no-match path, and 26 anomalies matched nothing that day. Stage 7's
    // other half (playbooks for those kinds) reduces how OFTEN this runs; this
    // bounds what it costs when it does. Both are needed — a rare freeze is still
    // a freeze.
    //
    // One day, not seven. An explanation for an anomaly that just fired is
    // grounded by what happened around it, not by last Tuesday; and the scan is
    // ranked by relevance afterwards, so a wider window mostly buys unread lines.
    // fs-store.js:186-189 already documents this exact class of freeze for the
    // audit reader — the episodic reader was its unfixed twin.
    var recentLines = [];
    try {
      var hits = memory && memory.episodic
        ? (memory.episodic.recall(target || kind, { limit: 5, windowDays: EXPLAIN_RECALL_WINDOW_DAYS }) || [])
        : [];
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

    // BUG-273 C2: an anomaly that has ALREADY named the only thing that fixes it does
    // not get a remedy guessed for it. `needsOperator` is set by the sensor that knows
    // the fault is terminal — a revoked OAuth grant is the first — and every mechanical
    // remedy in the menu below is, for such a fault, a wrong answer that also sounds
    // like a right one. Skipping the call is cheaper AND more honest than filtering its
    // result afterwards.
    if (payload.needsOperator === true) {
      return { explanation: explanation, remedy: 'none',
        spoken: explanation + ' This one needs your attention.' };
    }

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
    } else if (remedy === 'probe_provider' && canProbeProvider(target)) {
      try {
        require('../brain/registry').refresh(true);
        remedyNote = " I'm re-probing the AI providers now.";
      } catch (_) {}
    } else {
      // BUG-273 C2: a refused remedy is LOGGED, never silently downgraded. A guard
      // that quietly swallows the answer makes the next "why did nothing happen?"
      // investigation start from zero — and this one fired in production on its
      // first day, so it will fire again.
      if (remedy === 'probe_provider') {
        log.info('immune-explain.remedy-refused', { remedy: remedy, target: target,
          reason: 'not an AI provider — a re-probe cannot affect this target' });
        remedy = 'none';
      }
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
      // internalDiagnostic marks this as "an internal check with no automatic
      // fix" — true of everything this module explains, by construction (it only
      // subscribes to health.healed with outcome 'no-match'). server/index.js's
      // action.speak-requested subscriber uses it to hold the spoken form back
      // while a Live conversation is in progress; the anomaly still reaches the
      // log, the audit and the HUD. Added after five of these interrupted a live
      // exchange on 2026-08-10. `kind` rides along so the drop is diagnosable.
      bus.emit('action.speak-requested', {
        text: out.spoken,
        kind: p.kind || null,
        internalDiagnostic: true,
      });
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
