'use strict';

// conversation/announcer.js — proactive speech for important lifecycle events.
//
// The immune system's announcer speaks on health anomalies; THIS module speaks
// on build completions, goal completions, and other events the operator cares
// about. It bridges the gap where a build finishes, the cortex perceives it,
// but nobody tells the user — the "is it done?" problem.
//
// Pattern mirrors immune/announcer.js: subscribe to bus events, generate a
// natural sentence via brain.think (not a canned string), deliver via the
// injected speak() callback (server/index.js's proactiveSpeak). Per-event-key
// deduplication prevents announcing the same event twice.

// BUG-123 (AD-5) helpers, at module scope since 2026-08-10 so immune/explainer.js
// can share them. They were factory-local when only onHealthAnomaly/
// onHealthDiagnosed below used them; the explainer needed the identical
// no-invented-cause wording and re-implementing it is how the two drift apart.
// Both are pure — no closure state — so hoisting them changes nothing here.
function describeCondition(p) {
  var what = p.kind || p.syndrome || null;
  var where = p.target && p.target !== what ? ' in ' + String(p.target) : '';
  return (what ? String(what) : 'an unnamed condition') + where;
}

function honestCauseClause(p) {
  if (!p.reason) return ' I do not yet know the cause.';
  return ' Reported reason: ' + String(p.reason) + '.';
}

function createConversationAnnouncer({ bus, brain, config, speak }) {
  if (!bus) throw new Error('createConversationAnnouncer requires bus');
  if (!brain || typeof brain.think !== 'function') throw new Error('createConversationAnnouncer requires brain');
  if (typeof speak !== 'function') throw new Error('createConversationAnnouncer requires speak');

  // DRYRUN guard — same env var as the leash. When set, announcements are
  // generated but NOT spoken (the brain call still fires for observability).
  var DRYRUN = Boolean(process.env.MYTHOS_DRY_RUN);

  // Dedup map: event-key -> last-announced timestamp. Prevents re-announcing
  // the same job/goal if the perception fires multiple times.
  var DEDUP_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
  var announced = new Map();

  function isRecent(key) {
    var ts = announced.get(key);
    if (!ts) return false;
    return Date.now() - ts < DEDUP_WINDOW_MS;
  }

  function markAnnounced(key) {
    announced.set(key, Date.now());
    // Prevent unbounded growth — sweep old entries every 100 announcements
    if (announced.size > 200) {
      var now = Date.now();
      for (var [k, ts] of announced) {
        if (now - ts > DEDUP_WINDOW_MS) announced.delete(k);
      }
    }
  }

  // Generate a natural announcement via brain.think. Falls back to a canned
  // string if the brain is offline — never silent.
  async function generate(template, fallbackText) {
    try {
      var result = await brain.think({
        lane: 'voice',
        messages: [{ role: 'user', content: template }],
        source: 'conversation-announcer'
      });
      if (result && !result.offline && result.content) {
        var text = result.content.trim();
        // Strip JSON if the model returned it in JSON format
        if (text.startsWith('{')) {
          try {
            var parsed = JSON.parse(text);
            if (parsed.say) text = parsed.say;
          } catch (_) { /* use raw content */ }
        }
        return text.slice(0, 300);
      }
    } catch (_) { /* brain offline — use fallback */ }
    return fallbackText;
  }

  // ---- Event handlers ----

  // Build job completion → "your X is done, want me to open it?" OR "Build completed but review found issues..."
  function onJobPerception(event) {
    var p = event.payload;
    if (!p || p.status !== 'done') return;

    var key = 'job:' + (p.jobId || 'unknown');
    if (isRecent(key)) return;

    // Extract artifact name from the perception if available
    var artifactName = 'your build';
    var artifactPath = p.artifact || (p.detail && p.detail.artifact);
    if (artifactPath) {
      var parts = String(artifactPath).split(/[/\\]/);
      artifactName = parts[parts.length - 1] || 'your build';
    }

    // BUG-016: Check if the review failed — if so, announce issues instead of success
    if (p.reviewVerdict === 'reject' && Array.isArray(p.reviewIssues) && p.reviewIssues.length > 0) {
      var issueList = p.reviewIssues.slice(0, 3).join('; '); // Limit to first 3 issues
      generate(
        'A build job completed but the review found issues that need fixing. ' +
        'Artifact: ' + artifactName + '. Issues: ' + issueList +
        '. Say one natural sentence informing the operator that the build has issues needing attention. ' +
        'Do not say "finished" or "done" — say something like "completed but needs your attention" or "found some issues". ' +
        'Be helpful, not robotic.',
        artifactName + ' completed but review found issues that need attention.'
      ).then(function(text) {
        if (!DRYRUN) speak(text);
        bus.emit('conversation.announced', { key: key, text: text, kind: 'job-done-with-issues' });
      });
    } else {
      // Build passed review or didn't require review — announce as success
      generate(
        'A build job just completed. The artifact is: ' + artifactName +
        '. Say one natural, warm sentence to tell the operator it is done. ' +
        'After stating what finished, optionally add ONE short offer for the most obvious next step ' +
        '(e.g. "Want me to open it?" or "Shall I have the reviewer check it?"). Skip the offer if nothing obvious follows. ' +
        'Never more than one offer. Do not be robotic. Speak plainly.',
        'Your ' + artifactName + ' is ready. Want me to open it?'
      ).then(function(text) {
        if (!DRYRUN) speak(text);
        bus.emit('conversation.announced', { key: key, text: text, kind: 'job-done' });
      });
    }
    markAnnounced(key);
  }

  // Goal completion → "I've finished X"
  function onGoalUpdate(event) {
    var p = event.payload;
    if (!p || p.status !== 'done') return;

    var key = 'goal:' + (p.id || 'unknown');
    if (isRecent(key)) return;

    var title = p.title || 'a goal';
    generate(
      'You just completed a goal: ' + title +
      '. Say one natural sentence acknowledging the completion. Be warm but not over the top.',
      'Done — ' + title + ' is complete.'
    ).then(function(text) {
      if (!DRYRUN) speak(text);
      bus.emit('conversation.announced', { key: key, text: text, kind: 'goal-done' });
    });
    markAnnounced(key);
  }

  // Critical health anomalies → "I've hit a problem with X"
  //
  // CONTRACT NOTE: no health.anomaly emitter sets `severity` on the payload —
  // only identity-boundaries-malformed does. So gating on p.severity === 'critical'
  // silently dropped EVERY anomaly (provider-down, cortex-stall, effector-flapping,
  // memory-growth). Now we announce when EITHER severity is critical OR the kind
  // matches a known-serious condition. Conservative — better to occasionally
  // announce than to silently miss a problem the operator needs to hear.
  var SERIOUS_KINDS = {
    'provider-down': true, 'provider-unhealthy': true,
    'cortex-stalled': true, 'tick-error': true,
    'effector-flapping': true, 'memory-growth': true,
    'identity-boundaries-malformed': true
  };

  function isSerious(p) {
    if (p.severity === 'critical') return true;
    if (p.kind && SERIOUS_KINDS[p.kind]) return true;
    return false;
  }

  // BUG-123 (AD-5) — 2026-08-05: these two handlers used to hand a free-text
  // prompt to brain.think and speak whatever came back. Asked to narrate a bare
  // anomaly kind "naturally", a model fills the gap with a plausible cause the
  // payload never contained, and the operator hears an invented explanation for
  // a real fault in their own machine. Nowhere else does MYTHOS get to state a
  // cause it has no evidence for.
  //
  // So this event class gets a deterministic template instead: only fields that
  // are actually present are interpolated, and when there is no reason on the
  // payload the sentence says so out loud rather than leaving a silence the
  // listener will fill in. The wording is plainer than a generated line — that
  // is the trade, and for "something is wrong with your system" it is the right
  // way round. onJobPerception/onGoalUpdate keep generate(): a build finishing
  // has no cause to invent.
  // describeCondition / honestCauseClause now live at module scope — see the
  // note above createConversationAnnouncer.

  function onHealthAnomaly(event) {
    var p = event.payload;
    if (!p) return;
    if (!isSerious(p)) return;

    var key = 'anomaly:' + (p.kind || 'unknown') + ':' + Date.now();
    if (isRecent(p.kind)) return; // dedup by kind, not by timestamp

    var text = ('Heads up — I have hit a problem: ' + describeCondition(p) + '.' +
      honestCauseClause(p)).slice(0, 300);
    if (!DRYRUN) speak(text);
    bus.emit('conversation.announced', { key: key, text: text, kind: 'anomaly' });
    markAnnounced(p.kind);
  }

  // health.diagnosed carries severity from the diagnostician (anomaly → diagnose
  // → diagnose.pipeline). This is the reliable severity path — subscribe here
  // too so critical diagnoses are announced even if the raw anomaly kind isn't
  // in SERIOUS_KINDS above.
  function onHealthDiagnosed(event) {
    var p = event.payload;
    if (!p || p.severity !== 'critical') return;
    var key = 'diagnosed:' + (p.kind || p.syndrome || 'unknown') + ':' + Date.now();
    var dedupKey = 'diag:' + (p.kind || p.syndrome || 'unknown');
    if (isRecent(dedupKey)) return;
    // BUG-123: same deterministic treatment as onHealthAnomaly above. A
    // diagnosis carries a `reason` more often than a raw anomaly does, which
    // makes it MORE tempting for a model to embellish, not less.
    var text = ('I have identified a problem: ' + describeCondition(p) + '.' +
      honestCauseClause(p)).slice(0, 300);
    if (!DRYRUN) speak(text);
    bus.emit('conversation.announced', { key: key, text: text, kind: 'diagnosed' });
    markAnnounced(dedupKey);
  }

  var unsubscribers = [];

  function start() {
    unsubscribers.push(bus.subscribe('perception.job', onJobPerception));
    unsubscribers.push(bus.subscribe('goal.*', onGoalUpdate));
    unsubscribers.push(bus.subscribe('health.anomaly', onHealthAnomaly));
    unsubscribers.push(bus.subscribe('health.diagnosed', onHealthDiagnosed));
  }

  function stop() {
    for (var i = 0; i < unsubscribers.length; i++) {
      if (typeof unsubscribers[i] === 'function') unsubscribers[i]();
    }
    unsubscribers = [];
  }

  // isRecent/markAnnounced exposed for external callers (BUG-112): the boot
  // greeting and the daily planner's morning brief are both greeting-shaped
  // proactive speech that live outside this module's own bus subscriptions —
  // without a shared dedup namespace they could each speak independently
  // within seconds of each other. Sharing THIS module's dedup map (rather
  // than each caller inventing its own Map/timestamp) means one dedup
  // window covers every greeting-shaped source.
  return { start: start, stop: stop, isRecent: isRecent, markAnnounced: markAnnounced };
}

module.exports = {
  createConversationAnnouncer: createConversationAnnouncer,
  // AD-5 wording, shared with immune/explainer.js — see the note above the factory.
  describeCondition: describeCondition,
  honestCauseClause: honestCauseClause,
};
