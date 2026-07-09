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

function createMemory({ config, bus, logger, brain }) {
  const vaultRoot = () => config.MYTHOS_VAULT_ROOT || './vault';
  const fs = createFsStore(vaultRoot, bus);

  const episodic = createEpisodicStore({ fs, config, bus, logger });
  const semantic = createSemanticStore({ fs, config, bus, logger });
  const skills = createSkillsStore({ fs, config, bus, logger });
  const identity = createIdentityStore({ fs, config, bus, logger });
  const audit = createAuditWriter({ fs, config, bus, logger });
  const checkpoints = createCheckpointStore({ fs, config, bus, logger });
  const working = createWorkingMemory({ fs, config, bus, logger, episodic });

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
    },

    async consolidate(opts) {
      opts = opts || {};

      // 1. Flush working memory → episodic (context snapshot for crash recovery)
      await working.flushToEpisodic();

      // 2. Each store consolidates itself — archives, never permanently deletes (see D-18)
      const episodicResult = episodic.consolidate();
      const semanticResult = semantic.consolidate();
      identity.consolidate();
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
