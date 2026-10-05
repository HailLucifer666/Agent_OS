'use strict';

const crypto = require('crypto');
// BUG-451: how each lesson line was established — see provenance.js.
const { provenanceOf, OBSERVATION, HYPOTHESIS } = require('./provenance');

// Lessons store — durable failure memory. The missing half of the learning loop.
// vault/Lessons/<topic-slug>--<key digest>.md (since S2; older files are <topic-slug>.md)
//
// Format (mirrors semantic.js's sidecar+markdown convention so the OKF exporter
// and the vault browser treat it like any other store):
//   ## <topic>
//   <!-- {id: 'lsn-...', topic, ts, count, lastSeen, trigger:{tool,argsHash,argsKey,goalTitle}, sources:['ep-...']} -->
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
//  * One file per RECORD, i.e. per trigger (see IDENTITY below) — not per topic,
//    which is what it was before S2. recordFailure() finds the existing record
//    by trigger match (tool + args + goalTitle) and
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
//  * PROVENANCE (BUG-451, 2026-09-23). The sidecar's `provenance` array labels
//    each bullet, by index: 'observation' (what happened) or 'hypothesis' (a
//    stated cause). The label is computed from the bullet's text by the server
//    (provenance.js) — never taken from a caller, so nothing written here can
//    claim to be verified. An entry keeps the label it was written with; a file
//    written before labels existed is classified at read. The planner is given
//    only the observations (`plannerSnippet`): a guessed cause read back as an
//    instruction is how the 2026-09-23 lesson would have steered later sessions
//    away from the one click mechanism that works.
//  * IDENTITY (S2 of the Stage 1 repair campaign, 2026-09-25, BUG-473, audit
//    F06-F08). Three defects, each reproduced against main f456217d:
//      F06 the FILE was named after the goal title (or tool) while a record was
//          identified by tool + args + goal title — so two different failures of
//          one goal ("Build application", avoid "npm" vs avoid "yarn") shared a
//          file and the second write replaced the first. The real callers make
//          this the common case: goals/index.js keys every distilled lesson by
//          the goal's title and passes the model's free-text "avoid" as the tool.
//      F07 recordFailure() ignored write()'s result: a failed update returned a
//          count one higher than the file held, isNew:false and a ref.
//      F08 hashArgs() hashed JSON.stringify(args), so {x:1,y:2} and {y:2,x:1}
//          were two different failure modes.
//    Now: storage identity is the WHOLE logical key (tool, a full sha256 of the
//    canonical args, goal title) — digested into the file name, and verified
//    against the stored key before any file is replaced, so a digest alone can
//    never authorise an overwrite. Canonical args sort object keys at every
//    depth and keep array order and value types; anything JSON cannot say
//    exactly (a function, a Map, a cycle, NaN) is refused, never collapsed into
//    "[object Object]". Files written before this keep their name and identity
//    and are still found: nothing is migrated. One bound, the legacy data's own:
//    an old args hash was taken in the order the caller happened to pass the
//    keys, and a hash cannot be re-sorted, so an old record is found when args
//    arrive in that order or in sorted order. In any other order a new record is
//    written BESIDE it and the old one is left whole — a duplicate, never a loss.
//    No production caller passes args today (goals, reflection, the healer and
//    incident notes key by tool and goal title), so no such record is expected.

// A value canonicalArgs() cannot represent exactly. Typed, so a caller can tell
// "these args cannot be keyed" from every other failure.
class UnsupportedArgsError extends Error {
  constructor(what) { super('lesson trigger args cannot be keyed exactly: ' + what); this.code = 'ELESSONARGS'; }
}

// Object keys sorted at every depth; arrays keep their order; strings, finite
// numbers, booleans and null keep their JSON type. Throws UnsupportedArgsError.
function canonicalArgs(value, seen) {
  seen = seen || new Set();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new UnsupportedArgsError('a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new UnsupportedArgsError('a ' + typeof value);
  if (seen.has(value)) throw new UnsupportedArgsError('a cycle');
  seen.add(value);
  var out;
  if (Array.isArray(value)) {
    // Array.from, not map: map skips the holes of a sparse array, and JSON reads a hole as null.
    out = '[' + Array.from(value, function(v) { return v === undefined ? 'null' : canonicalArgs(v, seen); }).join(',') + ']';
  } else {
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new UnsupportedArgsError('a ' + ((value.constructor && value.constructor.name) || 'non-plain object'));
    out = '{' + Object.keys(value).sort().filter(function(k) { return value[k] !== undefined; })
      .map(function(k) { return JSON.stringify(k) + ':' + canonicalArgs(value[k], seen); }).join(',') + '}';
  }
  seen.delete(value);
  return out;
}

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

  // Short stable hash of an args object → 8 hex chars, kept in each record as
  // its display-level "same shape of call" key. null/undefined args → '0' so
  // absent-args calls still match each other. Canonical since S2: key order no
  // longer matters. Throws UnsupportedArgsError for args it cannot key exactly.
  function hashArgs(args) {
    if (args === null || args === undefined) return '0';
    return crypto.createHash('sha1').update(canonicalArgs(args)).digest('hex').slice(0, 8);
  }

  // The pre-S2 hash, for finding records written before it: JSON.stringify in
  // the caller's key order. Only ever compared against, never written.
  function legacyHashArgs(args) {
    if (args === null || args === undefined) return '0';
    var text;
    try { text = JSON.stringify(args); } catch (_) { text = String(args); }
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
  }

  // The full identity of a trigger. argsKey is a whole sha256 of the canonical
  // args — never the 8-hex display hash — so two different calls cannot share
  // it by truncation. A caller that passes only an argsHash (the healer passes
  // '0') is keyed by that hash, which is all it said.
  function identityOf(trigger) {
    trigger = trigger || {};
    var argsKey = trigger.args !== undefined && trigger.args !== null
      ? crypto.createHash('sha256').update(canonicalArgs(trigger.args)).digest('hex')
      : 'h:' + (trigger.argsHash || '0');
    return { tool: String(trigger.tool || ''), goalTitle: String(trigger.goalTitle || ''), argsKey: argsKey,
      argsHash: trigger.argsHash || hashArgs(trigger.args) };
  }

  function logicalKey(id) {
    return JSON.stringify([id.tool, id.argsKey, id.goalTitle]);
  }

  // Does a stored sidecar trigger belong to this identity? A record written
  // since S2 carries argsKey and must match it exactly. An older record carries
  // only the 8-hex argsHash: it matches on tool and goal title plus that hash
  // taken canonically (sorted keys) or in the caller's key order, which is how
  // it was taken before S2 — the one ambiguity left, and it is the legacy
  // data's, not a new one.
  // A lookup that knows only an argsHash (no args) is matched on that hash —
  // it is all the caller said, and a lookup is not an overwrite.
  function storedMatches(stored, id, trigger) {
    if (!stored || String(stored.tool || '') !== id.tool || String(stored.goalTitle || '') !== id.goalTitle) return false;
    var hasArgs = Boolean(trigger) && trigger.args !== undefined && trigger.args !== null;
    if (!hasArgs) return stored.argsKey && /^h:/.test(stored.argsKey) ? stored.argsKey === id.argsKey : stored.argsHash === id.argsHash;
    if (stored.argsKey) return stored.argsKey === id.argsKey;
    return [id.argsHash, legacyHashArgs(trigger.args)].indexOf(stored.argsHash) !== -1;
  }

  // Where a NEW record with this identity lives: the display topic's slug plus a
  // digest of the whole logical key. If that name is already taken by a record
  // with a different key — a digest collision, or a hand-copied file — the next
  // free suffix is used instead. The stored key is read and compared first.
  // The read-and-compare is what keeps records apart; the digest is what keeps
  // the suffix range from running out. On the slug alone every failure mode of
  // one goal would share the range, and its 100th would have nowhere to go
  // (test i5, mutation m6).
  function pathForNew(topic, id) {
    var base = 'Lessons/' + sanitizeFilename(topic) + '--' + crypto.createHash('sha256').update(logicalKey(id)).digest('hex').slice(0, 16);
    for (var n = 1; n < 100; n++) {
      var rel = base + (n === 1 ? '' : '-' + n) + '.md';
      var content = fs.readText(rel, '');
      if (!content) return rel;
      var sc = parseSidecar(content);
      var t = sc.trigger || {};
      // This very record, written earlier: the same WHOLE key, not a digest of it.
      if (t.argsKey === id.argsKey && String(t.tool || '') === id.tool && String(t.goalTitle || '') === id.goalTitle) return rel;
    }
    throw new Error('no free lesson file name for ' + base);
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

  // Only the two labels a writer can earn. Anything else a caller passes — a
  // 'verified', a typo, an object — is discarded and recomputed from the text.
  function safeLabel(label, text) {
    return label === OBSERVATION || label === HYPOTHESIS ? label : provenanceOf(text);
  }

  function labelsFor(sidecar, bullets) {
    var stored = sidecar && Array.isArray(sidecar.provenance) ? sidecar.provenance : [];
    return bullets.map(function(b, i) { return safeLabel(stored[i], b); });
  }

  // What the planner may read as a prior failure: the observations only.
  function plannerSnippetFor(bullets, labels) {
    var grounded = bullets.filter(function(b, i) { return labels[i] !== HYPOTHESIS; });
    if (!grounded.length) return 'a failure is recorded here, but the only cause it states is unverified';
    return grounded.slice(0, 2).join('; ').slice(0, 220);
  }

  function renderFile(topic, sidecar, lessons) {
    var scJson = JSON.stringify(sidecar);
    var bullets = lessons.map(function(l) { return '- ' + l; }).join('\n');
    return '## ' + topic + '\n\n<!-- ' + scJson + ' -->\n' + bullets + '\n';
  }

  function failed(reason, err) {
    if (bus && typeof bus.emit === 'function') {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'lessons', reason: reason, error: err ? err.message : reason });
    }
    return { ref: null, degraded: true, reason: reason };
  }

  function sameStoredTrigger(a, b) {
    a = a || {}; b = b || {};
    return ['tool', 'argsHash', 'argsKey', 'goalTitle'].every(function(k) { return String(a[k] || '') === String(b[k] || ''); });
  }

  // write(): create a NEW lesson record. `lessons` is an array of one or more
  // bullet strings; `meta.trigger` is the caller's {tool, args|argsHash,
  // goalTitle}; `meta.count`/`meta.lastSeen`/`meta.sources` are optional. The
  // record gets its own file (pathForNew) and its full key. There is no way to
  // name a file here: replacing a record is recordFailure's alone (writeRecord
  // with a path it just read), so no caller can aim a write at another record,
  // or at any other file in the vault.
  // Returns {ref, degraded:false, path}, or {ref:null, degraded:true, reason}.
  function write(topic, lessons, meta) {
    return writeRecord(topic, lessons, meta, null);
  }

  // REPLACE (replacePath given): `meta.trigger` is the STORED trigger, written
  // back unchanged, and only after the file at replacePath is read again and
  // found to still hold that same trigger — nothing replaces a record it did not
  // just read, and a record that vanished in between is not recreated. A legacy
  // record keeps its file name, id and identity this way.
  function writeRecord(topic, lessons, meta, replacePath) {
    meta = meta || {};
    var arr = Array.isArray(lessons) ? lessons.filter(function(l) { return l && String(l).trim(); }) : [];
    if (arr.length === 0) return { ref: null, degraded: true, reason: 'no-lesson-text' };
    var trigger = meta.trigger || {};
    var relPath, storedTrigger;
    try {
      if (replacePath) {
        var current = fs.readText(replacePath, '');
        if (!current || !sameStoredTrigger(parseSidecar(current).trigger, trigger)) return failed('record-changed-underneath');
        relPath = replacePath;
        storedTrigger = { tool: trigger.tool || '', argsHash: trigger.argsHash || '0', goalTitle: trigger.goalTitle || '' };
        if (trigger.argsKey) storedTrigger.argsKey = trigger.argsKey;
      } else {
        var ident = identityOf(trigger);
        relPath = pathForNew(topic, ident);
        storedTrigger = { tool: ident.tool, argsHash: ident.argsHash, argsKey: ident.argsKey, goalTitle: ident.goalTitle };
      }
    } catch (err) {
      return failed(err && err.code === 'ELESSONARGS' ? 'unsupported-args' : 'identity-failed', err);
    }
    var id = meta.id || generateId();
    var slug = sanitizeFilename(topic);
    var sidecar = {
      id: id,
      topic: meta.displayTopic || String(topic || slug),
      ts: meta.ts || Date.now(),
      count: meta.count || 1,
      lastSeen: meta.lastSeen || (meta.ts || Date.now()),
      trigger: storedTrigger,
      sources: meta.sources || []
    };
    var given = Array.isArray(meta.provenance) ? meta.provenance : [];
    sidecar.provenance = arr.map(function(l, i) { return safeLabel(given[i], l); });
    try {
      fs.writeText(relPath, renderFile(slug, sidecar, arr.map(function(l){ return String(l); })));
      return { ref: id, degraded: false, path: relPath };
    } catch (err) {
      return failed('write-failed', err);
    }
  }

  // recordFailure(): the core dedup path. If a lesson with the same trigger
  // (tool + argsHash + goalTitle) already exists, increment its count, bump
  // lastSeen, append the new lesson line if it isn't already present, and
  // re-write. Otherwise write a new file. Returns {ref, count, isNew}.
  //
  // S2 (F07): the write's result is the answer. A failed update returns
  // degraded:true, ref:null (nothing was recorded this time), the id that WAS
  // already there as existingRef, and the count the file still holds — never
  // the count it would have held. Nothing here keeps state between calls, so a
  // failure changes nothing a later call can see, and a retry counts once.
  function recordFailure(trigger, lessonText, opts) {
    opts = opts || {};
    var now = Date.now();
    var text = String(lessonText || '').trim();
    if (!text) return { ref: null, degraded: true, reason: 'no-lesson-text' };
    var existing;
    try { existing = findByTrigger(trigger); } catch (err) {
      if (err && err.code === 'ELESSONARGS') return failed('unsupported-args', err);
      throw err;
    }
    if (existing) {
      var sidecar = Object.assign({}, existing.sidecar);
      sidecar.sources = Array.isArray(sidecar.sources) ? sidecar.sources.slice() : [];
      var persistedCount = sidecar.count || 1;
      var bullets = existing.bullets.slice();
      // Append only if this exact lesson line isn't already recorded.
      var normalized = text.toLowerCase().replace(/[.!?]+$/, '');
      var dup = bullets.some(function(b) {
        return b.toLowerCase().replace(/[.!?]+$/, '') === normalized;
      });
      // Existing entries keep the labels they were written with; the new one is
      // labelled from its own text. Never relabel content that was already there.
      var labels = labelsFor(sidecar, bullets);
      if (!dup) { bullets.push(text); labels.push(provenanceOf(text)); }
      if (opts.source && sidecar.sources.indexOf(opts.source) === -1) {
        sidecar.sources.push(opts.source);
      }
      var updated = writeRecord(existing.topic, bullets, {
        id: sidecar.id,
        displayTopic: sidecar.topic || existing.topic,
        ts: sidecar.ts,
        count: persistedCount + 1,
        lastSeen: now,
        trigger: sidecar.trigger,
        sources: sidecar.sources,
        provenance: labels
      }, existing.path);
      if (updated.degraded) {
        return { ref: null, existingRef: sidecar.id, count: persistedCount, isNew: false, degraded: true, reason: updated.reason,
          path: existing.path };
      }
      return { ref: sidecar.id, count: persistedCount + 1, isNew: false, path: existing.path };
    }
    var topic = topicFor(trigger, text);
    var res = write(topic, [text], {
      trigger: trigger,
      count: 1,
      lastSeen: now,
      sources: opts.source ? [opts.source] : []
    });
    if (res.degraded) return { ref: null, count: 0, isNew: false, degraded: true, reason: res.reason };
    return { ref: res.ref, count: 1, isNew: true, path: res.path };
  }

  // The record for this trigger, or null. A record keyed by the whole key
  // (written since S2) wins over a legacy one matched by its 8-hex hash.
  // Throws UnsupportedArgsError when the trigger's args cannot be keyed.
  function findByTrigger(trigger) {
    var id = identityOf(trigger);
    var files = fs.listFiles('Lessons', '.md');
    var legacy = null;
    for (var i = 0; i < files.length; i++) {
      var content = fs.readText(files[i].path, '');
      if (!content) continue;
      var sc = parseSidecar(content);
      if (!storedMatches(sc.trigger, id, trigger)) continue;
      var rec = { topic: displayTopic(sc, files[i]), path: files[i].path, sidecar: sc, bullets: parseBullets(content),
        legacy: !sc.trigger.argsKey };
      if (!rec.legacy) return rec;
      if (!legacy) legacy = rec;
    }
    return legacy;
  }

  // What a person sees as the record's name: the topic it was written under.
  // Files since S2 carry a digest in their name; files before carry only the slug.
  function displayTopic(sc, file) {
    return (sc && sc.topic) || file.name.replace(/\.md$/, '');
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
        var argHash = trig.argsHash || (function() { try { return hashArgs(trig.args); } catch (_) { return null; } })();
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
        var labels = labelsFor(sc, bullets);
        hits.push({
          ref: sc.id || files[i].name,
          score: score,
          count: sc.count || 1,
          lastSeen: sc.lastSeen,
          trigger: sc.trigger || {},
          record: {
            topic: displayTopic(sc, files[i]),
            sidecar: sc,
            lessons: bullets
          },
          snippet: bullets.slice(0, 2).join('; ').slice(0, 220),
          provenance: labels,
          plannerSnippet: plannerSnippetFor(bullets, labels),
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
      if (sc.id === ref || files[i].name.replace(/\.md$/, '') === ref || (sc.topic && sc.topic === ref)) {
        return {
          ref: sc.id,
          topic: displayTopic(sc, files[i]),
          content: content,
          sidecar: sc,
          lessons: parseBullets(content),
          provenance: labelsFor(sc, parseBullets(content))
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
        title: displayTopic(sc, files[i]),
        // Two records can share a title (one goal, two failure modes); their
        // storage names cannot, so an export writes both, not one over the other.
        filename: files[i].name,
        count: sc.count || 1,
        lastSeen: sc.lastSeen,
        trigger: sc.trigger || {},
        sources: sc.sources || [],
        provenance: labelsFor(sc, bullets),
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

module.exports = { createLessonsStore: createLessonsStore, canonicalArgs: canonicalArgs, UnsupportedArgsError: UnsupportedArgsError };
