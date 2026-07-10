// graph-layout.js — PURE: deterministic radial positions for the neural map.
// Same layout for the same graph, every time (memory-galaxy's golden-angle
// pattern for satellite fans). No DOM/canvas — node:test-able in isolation.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5deg

/**
 * @param {{nodes: Array, edges: Array}} graph  from graph-model buildGraph()
 * @param {number} width
 * @param {number} height
 * @returns {Map<string, {x:number, y:number, r:number}>} id -> position/radius
 */
export function layoutGraph(graph, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const ringR = Math.min(width, height) * 0.30;
  const satR = Math.min(width, height) * 0.115;
  const unit = Math.min(width, height) / 55; // base node radius unit

  const pos = new Map();
  const modules = graph.nodes.filter((n) => n.type === 'module');

  graph.nodes.forEach((node) => {
    if (node.type === 'core') {
      pos.set(node.id, { x: cx, y: cy, r: unit * node.weight * 2.2 });
    }
  });

  // 6 module nodes on a fixed ring — evenly spaced with a half-step offset from
  // vertical, so no node sits at the exact top (reserved for the SYSTEM STATUS
  // readout) or exact bottom (reserved for the VOICE INTERFACE mic cluster) —
  // matching the reference mockup's compass positions. Deterministic: order
  // comes from graph-model's node order.
  modules.forEach((node, i) => {
    const angle = -Math.PI / 2 + ((i + 0.5) / modules.length) * Math.PI * 2;
    pos.set(node.id, {
      x: cx + Math.cos(angle) * ringR,
      y: cy + Math.sin(angle) * ringR,
      r: unit * node.weight,
      angle,
    });
  });

  // Satellites (memory clusters, breakers) fan outward from their parent module
  // along golden-angle offsets, pushed away from the core.
  const satsByParent = new Map();
  graph.edges.forEach((edge) => {
    if (edge.kind !== 'branch') return;
    if (!satsByParent.has(edge.from)) satsByParent.set(edge.from, []);
    satsByParent.get(edge.from).push(edge.to);
  });

  satsByParent.forEach((childIds, parentId) => {
    const parent = pos.get(parentId);
    if (!parent) return;
    const baseAngle = Math.atan2(parent.y - cy, parent.x - cx);
    childIds.forEach((id, i) => {
      const node = graph.nodes.find((n) => n.id === id);
      const spread = (i - (childIds.length - 1) / 2) * (GOLDEN_ANGLE / 4);
      const dist = satR * (1 + Math.floor(i / 5) * 0.5);
      pos.set(id, {
        x: parent.x + Math.cos(baseAngle + spread) * dist,
        y: parent.y + Math.sin(baseAngle + spread) * dist,
        r: unit * (node ? node.weight : 1) * 0.9,
      });
    });
  });

  return pos;
}
