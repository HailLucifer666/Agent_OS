'use strict';

// hud-model.test.js — pure-module tests for the P9 HUD's data layer:
// graph-model (stats -> nodes/edges), graph-layout (deterministic radial
// positions), panel-registry and widget-registry shape checks. These are ES
// modules (browser code) loaded via dynamic import from this CJS test file.

const { test, describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

function uiUrl(rel) {
  return pathToFileURL(path.join(__dirname, '..', 'ui', 'public', 'js', rel)).href;
}

let graphModel, graphLayout, panelRegistry, widgetRegistry;

before(async () => {
  graphModel = await import(uiUrl('neural-map/graph-model.js'));
  graphLayout = await import(uiUrl('neural-map/graph-layout.js'));
  panelRegistry = await import(uiUrl('overlay/panel-registry.js'));
  widgetRegistry = await import(uiUrl('widgets/widget-registry.js'));
});

function emptyStats() {
  return {
    memory: { episodic: { count: 0 }, semantic: { count: 0 }, skills: { count: 0 }, identity: { count: 0 }, audit: { count: 0 } },
    goals: { total: 0, active: 0, completed: 0 },
    kanban: { total: 0, byLane: {} },
    pipeline: { total: 0, byStage: {} },
  };
}

describe('graph-model (pure)', () => {
  it('empty vault -> exactly core + 7 module nodes and 7 trunk edges', () => {
    const { nodes, edges } = graphModel.buildGraph(emptyStats(), {});
    assert.equal(nodes.length, 8, '1 core + 7 modules, nothing else at first boot');
    assert.equal(edges.length, 7, 'exactly 7 core->module tendrils');
    assert.ok(nodes.find((n) => n.id === 'core' && n.type === 'core'));
    graphModel.MODULE_IDS.forEach((id) => {
      assert.ok(nodes.find((n) => n.id === id && n.type === 'module'), `module node ${id}`);
      assert.ok(edges.find((e) => e.from === 'core' && e.to === id), `trunk edge core->${id}`);
    });
  });

  it('null stats (pre-fetch) behaves like an empty vault', () => {
    const { nodes, edges } = graphModel.buildGraph(null, {});
    assert.equal(nodes.length, 8);
    assert.equal(edges.length, 7);
  });

  it('memory clusters appear only when store counts > 0, sized by sqrt(count)', () => {
    const stats = emptyStats();
    stats.memory.episodic.count = 100;
    stats.memory.semantic.count = 4;
    const { nodes, edges } = graphModel.buildGraph(stats, {});
    const episodic = nodes.find((n) => n.id === 'mem-episodic');
    const semantic = nodes.find((n) => n.id === 'mem-semantic');
    assert.ok(episodic && semantic, 'clusters with data appear');
    assert.equal(nodes.find((n) => n.id === 'mem-skills'), undefined, 'empty stores grow nothing');
    assert.ok(episodic.weight > semantic.weight, 'bigger store -> bigger cluster');
    assert.ok(edges.find((e) => e.from === 'memory' && e.to === 'mem-episodic'), 'cluster hangs off memory');
    // sqrt growth: 100 vs 4 entries is 10x vs 2x sqrt — weight ratio well under 25x
    assert.ok(episodic.weight / semantic.weight < 5, 'sqrt scaling keeps growth sublinear');
  });

  it('a live breaker adds exactly one breaker node with its state', () => {
    const base = graphModel.buildGraph(emptyStats(), {});
    const withBreaker = graphModel.buildGraph(emptyStats(), { breakers: { run_build: 'open' } });
    assert.equal(withBreaker.nodes.length, base.nodes.length + 1);
    const brk = withBreaker.nodes.find((n) => n.id === 'brk-run_build');
    assert.equal(brk.type, 'breaker');
    assert.equal(brk.state, 'open');
    assert.ok(withBreaker.edges.find((e) => e.from === 'health' && e.to === 'brk-run_build'));
  });

  it('live deltas raise module weights without a stats refetch', () => {
    const quiet = graphModel.buildGraph(emptyStats(), {});
    const busy = graphModel.buildGraph(emptyStats(), { goalDelta: 9, auditDelta: 16 });
    const w = (g, id) => g.nodes.find((n) => n.id === id).weight;
    assert.ok(w(busy, 'goals') > w(quiet, 'goals'));
    assert.ok(w(busy, 'audit') > w(quiet, 'audit'));
  });
});

describe('graph-layout (pure)', () => {
  it('is deterministic: same graph + viewport -> identical positions', () => {
    const graph = graphModel.buildGraph(emptyStats(), { breakers: { a: 'open', b: 'half-open' } });
    const a = graphLayout.layoutGraph(graph, 1280, 800);
    const b = graphLayout.layoutGraph(graph, 1280, 800);
    assert.equal(a.size, b.size);
    a.forEach((pos, id) => {
      assert.deepEqual(pos, b.get(id), `position for ${id} must be stable`);
    });
  });

  it('places the core at viewport center and every node inside the viewport', () => {
    const stats = emptyStats();
    stats.memory.episodic.count = 50;
    const graph = graphModel.buildGraph(stats, { breakers: { x: 'open' } });
    const pos = graphLayout.layoutGraph(graph, 1000, 700);
    const core = pos.get('core');
    assert.equal(core.x, 500);
    assert.equal(core.y, 350);
    graph.nodes.forEach((n) => {
      const p = pos.get(n.id);
      assert.ok(p, `every node gets a position (${n.id})`);
      assert.ok(p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 700, `${n.id} stays on screen`);
    });
  });

  it('module nodes sit on a shared radial ring', () => {
    const graph = graphModel.buildGraph(emptyStats(), {});
    const pos = graphLayout.layoutGraph(graph, 1000, 1000);
    const dists = graphModel.MODULE_IDS.map((id) => {
      const p = pos.get(id);
      return Math.hypot(p.x - 500, p.y - 500);
    });
    dists.forEach((d) => assert.ok(Math.abs(d - dists[0]) < 0.001, 'equal ring radius'));
  });
});

describe('panel-registry (pure)', () => {
  it('exposes the HUD panels with title + loader, no duplicates', () => {
    const ids = panelRegistry.panelIds();
    assert.deepEqual(new Set(ids), new Set(['goals', 'proposals', 'kanban', 'pipeline', 'memory', 'health', 'audit', 'backend', 'conversation', 'engagements', 'forge', 'web', 'mic-settings']));
    assert.equal(ids.length, new Set(ids).size, 'no duplicate panel ids');
    ids.forEach((id) => {
      const p = panelRegistry.getPanel(id);
      assert.equal(typeof p.title, 'string');
      assert.equal(typeof p.loader, 'function', `${id} loader is a thunk`);
      assert.equal(typeof p.mutating, 'boolean');
    });
    assert.equal(panelRegistry.getPanel('nonsense'), null);
  });
});

describe('widget-registry (pure)', () => {
  // BUG-176: defaultPos is gone — positions are computed from measured card
  // sizes by auto-layout.js, because .widget-card is content-sized and a
  // declared offset could never say whether two cards overlap. `column` is the
  // placement input now, and it is what has to be present on every entry.
  it('every widget has id/title/column/mount and ids are unique', () => {
    const { WIDGETS, widgetIds } = widgetRegistry;
    assert.ok(WIDGETS.length >= 7, 'clock/weather/agents/spend/wip/tick-rate/breakers');
    const ids = widgetIds();
    assert.equal(ids.length, new Set(ids).size, 'no duplicate widget ids');
    WIDGETS.forEach((w) => {
      assert.equal(typeof w.id, 'string');
      assert.equal(typeof w.title, 'string');
      assert.equal(typeof w.mount, 'function');
      assert.ok(['left', 'right'].includes(w.column), w.id + ' needs a column hint');
    });
  });
});
