'use strict';

// Memory facade — wires all stores together
// Created by lifecycle during boot, injected into cortex/brain/etc.

const { createFsStore } = require('./fs-store');
const { createEpisodicStore } = require('./episodic');
const { createSemanticStore } = require('./semantic');
const { createSkillsStore } = require('./skills');
const { createWorkingMemory } = require('./working');
const { createAuditWriter } = require('./audit-writer');
const { createCheckpointStore } = require('./checkpoints');

function createMemory({ config, bus, logger }) {
  const vaultRoot = () => config.MYTHOS_VAULT_ROOT || './vault';
  const fs = createFsStore(vaultRoot);

  const episodic = createEpisodicStore({ fs, config, bus, logger });
  const semantic = createSemanticStore({ fs, config, bus, logger });
  const skills = createSkillsStore({ fs, config, bus, logger });
  const audit = createAuditWriter({ fs, config, bus, logger });
  const checkpoints = createCheckpointStore({ fs, config, bus, logger });
  const working = createWorkingMemory({ fs, config, bus, logger, episodic });

  return {
    fs,
    episodic,
    semantic,
    skills,
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
      await audit.init();
      await checkpoints.init();
      await working.init();
    },

    async consolidate(opts) {
      opts = opts || {};
      // 1. Flush working memory → episodic
      await working.flushToEpisodic();

      // 2. Decay old episodic files
      const pruned = episodic.prune();
      if (pruned > 0) {
        bus.emit('memory.decay', { pruned: pruned });
      }

      // 3. Stats
      return {
        episodic: episodic.stats(),
        semantic: semantic.stats(),
        skills: skills.stats(),
        working: working.stats()
      };
    },

    stats() {
      return {
        episodic: episodic.stats(),
        semantic: semantic.stats(),
        skills: skills.stats(),
        working: working.stats(),
        audit: audit.stats()
      };
    }
  };
}

module.exports = { createMemory };
