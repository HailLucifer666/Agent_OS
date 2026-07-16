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

function createReflection({ brain, memory, identity, config, logger }) {
  if (!brain || !memory || !identity) {
    throw new Error('createReflection requires brain, memory, identity');
  }
  var log = logger || { info: function() {}, warn: function() {} };
  var everyTurns = Number((config && config.REFLECTION_EVERY_TURNS) || process.env.REFLECTION_EVERY_TURNS) || 15;
  var turns = 0;
  var running = false;

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
        convos = memory.episodic.recall('', { kind: 'conversation', limit: 30, windowDays: 2 }) || [];
      } catch (_) {}
      if (convos.length < 5) return { skipped: 'too-few-conversations' };

      var known = existingPrefs();
      var convoLines = convos.map(function(hit) {
        return (hit.record && hit.record.summary) || hit.snippet || '';
      }).filter(Boolean);

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
        'Respond with ONE JSON object, nothing else:',
        '{"preferences": ["0-3 one-line facts, empty array if nothing new"],',
        ' "style": "one line describing how the operator speaks/works, or empty string"}'
      ].join('\n');

      var result = await brain.think({
        lane: 'simple',
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

      if (written || styleWritten) {
        log.info('reflection.learned', { preferences: written, styleUpdated: styleWritten });
      }
      return { written: written, styleUpdated: styleWritten };
    } finally {
      running = false;
    }
  }

  // Called once per completed conversation turn (server/index.js). Fires a
  // background reflection pass every `everyTurns` turns — never blocks the turn.
  function noteTurn() {
    turns += 1;
    if (turns < everyTurns) return;
    turns = 0;
    runNow('cadence').catch(function(err) {
      log.warn('reflection.failed', { error: err.message });
    });
  }

  return { noteTurn: noteTurn, runNow: runNow };
}

module.exports = { createReflection };
