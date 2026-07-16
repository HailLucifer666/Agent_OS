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

  // ---- semantic recall layer (vector indexes over episodic + semantic) ----
  // Existing sync recall() on each store is untouched (tests + callers keep
  // their shape); embedding happens fire-and-forget on write, and the async
  // recallHybrid() facade below fuses keyword + vector rankings. Embeddings
  // unavailable -> hybrid degrades to exactly the keyword behavior.
  // Intentionally NOT indexed: skills/identity/audit are browsed, not searched (Phase 1 scope decision).
  const vecIndexes = {
    episodic: createVectorIndex({ fs, store: 'episodic' }),
    semantic: createVectorIndex({ fs, store: 'semantic' }),
  };

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

  return {
    fs,
    episodic,
    semantic,
    skills,
    identity,
    audit,
    checkpoints,
    working,

    async init() {
      // Ensure all store directories exist
      const dirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
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
      fs.ensureDir(fs.vaultPath('Index'));
      vecIndexes.episodic.init();
      vecIndexes.semantic.init();
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
        for (const storeName of ['episodic', 'semantic']) {
          const hits = vecIndexes[storeName].search(q, limit);
          for (const h of hits) {
            if (h.score < VECTOR_MIN_SCORE) continue;
            const store = storeName === 'episodic' ? episodic : semantic;
            let rec = null;
            try { rec = store.get(h.ref); } catch { /* pruned/archived ref */ }
            if (!rec) continue;
            const record = rec.record || rec;
            vector.push({
              ref: h.ref,
              score: h.score,
              record,
              snippet: String(record.summary || rec.snippet || '').slice(0, 200),
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
