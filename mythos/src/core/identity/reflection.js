'use strict';

// identity/reflection.js — the learning loop (P4 Jarvis upgrade). Every N
// conversation turns (REFLECTION_EVERY_TURNS, default 15) and once at
// graceful shutdown, one cheap brain call reads the recent conversation
// episodics and extracts:
//   - 0-3 NEW durable operator preferences (written via identity.learn(),
//     which persona() folds into every subsequent brain call), and
//   - a one-line operator speaking-style note (identity.setOperatorStyle()).
// Dedupe is two-layer: the prompt lists what is already known and asks the
// model to skip it, and a substring guard here drops near-duplicates anyway.
// Everything is best-effort — an offline brain or a write failure skips the
// pass; the next one tries again. One LLM call per ~15 turns on the free
// simple lane keeps this affordable.

function createReflection({ brain, memory, identity, config, logger, bus }) {
  if (!brain || !memory || !identity) {
    throw new Error('createReflection requires brain, memory, identity');
  }
  var log = logger || { info: function() {}, warn: function() {} };
  var everyTurns = Number((config && config.REFLECTION_EVERY_TURNS) || process.env.REFLECTION_EVERY_TURNS) || 15;
  // V9 (Phase 4): cadence for the action-outcome reflection pass, separate
  // from the conversation-preferences pass above. Defaults to 2x the
  // conversation cadence so the action analysis runs less often (it scans
  // a larger episodic window and writes to the diagnostician + Skills).
  var actionEveryTurns = Number((config && config.REFLECTION_ACTION_EVERY_TURNS) || process.env.REFLECTION_ACTION_EVERY_TURNS) || (everyTurns * 2);
  var turns = 0;
  var running = false;
  var runningActions = false;   // V9: separate reentrancy guard

  function existingPrefs() {
    try {
      var raw = memory.identity.readRaw();
      var section = raw.match(/## Learned Preferences\n([\s\S]*)$/);
      if (!section) return [];
      return (section[1].match(/^-\s+.+$/gm) || []).map(function(line) {
        return line.replace(/^-\s+/, '').trim();
      });
    } catch (_) {
      return [];
    }
  }

  function isNearDuplicate(candidate, known) {
    var c = candidate.toLowerCase();
    return known.some(function(k) {
      var e = k.toLowerCase();
      return e.indexOf(c) !== -1 || c.indexOf(e) !== -1;
    });
  }

  async function runNow(reason) {
    if (running) return { skipped: 'already-running' };
    running = true;
    try {
      var convos = [];
      try {
        // 7-day window (was 2): the profile rewrite below needs enough history to
        // reconstruct durable facts, and a 2-day view forgets anything the
        // operator mentioned earlier in the week.
        convos = memory.episodic.recall('', { kind: 'conversation', limit: 30, windowDays: 7 }) || [];
      } catch (_) {}
      if (convos.length < 5) return { skipped: 'too-few-conversations' };

      var known = existingPrefs();
      var convoLines = convos.map(function(hit) {
        return (hit.record && hit.record.summary) || hit.snippet || '';
      }).filter(Boolean);

      var currentProfile = '';
      try {
        if (typeof identity.getOperatorProfile === 'function') {
          currentProfile = identity.getOperatorProfile() || '';
        }
      } catch (_) {}

      var prompt = [
        'You are reviewing your recent conversations with your operator to learn about them.',
        'Extract ONLY durable, non-obvious facts worth remembering long-term: how they phrase things,',
        'corrections they made, likes/dislikes, working habits, standing instructions. No one-off',
        'task details, nothing speculative, nothing already in the known list.',
        '',
        'ALREADY KNOWN (do not repeat or rephrase these):',
        known.length ? known.map(function(k) { return '- ' + k; }).join('\n') : '(nothing yet)',
        '',
        'RECENT CONVERSATION TURNS (newest first):',
        convoLines.join('\n'),
        '',
        // The profile is REWRITTEN, not appended to. That is what makes it both
        // accumulate and stay small without an eviction policy: everything still
        // true is carried forward, stale lines simply are not re-emitted.
        'YOUR CURRENT OPERATOR PROFILE (rewrite it in full below):',
        currentProfile || '(empty — build it from scratch)',
        '',
        'Respond with ONE JSON object, nothing else:',
        '{"preferences": ["0-3 one-line facts, empty array if nothing new"],',
        ' "style": "one line describing how the operator speaks/works, or empty string",',
        ' "profile": "the COMPLETE rewritten profile, at most 6 short lines separated by newlines:',
        'how to address them, the people who matter to them, recurring projects, standing',
        'preferences, what they are focused on now. PRESERVE every fact above that is still true —',
        'this replaces the old profile entirely, so anything you leave out is forgotten. Empty',
        'string only if you have nothing at all."}'
      ].join('\n');

      // lane 'reasoning' (2026-08-14): this call rewrites the operator profile
      // wholesale — anything it fails to carry forward is FORGOTTEN (see the
      // PRESERVE clause in the prompt above). That is not a job for the
      // fastest-cheapest lane. Rare enough that Cerebras's 5/min is no risk.
      var result = await brain.think({
        lane: 'reasoning',
        messages: [{ role: 'user', content: prompt }],
        source: 'reflection:' + (reason || 'cadence')
      });
      if (!result || result.offline || !result.parsed) return { skipped: 'brain-unavailable' };

      var written = 0;
      var prefs = Array.isArray(result.parsed.preferences) ? result.parsed.preferences.slice(0, 3) : [];
      for (var i = 0; i < prefs.length; i++) {
        var p = String(prefs[i] || '').trim();
        if (p.length < 8 || p.length > 200) continue;
        if (isNearDuplicate(p, known)) continue;
        var res = await identity.learn({ signal: null, text: p, sourceEpId: 'reflection' });
        if (res && res.ref) {
          known.push(p);
          written += 1;
        }
      }

      var styleWritten = false;
      var style = typeof result.parsed.style === 'string' ? result.parsed.style.trim() : '';
      if (style && style.length >= 8 && typeof identity.setOperatorStyle === 'function') {
        styleWritten = identity.setOperatorStyle(style).ok === true;
      }

      // Never let a degenerate reply blank an existing profile: a too-short
      // rewrite is treated as "the model had nothing", not as a deletion.
      var profileWritten = false;
      var profile = typeof result.parsed.profile === 'string' ? result.parsed.profile.trim() : '';
      if (profile && profile.length >= 8 && typeof identity.setOperatorProfile === 'function') {
        profileWritten = identity.setOperatorProfile(profile).ok === true;
      }

      if (written || styleWritten || profileWritten) {
        log.info('reflection.learned', { preferences: written, styleUpdated: styleWritten, profileUpdated: profileWritten });
      }
      return { written: written, styleUpdated: styleWritten, profileUpdated: profileWritten };
    } finally {
      running = false;
    }
  }

  // V9 (Phase 4): action-outcome reflection. Reads the last N action episodics,
  // asks the brain to identify recurring failure patterns + reusable success
  // patterns. Routes:
  //   - recurring failures → bus.emit('health.anomaly', {kind:'recurring-failure', ...})
  //     so the diagnostician can pick them up (it already subscribes to
  //     health.anomaly events — see immune/diagnostician.js:58)
  //   - success patterns → memory.skills.write() for future procedural recall
  //
  // Mirrors runNow's structure: reentrancy-guarded, one bounded brain call on
  // the 'simple' lane, best-effort, never blocks the caller. Idle-skip: only
  // runs when there are >= REFLECTION_ACTION_MIN (default 5) recent actions to
  // analyze (otherwise there's nothing to learn from).
  async function reflectOnActions(reason) {
    if (runningActions) return { skipped: 'already-running' };
    runningActions = true;
    try {
      if (!memory.episodic) return { skipped: 'no-episodic' };
      var actions = [];
      try {
        actions = memory.episodic.recall('', { kind: 'action', limit: 30, windowDays: 2 }) || [];
      } catch (_) { return { skipped: 'episodic-unavailable' }; }

      var minActions = Number((config && config.REFLECTION_ACTION_MIN) || 5);
      if (actions.length < minActions) return { skipped: 'too-few-actions', count: actions.length };

      // Compact the action trace. Tag each line with outcome so the brain can
      // spot patterns. SkillRef presence tells it which procedure produced the
      // outcome (if any).
      var lines = actions.map(function (hit) {
        var r = hit && hit.record ? hit.record : hit;
        var ok = r.outcome === 'ok' ? 'OK  ' : 'FAIL';
        var skill = r.skillRef ? (' <' + r.skillRef + '>') : '';
        return '[' + ok + ']' + skill + ' ' + (r.summary || r.tool || 'unknown');
      });

      // lane 'reasoning' (2026-08-14) — pattern-finding across a failure trace,
      // the same class as the profile rewrite above.
      var result = await brain.think({
        lane: 'reasoning',
        messages: [{ role: 'user', content:
          'You are reviewing a trace of your recent autonomous actions to learn from them.\n' +
          'Each line shows [OK|FAIL] <optional skillRef> followed by the action summary.\n\n' +
          lines.join('\n') + '\n\n' +
          'Identify:\n' +
          '1. RECURRING FAILURES — patterns where the same kind of action keeps failing. ' +
          'For each, name the failure mode in one line (e.g. "shell_run with cmd:build keeps timing out").\n' +
          '2. SUCCESS PATTERNS — sequences of 2-4 actions that consistently succeed together and could ' +
          'be reused as a procedure. For each, give a name, a when-condition, and the ordered steps.\n\n' +
          'Respond as JSON: {"failures": ["one-line failure mode 1", ...], ' +
          '"successes": [{"name":"kebab-name","when":"trigger condition",' +
          '"steps":[{"tool":"tool-name","args":{<required>}}, ...]}]}\n' +
          'Empty arrays if nothing fits. Do not invent tools that do not appear in the trace.'
        }],
        schemaHint: '{ failures: string[], successes: Array<{name:string,when:string,steps:Array<{tool:string,args:object}>}> }',
        source: 'reflection:actions:' + (reason || 'cadence')
      });
      if (!result || result.offline || result.aborted || !result.parsed) {
        return { skipped: 'brain-unavailable' };
      }

      // Wave 0 (2026-08-13): recurring-failure anomalies carried {kind, detail}
      // only — no `target`, so the diagnostician/announcer (announcer.js's
      // onHealed builds "Trigger: <kind> on <target>") rendered a blank
      // trigger for this kind. Recover a real tool name from the FAIL actions
      // that actually fed the brain call, rather than guessing from the
      // free-text failure line alone.
      var failedTools = actions.reduce(function (set, hit) {
        var r = hit && hit.record ? hit.record : hit;
        if (r && r.outcome !== 'ok' && r.tool) set.add(String(r.tool));
        return set;
      }, new Set());

      function targetFor(line) {
        for (var t of failedTools) {
          if (t && line.indexOf(t) !== -1) return t;
        }
        var firstWord = /^([a-zA-Z_][\w-]*)/.exec(line);
        return firstWord ? firstWord[1] : '';
      }

      var failuresEmitted = 0;
      var lessonsWritten = 0;
      var failures = Array.isArray(result.parsed.failures) ? result.parsed.failures.slice(0, 5) : [];
      failures.forEach(function (f) {
        var line = String(f || '').trim();
        if (line.length < 5 || line.length > 200) return;
        // Route to the diagnostician via the existing health.anomaly channel.
        // The diagnostician subscribes (immune/diagnostician.js) and the healer's
        // 'recurring-failure-record' playbook turns it into a durable Lesson.
        if (bus && typeof bus.emit === 'function') {
          bus.emit('health.anomaly', { kind: 'recurring-failure', detail: line, target: targetFor(line) });
          failuresEmitted++;
        }
        // Also write the lesson directly, so headless autonomous runs (which
        // never go through the voice turn path that drives noteTurn) still feed
        // the Lessons store even if the bus/healer path is unreachable. Dedup
        // by the failure line so repeat fires increment count.
        if (memory && memory.lessons && typeof memory.lessons.recordFailure === 'function') {
          try {
            var res = memory.lessons.recordFailure({ tool: '', goalTitle: line.slice(0, 60) }, line, { source: 'reflection' });
            if (res && res.ref) lessonsWritten++;
          } catch (_) { /* lesson write is best-effort */ }
        }
      });

      var skillsWritten = 0;
      var successes = Array.isArray(result.parsed.successes) ? result.parsed.successes.slice(0, 3) : [];
      if (memory.skills && typeof memory.skills.write === 'function') {
        for (var i = 0; i < successes.length; i++) {
          var s = successes[i];
          if (!s || !s.name || !Array.isArray(s.steps) || s.steps.length === 0) continue;
          try {
            var res = memory.skills.write(s.name, {
              when: [s.when || ''],
              steps: s.steps,
              successCriteria: [],
              uses: 0,
              successRate: 0
            });
            if (res && res.ref) skillsWritten++;
          } catch (_) { /* skill write is best-effort */ }
        }
      }

      if (failuresEmitted || skillsWritten || lessonsWritten) {
        log.info('reflection.actions', { failures: failuresEmitted, skills: skillsWritten, lessons: lessonsWritten });
      }
      return { failuresEmitted: failuresEmitted, skillsWritten: skillsWritten, lessonsWritten: lessonsWritten };
    } finally {
      runningActions = false;
    }
  }

  // Called once per completed conversation turn (server/index.js). Fires a
  // background reflection pass every `everyTurns` turns — never blocks the turn.
  function noteTurn() {
    turns += 1;
    if (turns >= everyTurns) {
      var carry = turns - everyTurns;
      turns = carry;
      runNow('cadence').catch(function(err) {
        log.warn('reflection.failed', { error: err.message });
      });
    }
    // V9 (Phase 4): action-outcome reflection on its own (slower) cadence.
    // Tracks turns independently so the two passes don't have to co-fire.
    if (turns > 0 && turns % actionEveryTurns === 0) {
      reflectOnActions('cadence').catch(function (err) {
        log.warn('reflection.actions.failed', { error: err && err.message });
      });
    }
  }

  return {
    noteTurn: noteTurn,
    runNow: runNow,
    reflectOnActions: reflectOnActions   // V9: also exposed for direct invocation
  };
}

module.exports = { createReflection };
