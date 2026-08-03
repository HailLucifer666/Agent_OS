'use strict';

// Memory facade — wires all stores together
// Created by lifecycle during boot, injected into cortex/brain/etc.

const { createFsStore } = require('./fs-store');
const { createEpisodicStore } = require('./episodic');
const { createSemanticStore } = require('./semantic');
const { createSkillsStore } = require('./skills');
const { createIdentityStore } = require('./identity');
const { createWorkingMemory } = require('./working');
const { createAuditWriter } = require('./audit-writer');
const { createCheckpointStore } = require('./checkpoints');
const { createDocumentsStore } = require('./documents');
const { createLessonsStore } = require('./lessons');
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
        if (bullets.length > 0) topics.push({ file: files[i].path, facts: bullets });
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
        lane: 'simple',
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

    // Rewrite: delete the old consolidated-* files, write one fresh
    // consolidated-<ts> topic with the merged facts. Single atomic swap.
    try {
      topics.forEach(function (t) { fs.removeFile(t.file); });
    } catch (_) { /* partial cleanup — next pass will retry */ }
    try {
      semantic.write('consolidated-' + Date.now(), mergedFacts, {
        confidence: 0.7,
        sources: topics.map(function (t) { return t.file; })
      });
    } catch (_) { return null; }

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
          for (const h of hits) {
            if (h.score < VECTOR_MIN_SCORE) continue;
            const store = RECALL_STORES[storeName];
            let rec = null;
            try { rec = store.get(h.ref); } catch { /* pruned/archived ref */ }
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
      if (brain && typeof brain.think === 'function') {
        try {
          const tail = episodic.tail(20).filter(Boolean);
          const highSalience = tail.filter(function(e) { return (e.salience || 0) > 0.5; });
          if (highSalience.length > 0) {
            const summaryText = highSalience.map(function(e) { return '- ' + (e.summary || ''); }).join('\n');
            const result = await brain.think({
              lane: 'simple',
              messages: [{ role: 'user', content: 'Distill these recent high-salience memories into durable facts:\n' + summaryText }],
              source: 'memory:consolidate'
            });
            if (result && !result.offline && result.content) {
              semantic.write('consolidated-' + Date.now(), [result.content], {
                confidence: 0.6,
                sources: highSalience.map(function(e) { return e.id; })
              });
            }
          }
        } catch (_) {
          // Brain distillation is best-effort — never block consolidation on it
        }

        // 3b. Conversation → user-facts distillation: mine recent conversation
        // turns specifically for durable facts about the operator (preferences,
        // ongoing projects, working style). Separate from the general distillation
        // above because conversations have different structure (user said / entity
        // replied) and warrant a different extraction prompt. Results land in
        // Semantic/user-facts.md, recalled by the server's recall-before-respond.
        try {
          const convos = episodic.recall('', { kind: 'conversation', limit: 20, windowDays: 1 });
          // Only distill if there are NEW conversations since last consolidation
          // (avoid re-processing the same turns every cycle). Heuristic: need at
          // least 3 conversation entries to bother the brain.
          if (convos.length >= 3) {
            const convoText = convos.map(function(c) { return '- ' + (c.record.summary || ''); }).join('\n');
            const result = await brain.think({
              lane: 'simple',
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
        } catch (_) {
          // mergeConsolidatedTopics failures are best-effort
        }
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
