'use strict';

// immune/probes.js — status aggregation. RW of NOVA app/lib/probes.js, heavily
// simplified because mythos/src/core/brain/registry.js already centralizes provider
// aliveness (NOVA's version had to ping ollama/edge-tts/claude-cli ad hoc).
//
// getStatus() is a hot path polled every 4s by the metric sensor AND has a
// documented side effect: it emits 'health.anomaly' for provider-down / quota-low
// conditions, since nothing else in shipped code produces those two kinds
// (Spec Ambiguities Resolved #8). This module does NOT deduplicate — healer.js's
// per-playbook cooldownMs is the only heal-storm suppressor, by design.

const registry = require('../brain/registry');
const spend = require('../brain/spend');
const quota = require('../quota');

const DOWN_CAPABLE = ['nim', 'groq', 'mistral']; // ollama is local/optional — never "down"

function isProviderDown(id, registryStatus) {
  if (id === 'nim') return registryStatus.nim.configured > 0 && registryStatus.nim.aliveModels === 0;
  if (id === 'groq') return !registryStatus.groq.alive;
  if (id === 'mistral') return !registryStatus.mistral.alive;
  return false;
}

function createProbes({ bus, config }) {
  if (!bus) throw new Error('createProbes requires bus');

  async function getStatus() {
    const registryStatus = await registry.getStatus();
    const stats = spend.getStats();
    const quotas = quota.getAllQuotas(stats);

    for (let i = 0; i < DOWN_CAPABLE.length; i++) {
      const id = DOWN_CAPABLE[i];
      if (isProviderDown(id, registryStatus)) {
        // 'health.anomaly' — exact string, do not paraphrase.
        bus.emit('health.anomaly', { kind: 'provider-down', target: id, evidence: registryStatus[id] });
      }
    }

    for (let i = 0; i < quotas.length; i++) {
      const q = quotas[i];
      // remainingPercent is null for unlimited/untracked providers — must not
      // compare `null < 10` (coerces to 0 < 10 === true). See Spec Ambiguities #7.
      if (!q.unlimited && q.remainingPercent !== null && q.remainingPercent < 10) {
        bus.emit('health.anomaly', { kind: 'quota-low', target: q.provider, evidence: q });
      }
    }

    return { providers: registryStatus, quotas: quotas, probedAt: registryStatus.probedAt };
  }

  return { getStatus: getStatus };
}

module.exports = { createProbes: createProbes, isProviderDown: isProviderDown };
