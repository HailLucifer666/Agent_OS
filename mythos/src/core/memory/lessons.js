'use strict';

const crypto = require('crypto');

// Lessons store — durable failure memory. The missing half of the learning loop.
// vault/Lessons/<topic>.md
//
// Format (mirrors semantic.js's sidecar+markdown convention so the OKF exporter
// and the vault browser treat it like any other store):
//   ## <topic>
//   <!-- {id: 'lsn-...', ts, count, lastSeen, trigger:{tool,argsHash,goalTitle}, sources:['ep-...']} -->
//   - <the lesson — one line: what failed and what to do differently>
//
// WHY THIS EXISTS. MYTHOS already records failures (episodic kind:'action'
// outcome:'fail') and even distills "recurring failures" in
// identity/reflection.js:reflectOnActions — but that signal died in the immune
// system's no-match path (no playbook handled 'recurring-failure') and nothing
// on the DECIDE/ACT path ever consulted it before re-committing to an action.
// log_incident wrote Incidents/ that nothing read back. A goal could fail
// identically forever. This store is where a lesson becomes a durable, queryable
// record the planner reads before its next brain call (goals/index.js, Layer 3)
// and that goal-failure distillation writes to (Layer 4).
//
// DESIGN NOTES.
//  * One file per topic (goal title or failure-mode slug). recordFailure() finds
//    an existing file by trigger match (tool + argsHash + goalTitle) and
//    increments count/bumps lastSeen rather than appending a duplicate — so
//    "shell_run with cmd:build timed out" surfaces as ONE lesson seen 7 times,
//    not seven lessons. The count is what the planner uses to decide "pause
//    this" vs "warn about it".
//  * No vector partition (unlike episodic/semantic/documents). Lessons are few
//    and matched by trigger identity + keyword overlap; a brute-force scan is
//    O(files) and correct. ponytail: ceiling is fine until thousands of lessons,
//    upgrade path is a 4th createVectorIndex() in memory/index.js.
//  * argsHash is a short stable hash of the action args (not the args verbatim)
//    so "shell_run {cmd:'npm test'}" matches the same failure mode without
//    exact-string equality on a whole args blob.

function createLessonsStore({ fs, config, bus, logger }) {
  var log = logger || { info: function() {}, warn: function() {} };
  // Greedy match up to the closing `-->` — the sidecar carries a nested
  // `trigger` object, so a `[^}]*` regex (semantic.js's flat sidecar trick)
  // would truncate at the first inner `}`. Match the whole HTML comment then
  // JSON.parse the bracketed content.
  const SIDECAR_RE = /<!--\s*(\{.*\})\s*-->/;
  const BULLET_RE = /^-\s+(.+)$/gm;

  function generateId() {
    return 'lsn-' + crypto.randomUUID();
  }

  function sanitizeFilename(name) {
    // Same slug rule as skills.js/semantic.js so topic names round-trip.
    return String(name || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'untitled';
  }

  // Short stable hash of an args object → 8 hex chars. Used as a coarse
  // "same shape of call" key. null/undefined args → '0' so absent-args calls
  // still match each other rather than hashing differently each time.
  function hashArgs(args) {
    if (args === null || args === undefined) return '0';
    var text;
    try { text = JSON.stringify(args); } catch (_) { text = String(args); }
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
  }

  function triggerKey(trigger) {
    trigger = trigger || {};
    return (trigger.tool || '') + '|' + (trigger.argsHash || hashArgs(trigger.args)) + '|' + (trigger.goalTitle || '');
  }

  // A stable topic slug from a trigger. Falls back to the tool name then to
  // 'general' so a lesson always has a sensible file even if the caller only
  // knows the tool.
  function topicFor(trigger, lessonText) {
    trigger = trigger || {};
    var base = trigger.goalTitle || trigger.tool || '';
    if (!base && lessonText) {
      // First ~4 words of the lesson as a slug — only when we have nothing else.
      base = String(lessonText).split(/\s+/).slice(0, 6).join(' ');
    }
    return sanitizeFilename(base || 'general');
  }

  function parseSidecar(content) {
    var m = SIDECAR_RE.exec(content || '');
    if (!m) return {};
    try { return JSON.parse(m[1]); } catch (_) { return {}; }
  }

  function parseBullets(content) {
    var facts = [];
    var m;
    var re = new RegExp(BULLET_RE.source, BULLET_RE.flags);
    while ((m = re.exec(content || '')) !== null) {
      facts.push(m[1].trim());
    }
    return facts;
  }

  function renderFile(topic, sidecar, lessons) {
    var scJson = JSON.stringify(sidecar);
    var bullets = lessons.map(function(l) { return '- ' + l; }).join('\n');
    return '## ' + topic + '\n\n<!-- ' + scJson + ' -->\n' + bullets + '\n';
  }

  // write(): create or overwrite a lesson file for `topic`. `lessons` is an
  // array of one or more bullet strings. `meta.trigger` keys the record for
  // recall; `meta.count`/`meta.lastSeen`/`meta.sources` are optional.
  function write(topic, lessons, meta) {
    meta = meta || {};
    var trigger = meta.trigger || {};
    var id = meta.id || generateId();
    var slug = sanitizeFilename(topic);
    var relPath = 'Lessons/' + slug + '.md';
    var sidecar = {
      id: id,
      ts: meta.ts || Date.now(),
      count: meta.count || 1,
      lastSeen: meta.lastSeen || (meta.ts || Date.now()),
      trigger: {
        tool: trigger.tool || '',
        argsHash: trigger.argsHash || hashArgs(trigger.args),
        goalTitle: trigger.goalTitle || ''
      },
      sources: meta.sources || []
    };
    var arr = Array.isArray(lessons) ? lessons.filter(function(l) { return l && String(l).trim(); }) : [];
    if (arr.length === 0) return { ref: null, degraded: true };
    try {
      fs.writeText(relPath, renderFile(slug, sidecar, arr.map(function(l){ return String(l); })));
      return { ref: id, degraded: false, path: relPath };
    } catch (err) {
      if (bus && typeof bus.emit === 'function') {
        bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'lessons', error: err.message });
      }
      return { ref: null, degraded: true };
    }
  }

  // recordFailure(): the core dedup path. If a lesson with the same trigger
  // (tool + argsHash + goalTitle) already exists, increment its count, bump
  // lastSeen, append the new lesson line if it isn't already present, and
  // re-write. Otherwise write a new file. Returns {ref, count, isNew}.
  function recordFailure(trigger, lessonText, opts) {
    opts = opts || {};
    var existing = findByTrigger(trigger);
    var now = Date.now();
    var text = String(lessonText || '').trim();
    if (!text) return { ref: null, degraded: true };
    if (existing) {
      var sidecar = existing.sidecar;
      var bullets = existing.bullets;
      // Append only if this exact lesson line isn't already recorded.
      var normalized = text.toLowerCase().replace(/[.!?]+$/, '');
      var dup = bullets.some(function(b) {
        return b.toLowerCase().replace(/[.!?]+$/, '') === normalized;
      });
      if (!dup) bullets.push(text);
      sidecar.count = (sidecar.count || 1) + 1;
      sidecar.lastSeen = now;
      if (opts.source && sidecar.sources.indexOf(opts.source) === -1) {
        sidecar.sources.push(opts.source);
      }
      write(existing.topic, bullets, {
        id: sidecar.id,
        ts: sidecar.ts,
        count: sidecar.count,
        lastSeen: sidecar.lastSeen,
        trigger: sidecar.trigger,
        sources: sidecar.sources
      });
      return { ref: sidecar.id, count: sidecar.count, isNew: false, path: existing.path };
    }
    var topic = topicFor(trigger, text);
    var res = write(topic, [text], {
      trigger: trigger,
      count: 1,
      lastSeen: now,
      sources: opts.source ? [opts.source] : []
    });
    return { ref: res.ref, count: 1, isNew: true, path: res.path };
  }

  function findByTrigger(trigger) {
    var key = triggerKey(trigger);
    var files = fs.listFiles('Lessons', '.md');
    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      if (sc.trigger && triggerKey(sc.trigger) === key) {
        return {
          topic: files[i].name.replace(/\.md$/, ''),
          path: files[i].path,
          sidecar: sc,
          bullets: parseBullets(content)
        };
      }
    }
    return null;
  }

  // recall(): match by trigger (exact tool/argsHash/goalTitle) and/or by keyword
  // overlap on the lesson text. A hit's `score` blends a trigger-exact bonus
  // with keyword coverage so the planner can rank "exact same approach failed
  // 7x" above "vaguely related lesson". `trigger` in opts is optional.
  function recall(query, opts) {
    opts = opts || {};
    var limit = opts.limit || Number((config && config.LESSON_RECALL_LIMIT) || 5);
    var trig = opts.trigger || {};
    var files = fs.listFiles('Lessons', '.md');
    var hits = [];
    var terms = String(query || '').toLowerCase().split(/\s+/).filter(function(t){ return t.length > 0; });

    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      var bullets = parseBullets(content);
      var lower = (content || '').toLowerCase();

      // Trigger-exact match: tool + argsHash both supplied and both match.
      var triggerScore = 0;
      if (trig.tool && sc.trigger && sc.trigger.tool === trig.tool) {
        triggerScore += 0.5;
        var argHash = trig.argsHash || hashArgs(trig.args);
        if (argHash && sc.trigger.argsHash === argHash) triggerScore += 0.5;
        if (trig.goalTitle && sc.trigger.goalTitle === trig.goalTitle) triggerScore += 0.2;
      }

      // Keyword overlap (same cheap scorer semantic.js uses).
      var kwScore = 0;
      if (terms.length > 0) {
        var matched = terms.filter(function(t){ return lower.indexOf(t) !== -1; }).length;
        kwScore = matched / terms.length;
      }

      var score = triggerScore + kwScore;
      // Include only if there's any signal: a trigger hit OR any keyword match.
      if (score > 0) {
        hits.push({
          ref: sc.id || files[i].name,
          score: score,
          count: sc.count || 1,
          lastSeen: sc.lastSeen,
          trigger: sc.trigger || {},
          record: {
            topic: files[i].name.replace(/\.md$/, ''),
            sidecar: sc,
            lessons: bullets
          },
          snippet: bullets.slice(0, 2).join('; ').slice(0, 220),
          store: 'lessons'
        });
      }
    }

    hits.sort(function(a, b) {
      // Higher count first when scores tie — a lesson seen 10x outranks one seen 2x.
      if (b.score === a.score) return (b.count || 1) - (a.count || 1);
      return b.score - a.score;
    });
    return hits.slice(0, limit);
  }

  function get(ref) {
    var files = fs.listFiles('Lessons', '.md');
    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      if (sc.id === ref || files[i].name.replace(/\.md$/, '') === ref) {
        return {
          ref: sc.id,
          topic: files[i].name.replace(/\.md$/, ''),
          content: content,
          sidecar: sc,
          lessons: parseBullets(content)
        };
      }
    }
    return null;
  }

  // prune(): drop lessons older than RETENTION (default 90d) and any with no
  // bullets after a parse. Called from cortex's reflect() cadence + consolidate().
  function prune(maxAgeDays) {
    var days = maxAgeDays || Number((config && config.LESSON_RETENTION_DAYS) || 90);
    var cutoff = Date.now() - days * 86400000;
    var files = fs.listFiles('Lessons', '.md');
    var removed = 0;
    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      var lastSeen = sc.lastSeen || sc.ts || 0;
      if (lastSeen && lastSeen < cutoff) {
        try { fs.removeFile(files[i].path); removed++; } catch (_) {}
      }
    }
    return removed;
  }

  // consolidate(): merge lessons that share an identical trigger (defensive —
  // recordFailure already dedups, but a race or an old file could produce
  // near-dups) and prune stale ones. Best-effort, never throws.
  function consolidate() {
    try {
      var pruned = prune();
      return { moved: 0, distilled: 0, archived: 0, pruned: pruned };
    } catch (err) {
      log.warn('lessons.consolidate-failed', { error: err && err.message });
      return { moved: 0, distilled: 0, archived: 0, pruned: 0 };
    }
  }

  function stats() {
    return { count: fs.listFiles('Lessons', '.md').length };
  }

  // toOkfConcepts(): export the whole Lessons store as OKF concept objects
  // ({type:'lesson', title, body, count, ...}) so the existing okf_export
  // tool can write a portable bundle in one call. OKF is type-agnostic (any
  // `type` is valid per spec, unknown types tolerated), so `type:'lesson'` is
  // a MYTHOS convention — a future consumer that doesn't know it still reads
  // the frontmatter + body harmlessly. This is the interchange half of the
  // learning loop: lessons survive a re-install or backup as plain markdown.
  function toOkfConcepts() {
    var files = fs.listFiles('Lessons', '.md');
    var concepts = [];
    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      var bullets = parseBullets(content);
      concepts.push({
        type: 'lesson',
        title: files[i].name.replace(/\.md$/, ''),
        count: sc.count || 1,
        lastSeen: sc.lastSeen,
        trigger: sc.trigger || {},
        sources: sc.sources || [],
        body: bullets.map(function(b) { return '- ' + b; }).join('\n')
      });
    }
    return concepts;
  }

  async function init() {
    try { fs.ensureDir(fs.vaultPath('Lessons')); } catch (_) {}
  }

  return {
    write: write,
    recordFailure: recordFailure,
    recall: recall,
    get: get,
    findByTrigger: findByTrigger,
    prune: prune,
    consolidate: consolidate,
    stats: stats,
    toOkfConcepts: toOkfConcepts,
    init: init,
    // Exposed for tests + the goals planner which needs a consistent hash.
    hashArgs: hashArgs
  };
}

module.exports = { createLessonsStore: createLessonsStore };
