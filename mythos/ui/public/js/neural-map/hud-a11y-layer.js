// hud-a11y-layer.js — visually-hidden DOM mirror of the canvas HUD's node
// graph: one <button> per module/breaker node, sr-only-until-focus, exposing
// the same label/value/click-to-open-panel affordance hud-canvas.js draws.
// A screen reader gets literally nothing from a bare <canvas> otherwise —
// this file does not reimplement graph/data logic, it only mirrors it into
// the accessibility tree. hud-canvas.js's rebuild() calls sync(nodes,
// readouts) once per rebuild — NOT once per animation frame — so this stays
// cheap regardless of the 60fps draw loop underneath it.
// A click on the real canvas doesn't always open a panel keyed by the hit
// node's own id — hud-canvas.js's onClick() redirects memory-cluster hits to
// the 'memory' panel and breaker hits to the 'health' panel (there's no
// per-cluster/per-breaker panel to open). The mirror must redirect the same
// way or a keyboard/AT user activating a cluster or breaker button would
// silently no-op instead of opening the panel a mouse click on that same
// node actually opens.
import { keyedList } from '../dom.js';

function targetPanelId(node) {
  if (node.type === 'memory-cluster') return 'memory';
  if (node.type === 'breaker') return 'health';
  return node.id;
}

export function mountHudA11yLayer(root, { onNodeClick }) {
  const list = document.createElement('div');
  list.className = 'hud-a11y-nodes sr-only-until-focus';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'HUD modules');
  root.appendChild(list);

  function labelText(node, readouts) {
    const r = readouts.get(node.id) || {};
    return `${node.label}: ${r.value || node.state || ''}`;
  }

  // renderFn: builds a brand-new button the first time a node id appears —
  // the only place the click listener gets bound (keyedList reuses this same
  // node on every later sync(), so the listener never accumulates). The
  // handler reads btn.dataset.panel rather than closing over `node` because
  // updateNode() below repaints that dataset on every sync() — same node,
  // fresh data — which keeps focus on this exact DOM element intact across
  // ticks instead of the old replaceChildren() that tore every button down
  // (and silently dropped keyboard/AT focus to <body>) on every 'tick' event.
  function renderNode(node, readouts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hud-a11y-node';
    btn.dataset.panel = targetPanelId(node);
    btn.textContent = labelText(node, readouts);
    btn.addEventListener('click', () => onNodeClick(btn.dataset.panel));
    return btn;
  }

  // updateFn: patches an existing (reused) button in place so a real value
  // change (e.g. "GOALS: 1 ACTIVE" -> "GOALS: 2 ACTIVE") still reaches the
  // accessibility tree — every write is guarded by an equality check so a
  // tick that changes nothing about this node causes zero DOM mutation, not
  // just zero node replacement (a redundant same-value setAttribute/
  // textContent write still fires a MutationObserver record otherwise).
  function updateNode(btn, node, readouts) {
    const panel = targetPanelId(node);
    if (btn.dataset.panel !== panel) btn.dataset.panel = panel;
    const next = labelText(node, readouts);
    if (btn.textContent !== next) btn.textContent = next;
  }

  function sync(nodes, readouts) {
    const items = nodes.filter((n) => n.type !== 'core');
    keyedList(list, items, (n) => n.id, (n) => renderNode(n, readouts), (btn, n) => updateNode(btn, n, readouts));
  }

  return { sync, cleanup: () => list.remove() };
}
