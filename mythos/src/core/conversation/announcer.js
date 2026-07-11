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

  // Build job completion → "your X is done, want me to open it?"
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

    generate(
      'A build job just completed. The artifact is: ' + artifactName +
      '. Say one natural, warm sentence to tell the operator it is done and offer to open it. ' +
      'Do not be robotic. Speak plainly.',
      'Your ' + artifactName + ' is ready. Want me to open it?'
    ).then(function(text) {
      if (!DRYRUN) speak(text);
      bus.emit('conversation.announced', { key: key, text: text, kind: 'job-done' });
    });
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

  function onHealthAnomaly(event) {
    var p = event.payload;
    if (!p) return;
    if (!isSerious(p)) return;

    var key = 'anomaly:' + (p.kind || 'unknown') + ':' + Date.now();
    if (isRecent(p.kind)) return; // dedup by kind, not by timestamp

    generate(
      'A critical problem occurred: ' + (p.kind || 'an anomaly') +
      '. Say one natural sentence informing the operator about the issue. Be calm and direct.',
      'Heads up — I have hit a problem with ' + (p.kind || 'something') + '.'
    ).then(function(text) {
      if (!DRYRUN) speak(text);
      bus.emit('conversation.announced', { key: key, text: text, kind: 'anomaly' });
    });
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
    generate(
      'A critical issue was diagnosed: ' + (p.kind || p.syndrome || 'a system problem') +
      '. Say one natural sentence informing the operator. Be calm and direct.',
      'I have identified a problem with ' + (p.kind || p.syndrome || 'a system') + '.'
    ).then(function(text) {
      if (!DRYRUN) speak(text);
      bus.emit('conversation.announced', { key: key, text: text, kind: 'diagnosed' });
    });
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

  return { start: start, stop: stop };
}

module.exports = { createConversationAnnouncer: createConversationAnnouncer };
