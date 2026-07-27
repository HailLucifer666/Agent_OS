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

  function sync(nodes, readouts) {
    list.replaceChildren(...nodes.filter((n) => n.type !== 'core').map((n) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hud-a11y-node';
      const r = readouts.get(n.id) || {};
      btn.textContent = `${n.label}: ${r.value || n.state || ''}`;
      btn.addEventListener('click', () => onNodeClick(targetPanelId(n)));
      return btn;
    }));
  }

  return { sync, cleanup: () => list.remove() };
}
