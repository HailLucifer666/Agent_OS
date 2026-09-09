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

var completionStatusLib = require('../effectors/completion-status');

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

function createConversationAnnouncer({ bus, brain, config, speak, now }) {
  // Injectable clock (BUG-273 D3). The backoff ladder below spans hours, and a test
  // that cannot move time either sleeps or asserts nothing.
  var clock = typeof now === 'function' ? now : function() { return Date.now(); };
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
    return clock() - ts < DEDUP_WINDOW_MS;
  }

  function markAnnounced(key) {
    announced.set(key, clock());
    // Prevent unbounded growth — sweep old entries every 100 announcements
    if (announced.size > 200) {
      var now = clock();
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

    // Extract artifact name from the perception if available. The job sensor
    // emits the artifact PATH string; the object shape ({path}) is also
    // accepted in case anything else ever lands here with the full artifact
    // record — either way the announcement must never degrade to
    // "[object Object]".
    var artifactName = 'your build';
    var artifactRaw = p.artifact || (p.detail && p.detail.artifact);
    var artifactPath = artifactRaw && typeof artifactRaw === 'object' ? artifactRaw.path : artifactRaw;
    if (artifactPath) {
      var parts = String(artifactPath).split(/[/\\]/);
      artifactName = parts[parts.length - 1] || 'your build';
    }

    // BUG-016 / C1: never announce a build as done when the review rejected
    // it OR when the content came from the fallback engine rather than the
    // real one (job -531: reviewStatus:'failed' + evidence.pass:true was
    // announced as finished — evidence.pass meant "the phases ran", not "it
    // works"). Both signals go through the same completion rule the ship
    // path (agent-actions.js) already uses, so the two surfaces cannot drift.
    // BUG-311/316: this used to map an ABSENT verdict to 'approved', so a build
    // nobody reviewed was announced as finished — and it never saw refineStatus,
    // so the 2026-08-22 artifact the visual gate rejected with six issues was
    // announced as "Completed and verified, Sir." completionForJob applies the
    // same allowlist the ship path and job_status use, from the job record.
    var completion = completionStatusLib.completionForJob(p);
    if (completion.status === 'needs-work') {
      var reasonBits = [];
      if (p.reviewVerdict === 'reject' && Array.isArray(p.reviewIssues) && p.reviewIssues.length > 0) {
        reasonBits.push('the review found issues: ' + p.reviewIssues.slice(0, 3).join('; ')); // Limit to first 3 issues
      }
      if (p.engine === 'brain-fallback' || p.engine === 'fallback') {
        reasonBits.push('it was produced by the fallback engine, not the real one, so it is not confirmed working');
      }
      var reasonText = reasonBits.length ? reasonBits.join('; ') : 'it did not pass review';
      generate(
        'A build job completed but is NOT a finished build — it needs attention. ' +
        'Artifact: ' + artifactName + '. Reason: ' + reasonText +
        '. Say one natural sentence informing the operator that the build has issues needing attention. ' +
        'Do not say "finished" or "done" — say something like "completed but needs your attention" or "found some issues". ' +
        'Be helpful, not robotic.',
        artifactName + ' completed but needs your attention: ' + reasonText + '.'
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
  // BUG-273 (2026-08-19): two of the seven names here were emitted by NOTHING.
  // `cortex-stalled` and `provider-unhealthy` do not exist — the real kinds are
  // `cortex-stall` and `provider-down` — so the list read as covering a stalled
  // cortex while covering nothing at all, and BUG-273 D3's own regression test used
  // `cortex-stalled` as its fixture, proving a backoff ladder against a condition
  // that cannot occur. Removed rather than corrected: a real cortex-stall already
  // reaches the operator through immune/announcer.js's heal line when it heals, and
  // through the explainer's no-match path when it does not. Adding a third voice for
  // one condition is what W6 spent a wave undoing. A guard test now derives the real
  // emitted kinds from source and fails on any future phantom.
  var SERIOUS_KINDS = {
    'config-settings-ignored': true, 'config-settings-unreadable': true,
    'provider-down': true, 'tick-error': true,
    'effector-flapping': true, 'memory-growth': true,
    'identity-boundaries-malformed': true
  };

  function isSerious(p) {
    if (config.VOICE_SETTINGS_WARNINGS_ENABLED === false && /^config-settings-(ignored|unreadable)$/.test(p.kind || '')) return false;
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

  // BUG-273 D3 — REPEATS BACK OFF INSTEAD OF REPEATING ON A METRONOME.
  //
  // MEASURED in the operator's own session, 2026-08-18: four announcements of the
  // same self-healed cortex stall at 18:16:41, 18:21:48, 18:26:56 and 18:32:03 —
  // five minutes apart to within a second, because the dedup below was a flat
  // DEDUP_WINDOW_MS. Six of that session's eight turns were started by MYTHOS, every
  // injection came from this one path, and the operator's description of it was
  // "rambling on by yourself".
  //
  // The first announcement is the useful one and is untouched. Repeats of the SAME
  // kind climb: 5m, 15m, 45m, capped at 2h. Capped rather than unbounded because a
  // fault lasting all day must still say so occasionally — the operator has to be
  // able to tell "still broken" from "fixed", and silence cannot.
  //
  // The ladder resets once the kind has been quiet for a full cap, so a genuinely
  // new outbreak after a quiet stretch still leads with a prompt announcement rather
  // than inheriting yesterday's suppression.
  var REPEAT_LADDER_MS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000, 120 * 60 * 1000];
  var repeatRung = {};   // kind -> index into the ladder
  var lastSpokenAt = {}; // kind -> ts

  // Returns 0 when it should be spoken now, or the ms still to wait.
  function holdRemainingMs(kind) {
    var last = lastSpokenAt[kind];
    if (!last) return 0;
    var since = clock() - last;
    var cap = REPEAT_LADDER_MS[REPEAT_LADDER_MS.length - 1];
    // Quiet for a whole cap: this is a new outbreak, not a continuing one.
    if (since >= cap) { repeatRung[kind] = 0; return 0; }
    var wait = REPEAT_LADDER_MS[Math.min(repeatRung[kind] || 0, REPEAT_LADDER_MS.length - 1)];
    return since >= wait ? 0 : wait - since;
  }

  // The rung recorded here is the wait before the NEXT one, so the first announcement
  // of a condition leaves rung 0 (5m) rather than jumping straight to 15m — the first
  // repeat is still the one most likely to be worth hearing.
  function noteSpoken(kind) {
    var cap = REPEAT_LADDER_MS[REPEAT_LADDER_MS.length - 1];
    var isFirst = lastSpokenAt[kind] === undefined;
    var afterQuiet = !isFirst && (clock() - lastSpokenAt[kind]) >= cap;
    repeatRung[kind] = (isFirst || afterQuiet) ? 0
      : Math.min((repeatRung[kind] || 0) + 1, REPEAT_LADDER_MS.length - 1);
    lastSpokenAt[kind] = clock();
  }

  function onHealthAnomaly(event, collectText) {
    var p = event.payload;
    if (!p) return;
    if (!isSerious(p)) return;

    var kind = p.kind || 'unknown';
    var key = 'anomaly:' + kind + ':' + clock();
    // BUG-273 D3: was `if (isRecent(p.kind)) return;` — a flat 5-minute window, which
    // is what produced an identical announcement every 5 minutes for as long as the
    // condition lasted. Dedup is still BY KIND, so unrelated conditions never mute
    // each other; only the interval changed.
    var holdMs = holdRemainingMs(kind);
    if (holdMs > 0) {
      // Q2: the anomaly still reached the log, the audit and the HUD. Say on the bus
      // that the SPOKEN copy was held, so "why did it stop telling me?" is answerable
      // without reading this file.
      bus.emit('conversation.suppressed', { kind: kind, nextInMs: holdMs, reason: 'repeat-backoff' });
      return;
    }

    var text = ('Heads up — I have hit a problem: ' + describeCondition(p) + '.' +
      honestCauseClause(p)).slice(0, 300);
    if (!DRYRUN && !collectText) speak(text);
    bus.emit('conversation.announced', { key: key, text: text, kind: 'anomaly' });
    noteSpoken(kind);
    markAnnounced(kind);
    return DRYRUN ? null : text;
  }

  // BUG-429: these anomalies fire before this subscriber exists. Retain the
  // boot diagnosis, then join the first dashboard greeting at delivery time.
  // One Live injection avoids adding another self-interruption (BUG-432).
  function settingsAnomalies(diagnostics) {
    const d = diagnostics || {};
    const rows = [];
    if (d.settingsError) rows.push({ kind: 'config-settings-unreadable', reason: 'The saved settings could not be read; defaults are in use' });
    const names = (d.settingsUnknown || []).filter((name) => /^[A-Za-z0-9_]{1,64}$/.test(name));
    if (names.length || (d.settingsDropped || []).length) rows.push({
      kind: 'config-settings-ignored', target: names.slice(0, 12).join(', ') || 'saved settings',
      reason: names.length ? 'No such MYTHOS setting' : 'One or more saved settings have invalid names or values',
    });
    return rows;
  }
  function hasSettingsWarnings(diagnostics) {
    return !DRYRUN && config.VOICE_SETTINGS_WARNINGS_ENABLED !== false && settingsAnomalies(diagnostics).length > 0;
  }
  function appendSettingsWarnings(text, diagnostics) {
    const notes = settingsAnomalies(diagnostics).map((payload) => onHealthAnomaly({ payload }, true)).filter(Boolean);
    return [text, ...notes].filter(Boolean).join(' ');
  }

  // health.diagnosed carries severity from the diagnostician (anomaly → diagnose
  // → diagnose.pipeline). This is the reliable severity path — subscribe here
  // too so critical diagnoses are announced even if the raw anomaly kind isn't
  // in SERIOUS_KINDS above.
  function onHealthDiagnosed(event) {
    var p = event.payload;
    if (!p || p.severity !== 'critical') return;
    var key = 'diagnosed:' + (p.kind || p.syndrome || 'unknown') + ':' + clock();
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
  return { start: start, stop: stop, isRecent: isRecent, markAnnounced: markAnnounced,
    hasSettingsWarnings, appendSettingsWarnings,
    // exposed for tests, like immune/explainer.js's _onHealed
    _onHealthAnomaly: onHealthAnomaly };
}

module.exports = {
  createConversationAnnouncer: createConversationAnnouncer,
  // AD-5 wording, shared with immune/explainer.js — see the note above the factory.
  describeCondition: describeCondition,
  honestCauseClause: honestCauseClause,
};
