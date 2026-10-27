'use strict';

// Memory facade — wires all stores together
// Created by lifecycle during boot, injected into cortex/brain/etc.

const { createFsStore } = require('./fs-store');
const { createEpisodicStore } = require('./episodic');
const { createSemanticStore } = require('./semantic');
const { createHabitPromoter } = require('./habit-promoter');
const { createSkillsStore } = require('./skills');
const { createIdentityStore } = require('./identity');
const { createWorkingMemory } = require('./working');
const { createAuditWriter } = require('./audit-writer');
const { createCheckpointStore } = require('./checkpoints');
const { createDocumentsStore } = require('./documents');
const { createLessonsStore } = require('./lessons');
const { provenanceOf, HYPOTHESIS } = require('./provenance');
const { createNotesStore } = require('./notes');
const { createVectorIndex, rrfMerge } = require('./vector-index');
const embeddings = require('../../../providers/embeddings');

function createMemory({ config, bus, logger, brain }) {
  const vaultRoot = () => config.MYTHOS_VAULT_ROOT || './vault';
  const fs = createFsStore(vaultRoot, bus);

  const episodic = createEpisodicStore({ fs, config, bus, logger });
  const semantic = createSemanticStore({ fs, config, bus, logger });
  const skills = createSkillsStore({ fs, config, bus, logger });
  const identity = createIdentityStore({ fs, config, bus, logger });
  const audit = createAuditWriter({ fs, config, bus, logger });
  const checkpoints = createCheckpointStore({ fs, config, bus, logger });
  const working = createWorkingMemory({ fs, config, bus, logger, episodic, checkpoints });
  const documents = createDocumentsStore({ fs });
  // Lessons — durable failure memory. The missing half of the learning loop:
  // reflectOnActions/distillFailureIntoLesson/log_incident write here; the goal
  // planner reads here BEFORE its brain call so a known-bad approach is grounded
  // against instead of re-tried. See lessons.js for the full rationale.
  const lessons = createLessonsStore({ fs, config, bus, logger });
  // Notes — the operator's own markdown documents (Obsidian-compatible), NOT
  // MYTHOS's asserted facts. MYTHOS_NOTES_DIR lets the operator point this at
  // an existing Obsidian vault; default keeps it inside the MYTHOS vault so a
  // fresh clone works with no configuration. Path is derived, never literal.
  const notes = createNotesStore({
    dir: (config && config.MYTHOS_NOTES_DIR) ? config.MYTHOS_NOTES_DIR : fs.vaultPath('Notes'),
  });

  // F9: writes through the semantic store, so it is constructed after it and
  // holds no store of its own — a promoted habit IS a semantic fact, not a
  // fourth place facts can live.
  const habits = createHabitPromoter({ semantic, logger });

  // ---- semantic recall layer (vector indexes over episodic + semantic + documents) ----
  // Existing sync recall() on each store is untouched (tests + callers keep
  // their shape); embedding happens fire-and-forget on write, and the async
  // recallHybrid() facade below fuses keyword + vector rankings. Embeddings
  // unavailable -> hybrid degrades to exactly the keyword behavior.
  // Intentionally NOT indexed: skills/identity/audit are browsed, not searched (Phase 1 scope decision).
  //
  // `documents` (§7.5 Document RAG + §7.11 code search) is the ONLY new
  // vector-index partition added by that work — both uploaded prose chunks
  // (from-documents.js) and indexed source-code chunks (from-code-search.js)
  // write into this SAME partition, differentiated by the `sourceType` field
  // on each chunk record (see memory/documents.js), not by a second
  // createVectorIndex(...) call. Do not add another one.
  const vecIndexes = {
    episodic: createVectorIndex({ fs, store: 'episodic' }),
    semantic: createVectorIndex({ fs, store: 'semantic' }),
    documents: createVectorIndex({ fs, store: 'documents' }),
  };
  const RECALL_STORES = { episodic: episodic, semantic: semantic, documents: documents };

  function indexAsync(store, ref, text) {
    if (!ref || !text) return;
    embeddings.embed(text)
      .then((e) => { if (e) vecIndexes[store].add(ref, e); })
      .catch(() => { /* embedding is a cache-fill — never surfaces */ });
  }

  const baseEpisodicWrite = episodic.write;
  episodic.write = function(record) {
    const res = baseEpisodicWrite(record);
    Promise.resolve(res)
      .then((r) => { if (r && r.ref) indexAsync('episodic', r.ref, record && record.summary); })
      .catch(() => {});
    return res;
  };

  const baseSemanticWrite = semantic.write;
  semantic.write = function(topic, facts, meta) {
    const res = baseSemanticWrite(topic, facts, meta);
    Promise.resolve(res)
      .then((r) => {
        if (r && r.ref) indexAsync('semantic', r.ref, Array.isArray(facts) ? facts.join('; ') : String(facts || ''));
      })
      .catch(() => {});
    return res;
  };

  const VECTOR_MIN_SCORE = 0.5;

  // V10 (Phase 4): scan existing Semantic/consolidated-*.md topics, find
  // near-duplicates + contradictions via one bounded brain call, rewrite them
  // as a single canonical topic. The previous flow wrote a fresh
  // consolidated-<ts> topic per pass with no dedup/merge, so the same fact
  // accumulated N times and stale facts never got reconciled.
  //
  // Idle-skip: only fires when there are >= CONSOLIDATE_MERGE_MIN (default 3)
  // consolidated-* topics accumulating. Returns silently otherwise.
  // Best-effort: any failure (no brain, brain offline, parse fail, fs error)
  // returns null and never blocks consolidation.
  async function mergeConsolidatedTopics() {
    if (!brain || typeof brain.think !== 'function') return null;
    if (!fs || typeof fs.listFiles !== 'function') return null;
    const minTopics = (config && typeof config.CONSOLIDATE_MERGE_MIN === 'number')
      ? config.CONSOLIDATE_MERGE_MIN : 3;

    // Gather existing consolidated-* topics with their facts.
    var topics = [];
    try {
      var files = fs.listFiles('Semantic', '.md');
      for (var i = 0; i < files.length; i++) {
        if (!/^consolidated-/i.test(files[i].name)) continue;
        var content = fs.readText(files[i].path, '');
        if (!content) continue;
        // Reuse semantic's parse helpers via a fresh call (they're scoped inside
        // the semantic closure, so we just pull bullets out with a regex here).
        var bullets = [];
        var m;
        var re = /^-\s+(.+)$/gm;
        while ((m = re.exec(content)) !== null) bullets.push(m[1].trim());
        // BUG-451 closure: remember whether any input was already a hypothesis, so the merge
        // below cannot launder it by rewording (the merger returns plain strings with no
        // way to say which input each came from).
        var seen = semantic.topic(files[i].name.replace(/\.md$/, ''));
        var doubted = !!(seen && seen.provenance && seen.provenance.indexOf(HYPOTHESIS) !== -1);
        if (bullets.length > 0) topics.push({ file: files[i].path, facts: bullets, doubted: doubted });
      }
    } catch (_) { return null; }

    if (topics.length < minTopics) return null;

    // Compact the topic facts for the brain prompt.
    var flatFacts = [];
    topics.forEach(function (t, ti) {
      t.facts.forEach(function (f) { flatFacts.push('[' + (ti + 1) + '] ' + f); });
    });
    var factBlock = flatFacts.join('\n');

    var result;
    try {
      result = await brain.think({
        lane: 'memory',
        messages: [{ role: 'user', content:
          'You are consolidating a knowledge base. Below are facts drawn from ' +
          topics.length + ' previously-distilled memory snapshots (the [N] tag ' +
          'marks which snapshot each fact came from).\n\n' +
          factBlock + '\n\n' +
          'Merge them into a canonical set. Rules:\n' +
          '1. DEDUP: combine near-identical facts into one (e.g. "user prefers dark mode" x3 -> one bullet).\n' +
          '2. CONTRADICT: when two facts conflict, KEEP the more recent/specific one and DROP the stale one. ' +
          'If you cannot tell which is newer, keep BOTH but mark the conflict with "(conflicts with: ...)".\n' +
          '3. PRESERVE: do not invent new facts. Only facts that appear above may appear in the output.\n\n' +
          'Respond as JSON: {"facts": ["merged fact 1", "merged fact 2", ...], "dropped": ["one short note on what was dropped/merged, optional"]}\n' +
          'If everything is already unique, return the same facts unchanged.'
        }],
        schemaHint: '{ facts: string[], dropped?: string[] }',
        source: 'memory:consolidate-merge'
      });
    } catch (_) { return null; }
    if (!result || result.offline || result.aborted || !result.parsed) return null;
    var mergedFacts = Array.isArray(result.parsed.facts) ? result.parsed.facts : [];
    if (mergedFacts.length === 0) return null;

    // Rewrite: write the merged topic FIRST and verify it actually landed,
    // THEN delete the old consolidated-* source files.
    //
    // B8: this used to delete the sources, then call semantic.write() — but
    // semantic.write() never throws on a write failure, it swallows the error
    // and returns { ref: null, degraded: true }, so the old try/catch around
    // it never caught anything. Any write failure (disk full, permissions,
    // etc.) therefore permanently destroyed every distilled user-fact topic,
    // with nothing left to show for it. This was never a "single atomic
    // swap" despite the old comment — it was two independent steps in the
    // wrong order. Now: write first, throw loudly if it didn't really
    // succeed, and only delete the sources once the replacement is confirmed
    // on disk.
    let writeResult;
    try {
      writeResult = semantic.write('consolidated-' + Date.now(), mergedFacts, {
        confidence: 0.7,
        sources: topics.map(function (t) { return t.file; }),
        inferred: topics.some(function (t) { return t.doubted; })
      });
    } catch (err) {
      throw new Error('mergeConsolidatedTopics: semantic.write threw: ' + err.message);
    }
    if (!writeResult || writeResult.degraded || !writeResult.ref) {
      throw new Error('mergeConsolidatedTopics: semantic.write failed — refusing to delete source topics');
    }
    topics.forEach(function (t) { fs.removeFile(t.file); });

    bus.emit('memory.merged', {
      inputTopics: topics.length,
      inputFacts: flatFacts.length,
      outputFacts: mergedFacts.length
    });
    return { merged: topics.length, facts: mergedFacts.length };
  }

  return {
    fs,
    episodic,
    semantic,
    skills,
    identity,
    audit,
    checkpoints,
    working,
    documents,                          // §7.5/§7.11 chunk store — shared by both
    documentsIndex: vecIndexes.documents, // the ONE shared vector-index partition
    lessons,                            // durable failure memory (learning loop)
    notes,                              // operator-owned Obsidian-compatible markdown notes
    habits,                             // F9: repeated actions -> durable facts (dispatch-action)

    async init() {
      // Ensure all store directories exist
      const dirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints', 'Documents', 'Lessons'];
      for (let i = 0; i < dirs.length; i++) {
        fs.ensureDir(fs.vaultPath(dirs[i]));
      }

      await episodic.init();
      await semantic.init();
      await skills.init();
      await identity.init();
      await audit.init();
      await checkpoints.init();
      await working.init();
      await lessons.init();
      fs.ensureDir(fs.vaultPath('Index'));
      vecIndexes.episodic.init();
      vecIndexes.semantic.init();
      vecIndexes.documents.init();
    },

    // Hybrid recall: keyword scorer (both stores, unchanged) fused with
    // vector-similarity hits via reciprocal-rank fusion. Async because the
    // query embedding is a network/local-model call; embeddings down ->
    // pure keyword results, same shape.
    async recallHybrid(query, opts) {
      opts = opts || {};
      const limit = opts.limit || 10;
      const keyword = (episodic.recall(query, opts) || []).concat(semantic.recall(query, opts) || []);
      const vector = [];
      const q = await embeddings.embed(query);
      if (q) {
        // documents (§7.5/§7.11) is a THIRD source in this same fan-out —
        // added here, not as a parallel recall path. RECALL_STORES maps each
        // vecIndexes partition name to the real store it's backed by.
        for (const storeName of ['episodic', 'semantic', 'documents']) {
          const hits = vecIndexes[storeName].search(q, limit);
          const store = RECALL_STORES[storeName];
          // BUG-436: one walk for all of this store's hits. Per-hit get() re-read
          // the whole month of Episodic each time — 8 hits, 1.4 s of blocked loop.
          let batch = null;
          if (typeof store.getMany === 'function') {
            try { batch = store.getMany(hits.filter((h) => h.score >= VECTOR_MIN_SCORE).map((h) => h.ref)); } catch { /* falls back to get() below */ }
          }
          for (const h of hits) {
            if (h.score < VECTOR_MIN_SCORE) continue;
            let rec = null;
            try { rec = batch ? (batch.get(h.ref) || null) : store.get(h.ref); } catch { /* pruned/archived ref */ }
            if (!rec) continue;
            const record = rec.record || rec;
            // FIX G: keyword-path exclusion happens inside episodic.recall() —
            // the vector path bypasses that (fetches straight from the store),
            // so apply the same excludeKinds filter here.
            if (opts.excludeKinds && opts.excludeKinds.indexOf(record.kind) !== -1) continue;
            vector.push({
              ref: h.ref,
              score: h.score,
              record,
              snippet: String(record.summary || record.text || rec.snippet || '').slice(0, 200),
              store: storeName,
            });
          }
        }
      }
      return rrfMerge([keyword, vector]).slice(0, limit);
    },

    // One-time backfill: embed recent episodic entries into the index.
    // Sequential on purpose (local model, ~ms each); capped to the newest 500.
    async reindex(opts) {
      opts = opts || {};
      const windowDays = opts.windowDays || 30;
      const sinceDate = new Date(Date.now() - windowDays * 24 * 3600000);
      const since = sinceDate.getFullYear() + '-' +
        String(sinceDate.getMonth() + 1).padStart(2, '0') + '-' +
        String(sinceDate.getDate()).padStart(2, '0');
      const entries = (fs.readDirLines('Episodic', { since, until: fs.todayKey() }) || [])
        .filter((e) => e && e.id && e.summary)
        .slice(-500);
      let indexed = 0;
      for (const entry of entries) {
        const e = await embeddings.embed(entry.summary);
        if (!e) break; // embeddings down — stop honestly, report what we did
        vecIndexes.episodic.add(entry.id, e);
        indexed++;
      }
      vecIndexes.episodic.flush();
      return { scanned: entries.length, indexed };
    },

    async consolidate(opts) {
      opts = opts || {};

      // 1. Flush working memory → episodic (context snapshot for crash recovery)
      await working.flushToEpisodic();

      // 2. Each store consolidates itself — archives, never permanently deletes (see D-18)
      const episodicResult = episodic.consolidate();
      const semanticResult = semantic.consolidate();
      identity.consolidate();
      skills.consolidate();
      audit.consolidate();
      if (episodicResult.archived > 0) {
        bus.emit('memory.decay', { pruned: episodicResult.archived });
      }

      // 3. Episodic → semantic distillation via Brain 'simple' lane — best-effort,
      // skips cleanly if Brain is offline or unavailable.
      //
      // FIX-PLAN 3.1 (2026-08-17): every skip now says WHY on the bus
      // ('memory.consolidate-skip'), because "did distillation ever run" was
      // undiagnosable — a silent skip and a dead gate look identical in every
      // log. Diagnostic only: never an anomaly, never a failure.
      if (brain && typeof brain.think === 'function') {
        try {
          const tail = episodic.tail(20).filter(Boolean);
          if (tail.length === 0) {
            bus.emit('memory.consolidate-skip', { reason: 'episodic-tail-empty', detail: 'no recent episodic entries to distill' });
          } else {
            const highSalience = tail.filter(function(e) { return (e.salience || 0) > 0.5; });
            if (highSalience.length === 0) {
              bus.emit('memory.consolidate-skip', { reason: 'no-high-salience', detail: tail.length + ' recent entries, none above 0.5' });
            } else {
              const summaryText = highSalience.map(function(e) { return '- ' + (e.summary || ''); }).join('\n');
              // lane 'memory' (2026-08-14) — split off 'simple' for LOAD as much
              // as quality: consolidation is one of the two frequent brain
              // consumers and shared Groq's 12k-token window with everything else.
              // Terse styling follows this lane by default (schema.js's
              // BRAIN_TERSE_LANES = 'simple,memory'), so summaries stay compact.
              const result = await brain.think({
                lane: 'memory',
                messages: [{ role: 'user', content: 'Distill these recent high-salience memories into durable facts:\n' + summaryText }],
                source: 'memory:consolidate'
              });
              if (!result || result.offline || !result.content) {
                bus.emit('memory.consolidate-skip', {
                  reason: 'brain-offline',
                  detail: result && result.offline ? 'think() reported offline' : 'think() returned no content',
                });
              } else {
                try {
                  // BUG-451 closure (2026-10-06): the 09-23 consolidated memory repeated the false
                  // cause, and the model's rewrite carried no cause marker ("...(rapid re-rendering)
                  // is resolved"), so the shape rule alone cannot see it. A distilled fact inherits
                  // the doubt of what it was distilled from: if any record it drew on already
                  // carried a hypothesis label (a thought whose text states a cause or a
                  // limitation) or states one by today's rule, the fact is stored as a hypothesis.
                  // A NEUTRAL thought does not count on its own (review, 2026-10-27): thoughts are
                  // frequent, and labelling every distillation would make the tag meaningless.
                  // Conversation turns and sensor perceptions are the operator's words and the
                  // world's, and do not count either.
                  // Over-labels (one doubtful line doubts the whole distillation) - the
                  // safe direction; the opposite error is the one the ticket is about.
                  const inheritsDoubt = highSalience.some(function(e) {
                    return e.provenance === HYPOTHESIS ||
                      (e.kind !== 'conversation' && e.kind !== 'perception' && provenanceOf(e.summary) === HYPOTHESIS);
                  });
                  semantic.write('consolidated-' + Date.now(), [result.content], {
                    confidence: 0.6,
                    sources: highSalience.map(function(e) { return e.id; }),
                    inferred: inheritsDoubt
                  });
                } catch (writeErr) {
                  bus.emit('memory.consolidate-skip', { reason: 'semantic-write-failed', detail: writeErr && writeErr.message });
                }
              }
            }
          }
        } catch (err) {
          // Brain distillation is best-effort — never block consolidation on it
          bus.emit('memory.consolidate-skip', { reason: 'think-threw', detail: err && err.message });
        }

        // 3b. Conversation → user-facts distillation: mine recent conversation
        // turns specifically for durable facts about the operator (preferences,
        // ongoing projects, working style). Separate from the general distillation
        // above because conversations have different structure (user said / entity
        // replied) and warrant a different extraction prompt. Results land in
        // Semantic/user-facts.md, recalled by the server's recall-before-respond.
        //
        // BUG-463 (2026-09-25, operator decision "turn it off"): OFF unless
        // MEMORY_AUTO_USER_FACTS=true. On 09-23 this turned one day of bug testing into
        // "The user is currently working on ... bugs 439, 441, 442", which then rode
        // into every voice session as a durable fact, and MYTHOS kept steering chat
        // back to bugs. Its prompt already said "only facts still true tomorrow". Also
        // the write BUG-464 left open: it saved facts about the operator nobody asked
        // for. The operator's own `remember` requests are untouched (BUG-464's lock).
        if (process.env.MEMORY_AUTO_USER_FACTS !== 'true') {
          bus.emit('memory.consolidate-skip', { reason: 'auto-user-facts-off', detail: 'MEMORY_AUTO_USER_FACTS is not "true": no user-facts are written from conversation' });
        } else try {
          const convos = episodic.recall('', { kind: 'conversation', limit: 20, windowDays: 1 });
          // Only distill if there are NEW conversations since last consolidation
          // (avoid re-processing the same turns every cycle). Heuristic: need at
          // least 3 conversation entries to bother the brain.
          if (convos.length >= 3) {
            const convoText = convos.map(function(c) { return '- ' + (c.record.summary || ''); }).join('\n');
            const result = await brain.think({
              lane: 'memory',
              messages: [{ role: 'user', content:
                'Extract durable facts about the user from these conversation excerpts.\n' +
                'Only include facts that will still be true tomorrow: preferences, ongoing projects, ' +
                'working style, recurring topics, skill level. Ignore transient requests and one-off actions.\n' +
                'Respond as JSON: {"facts": ["fact 1", "fact 2"]}\n' +
                'If there are no durable facts, return {"facts": []}.\n\n' + convoText
              }],
              schemaHint: '{ facts: string[] }',
              source: 'memory:consolidate-user-facts'
            });
            if (result && !result.offline && result.parsed && Array.isArray(result.parsed.facts)) {
              for (let i = 0; i < result.parsed.facts.length; i++) {
                var fact = String(result.parsed.facts[i]).trim();
                if (fact) semantic.write('user-facts', [fact], { confidence: 0.7, append: true });
              }
            }
          }
        } catch (_) {
          // Conversation distillation is best-effort — never block consolidation
        }

        // 3c. V10 (Phase 4): consolidate-* dedup + contradiction handling.
        // Each prior consolidation pass wrote a fresh consolidated-<ts> topic.
        // Over time these accumulate near-duplicates ("the user likes dark mode"
        // x N) and occasionally contradictions ("user uses Vim" vs "user uses
        // Emacs"). One bounded brain call on the 'simple' lane scans them all,
        // returns a merged set, and we rewrite them as a single canonical topic.
        // Idle-skip: only runs when there are >= 3 consolidated topics
        // accumulating, AND respects the existing stagger (brain was already
        // used at most once above). Best-effort: never blocks consolidation.
        try {
          await mergeConsolidatedTopics();
        } catch (err) {
          // B8: mergeConsolidatedTopics() now throws loudly instead of
          // silently deleting source topics on a failed write — consolidation
          // as a whole still stays best-effort, but the failure must be
          // visible rather than vanishing into an empty catch.
          bus.emit('health.anomaly', { kind: 'consolidate-merge-failed', error: err.message });
        }
      } else {
        // FIX-PLAN 3.1: the brain-missing skip used to be indistinguishable
        // from every other silent skip (see the step-3 comment).
        bus.emit('memory.consolidate-skip', { reason: 'brain-missing', detail: 'no brain.think available' });
      }

      // 4. Stats
      return {
        episodic: episodic.stats(),
        semantic: semantic.stats(),
        skills: skills.stats(),
        identity: identity.stats(),
        working: working.stats()
      };
    },

    stats() {
      return {
        episodic: episodic.stats(),
        semantic: semantic.stats(),
        skills: skills.stats(),
        identity: identity.stats(),
        working: working.stats(),
        audit: audit.stats()
      };
    }
  };
}

module.exports = { createMemory };
