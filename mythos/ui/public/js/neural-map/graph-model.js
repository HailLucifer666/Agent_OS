// graph-model.js — PURE: (stats, liveCounters) -> {nodes, edges}. No DOM, no
// canvas, no fetch — node:test-able in isolation. The map's density grows from
// REAL vault data: an empty vault yields exactly 6 module nodes + 6 edges around
// the core; memory clusters and breaker nodes appear only when the data does.

export const MODULE_IDS = ['goals', 'kanban', 'pipeline', 'memory', 'health', 'audit'];

const MEMORY_CLUSTERS = ['episodic', 'semantic', 'skills', 'identity'];

// weight: 1 = baseline visual size; grows with sqrt so a 10x-lived vault reads
// denser without any single node swallowing the screen.
function weightFromCount(count) {
  return 1 + Math.sqrt(Math.max(0, count)) * 0.35;
}

/**
 * @param {object|null} stats        /api/stats snapshot (null before first fetch)
 * @param {object} [live]            in-session counters/state layered on top:
 *   { goalDelta, kanbanDelta, pipelineDelta, auditDelta,
 *     breakers: { [name]: 'closed'|'half-open'|'open' }, degraded }
 * @returns {{ nodes: Array, edges: Array }}
 */
export function buildGraph(stats, live) {
  live = live || {};
  const s = stats || {
    memory: { episodic: { count: 0 }, semantic: { count: 0 }, skills: { count: 0 }, identity: { count: 0 }, audit: { count: 0 } },
    goals: { total: 0, active: 0, completed: 0 },
    kanban: { total: 0, byLane: {} },
    pipeline: { total: 0, byStage: {} },
  };

  const memCounts = MEMORY_CLUSTERS.map((k) => (s.memory[k] && s.memory[k].count) || 0);
  const memTotal = memCounts.reduce((a, b) => a + b, 0);
  const auditCount = ((s.memory.audit && s.memory.audit.count) || 0) + (live.auditDelta || 0);
  const breakerNames = Object.keys(live.breakers || {});
  const openBreakers = breakerNames.filter((n) => live.breakers[n] !== 'closed').length;

  const nodes = [
    { id: 'core', type: 'core', label: 'MYTHOS', weight: 2.2, degraded: !!live.degraded },
    { id: 'goals', type: 'module', label: 'GOALS', weight: weightFromCount(s.goals.total + (live.goalDelta || 0)), meta: s.goals },
    { id: 'kanban', type: 'module', label: 'KANBAN', weight: weightFromCount(s.kanban.total + (live.kanbanDelta || 0)), meta: s.kanban },
    { id: 'pipeline', type: 'module', label: 'PIPELINE', weight: weightFromCount(s.pipeline.total + (live.pipelineDelta || 0)), meta: s.pipeline },
    { id: 'memory', type: 'module', label: 'MEMORY', weight: weightFromCount(memTotal), meta: { total: memTotal } },
    { id: 'health', type: 'module', label: 'HEALTH', weight: weightFromCount(openBreakers), meta: { openBreakers } },
    { id: 'audit', type: 'module', label: 'AUDIT', weight: weightFromCount(auditCount), meta: { count: auditCount } },
  ];

  const edges = MODULE_IDS.map((id) => ({ from: 'core', to: id, kind: 'trunk' }));

  // 0-4 memory clusters — appear only once that store has real entries.
  MEMORY_CLUSTERS.forEach((k, i) => {
    const count = memCounts[i];
    if (count > 0) {
      nodes.push({ id: `mem-${k}`, type: 'memory-cluster', label: k.toUpperCase(), weight: weightFromCount(count) * 0.6, meta: { count } });
      edges.push({ from: 'memory', to: `mem-${k}`, kind: 'branch' });
    }
  });

  // 0-N breaker nodes — from the live 'health' broadcast, colored by state.
  breakerNames.forEach((name) => {
    nodes.push({ id: `brk-${name}`, type: 'breaker', label: name, weight: 0.7, state: live.breakers[name] });
    edges.push({ from: 'health', to: `brk-${name}`, kind: 'branch' });
  });

  return { nodes, edges };
}
