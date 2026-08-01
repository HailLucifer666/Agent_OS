// hud-canvas.js — the full-screen neural map, drawn to match the JARVIS
// reference mockup: seeded ambient starfield (denser near the core), organic
// branching synapse tendrils with glowing stub tips, continuous "electron"
// particles flowing along every tendril, ring-icon satellite nodes with
// label/value/progress-underline blocks, and a SYSTEM STATUS readout.
//
// Data model comes from graph-model (pure), positions from graph-layout (pure);
// this file owns ONLY drawing + interaction. Density grows from /api/stats: the
// same organic treatment extends automatically to memory-cluster and breaker
// nodes as the vault's real data grows — no separate "densify" mode.
//
// Live FX contract (P9 brief):
//   tick        -> waveform pulse (core-orb) + tendril ripple + stats resync /100
//   perception  -> bright particle burst along channel-mapped tendril
//   action      -> tendril flash by tool prefix + always core->audit burst
//   health      -> breaker recolor + degraded flag
//   goal-update -> goals weight bump
//
// Plain 2D canvas, capped particle counts — a visual richness pass, not a
// simulation. No WebGL, no deps.

import { buildGraph } from './graph-model.js';
import { layoutGraph } from './graph-layout.js';
import { mountHudA11yLayer } from './hud-a11y-layer.js';

const RESYNC_EVERY_TICKS = 100;
const BG_DOT_COUNT = 60;           // reduced: the GlitterWrap flow field now carries ambient background dots; these remain as fixed center-biased twinkle depth
const ELECTRONS_PER_EDGE = 3;      // continuous ambient electrons per tendril
const PATH_SEGMENTS = 26;          // polyline resolution per tendril

const CHANNEL_TARGET = {
  file: 'memory', build: 'pipeline', job: 'pipeline', metric: 'health',
  voice: 'core', ws: 'core', timer: 'core',
};

const TOOL_PREFIX_TARGET = [
  ['kanban', 'kanban'], ['pipeline', 'pipeline'], ['goal', 'goals'],
  ['memory', 'memory'], ['recall', 'memory'], ['speak', 'core'], ['build', 'pipeline'],
];

function toolTarget(tool) {
  const t = String(tool || '').toLowerCase();
  for (const [prefix, target] of TOOL_PREFIX_TARGET) {
    if (t.includes(prefix)) return target;
  }
  return 'audit';
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// hex '#rrggbb' -> 'rgba(r,g,b,a)' — canvas gradients need explicit alpha stops
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// mulberry32 — tiny seeded PRNG so starfield/branch geometry is stable across
// frames and re-renders (flicker-free), yet organic.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let z = Math.imul(a ^ (a >>> 15), 1 | a);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- module node metadata -> value line + progress ratio (REAL data only) ----
function nodeReadout(node) {
  const m = node.meta || {};
  switch (node.id) {
    case 'goals': {
      const ratio = m.total ? (m.completed || 0) / m.total : null;
      return { value: `${m.active || 0} ACTIVE`, ratio };
    }
    case 'kanban': {
      const done = (m.byLane && m.byLane.done) || 0;
      return { value: `${m.total || 0} CARDS`, ratio: m.total ? done / m.total : null };
    }
    case 'pipeline': {
      const shipped = (m.byStage && m.byStage.shipped) || 0;
      return { value: `${m.total || 0} ITEMS`, ratio: m.total ? shipped / m.total : null };
    }
    case 'memory':
      return { value: `${m.total || 0} TRACES`, ratio: null };
    case 'health':
      return m.openBreakers > 0
        ? { value: `${m.openBreakers} OPEN`, ratio: null, danger: true }
        : { value: 'OPTIMAL', ratio: 1 };
    case 'audit':
      return { value: `${m.count || 0} DECISIONS`, ratio: null };
    default:
      return { value: '', ratio: null };
  }
}

const PAN_KEY = 'mythos.hud.pan.v1';

function loadPan() {
  try {
    const p = JSON.parse(localStorage.getItem(PAN_KEY)) || {};
    return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
  } catch { return { x: 0, y: 0 }; }
}

function savePan(pan) {
  try { localStorage.setItem(PAN_KEY, JSON.stringify({ x: Math.round(pan.x), y: Math.round(pan.y) })); } catch { /* quota — non-fatal */ }
}

export function mountHud(canvas, ctx) {
  const c2d = canvas.getContext('2d');
  // Cap DPR at 1.5: full-screen canvas with additive flow particles + tendrils per frame; 2x/3x DPR on retina is a fill-rate cliff for no visible gain.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Screen-reader mirror of the node graph — see hud-a11y-layer.js. Synced
  // once per rebuild() (below), never per animation frame; a no-op object if
  // #hud-a11y-root isn't present (e.g. a DOM-lite test harness).
  const a11yRoot = document.getElementById('hud-a11y-root');
  const a11yLayer = a11yRoot ? mountHudA11yLayer(a11yRoot, { onNodeClick: ctx.onNodeClick }) : { sync() {}, cleanup() {} };

  // Honest sub-480px degradation (Phase 6 responsive, scope call: tablet-down
  // graceful degradation, not phone support — see semantic.css's breakpoint
  // convention). Below 480px the canvas is hidden and this message shown
  // instead of a silently clipped/broken render; resize() toggles both.
  const narrowMsg = document.createElement('div');
  narrowMsg.className = 'hud-narrow-message';
  narrowMsg.textContent = 'MYTHOS HUD is designed for a wider screen — try a tablet or desktop view.';
  if (canvas.parentNode) canvas.parentNode.insertBefore(narrowMsg, canvas.nextSibling);

  let width = 0;
  let height = 0;
  // Phase 6 responsive tiers (see css/tokens/semantic.css's documented
  // convention: 1200 wide / 900 compact / 600 narrow). resize() sets both;
  // narrow simplifies node labels (drawLabelBlock below), tooNarrow swaps
  // the canvas for an honest degradation message instead of a broken render.
  let narrow = false;
  let stats = null;
  const live = { goalDelta: 0, kanbanDelta: 0, pipelineDelta: 0, auditDelta: 0, breakers: {}, degraded: false };
  let entityStatus = 'booting';
  let graph = buildGraph(null, live);
  let positions = new Map();
  let paths = new Map();     // edgeKey -> { points: [{x,y}], branches: [{points, tip}] }
  let hovered = null;
  let raf = null;
  let t = 0;
  let lastTime = 0;
  let voiceState = 'idle';   // idle | listening | processing | speaking (from app.js)
  let activity = 0;          // live voice amplitude 0..1 — drives ambient bloom boost

  // Constellation pan — drag empty canvas to move the ENTIRE node graph (core,
  // modules, clusters, tendrils, ripples) so widgets get breathing room. The
  // starfield, guide rings, and SYSTEM STATUS readout stay fixed. Persisted to
  // localStorage (same pattern as widget-host positions); hit-testing and the
  // DOM core-orb (via ctx.onPan) compensate with the same offset.
  const pan = loadPan();
  let panDrag = null;   // { sx, sy, ox, oy } while dragging empty canvas
  let panMoved = false; // suppresses the click that follows a drag

  function clampPan() {
    if (!width || !height) return; // pre-layout 0x0 viewport — don't corner-lock the pan
    const margin = 80; // keep the core at least this far inside the viewport
    pan.x = Math.max(-(width / 2) + margin, Math.min(width / 2 - margin, pan.x));
    pan.y = Math.max(-(height / 2) + margin, Math.min(height / 2 - margin, pan.y));
  }

  function notifyPan() {
    if (ctx.onPan) ctx.onPan({ x: pan.x, y: pan.y });
  }

  const ripples = [];        // expanding rings from core (tick FX)
  const bursts = [];         // event-driven bright particles { edgeKey, progress, speed, color }
  const flashes = new Map(); // edgeKey -> alpha

  const COLORS = {
    accent: cssVar('--accent', '#4fd8ff'),
    text: cssVar('--text', '#d7e3f4'),
    dim: cssVar('--text-dim', '#8ba3c4'),
    faint: cssVar('--text-faint', '#5f7391'),
    ok: cssVar('--ok', '#43e5a0'),
    warn: cssVar('--status-degraded', '#eab308'),
    danger: cssVar('--danger', '#ff5f66'),
  };
  const BREAKER_COLOR = { closed: COLORS.ok, 'half-open': COLORS.warn, open: COLORS.danger };

  // ---- seeded ambient starfield: relative coords (0..1), center-biased, fixed
  // at mount so nothing shifts between frames or resizes ----
  const bgRand = mulberry32(0x9E3779B9);
  const bgDots = Array.from({ length: BG_DOT_COUNT }, () => {
    // radial center bias: sqrt-free power curve pushes most dots inward
    const ang = bgRand() * Math.PI * 2;
    const rad = Math.pow(bgRand(), 0.6) * 0.52; // 0 (center) .. ~0.52 (edge)
    return {
      u: 0.5 + Math.cos(ang) * rad,
      v: 0.5 + Math.sin(ang) * rad,
      r: 0.5 + bgRand() * 1.4,
      a: 0.06 + bgRand() * 0.30,
      tw: bgRand() * Math.PI * 2,          // twinkle phase
      tws: 0.3 + bgRand() * 1.2,           // twinkle speed
    };
  });

  // ---- GlitterWrap flow field: ambient particle drift radiating outward from
  // the core. The new BASE background layer — drawn before bloom/tendrils/nodes.
  // Ported from a Canvas2D warp/starfield reference, but tuned AMBIENT/SLOW
  // (stepZ ~half the warp value, low max speed, subtle glitter): particles
  // drift gently outward from the core, not streak past as a hyperspace jump.
  // Reinforces the radial HUD metaphor: energy slowly radiating from the center.
  //
  // ponytail: a WebGL points shader could push this to thousands of stars with
  // real bloom on GPU machines — see redesign PLAN.
  const FLOW_COUNT = 320;
  const FLOW_FOCAL = 0.15;    // virtual focal depth — lower = stars survive to a nearer z = bigger persp
                              // multiplier = longer streaks before they cull past the edge (dramatic warp rush)
  const FLOW_TRAIL = 0.86;    // per-second trail keep (framerate-independent decay)
  const FLOW_COLOR = [
    COLORS.accent,            // color1 — --accent cyan, ties to the orb
    '#0ADED3',                // color2 — reference teal
    '#E1E1DA',                // color3 — reference off-white
  ];
  const flowRand = mulberry32(0x85E1A37); // seeded so the field is stable across frames
  // Pool built ONCE at mount — zero per-frame allocation in the loop.
  const flow = Array.from({ length: FLOW_COUNT }, () => {
    // Spawn across the FULL field [-1,1]. Stars exist across the whole viewport;
    // as z shrinks the perspective projection accelerates them outward toward
    // and past the screen edges — the starfield-warp read (Star Wars opening
    // crawl, Windows starfield screensaver). The previous tiny core-ring spawn
    // (rad 0.02-0.12) trapped every star inside ~134px of center, buried inside
    // the orb; full-field spawn lets them actually reach the edges.
    return {
      x: (flowRand() - 0.5) * 2,
      y: (flowRand() - 0.5) * 2,
      z: FLOW_FOCAL + flowRand() * (1.0 - FLOW_FOCAL),    // FLOW_FOCAL (near) .. 1.0 (far)
      px: 0, py: 0,
      seeded: false,
      seed: flowRand() * 1000,
      vmul: 0.6 + flowRand() * 0.9,
      colorIdx: (flowRand() * 3) | 0,
      flashUntil: 0,
      nextFlash: flowRand() * 6,
    };
  });

  // ---- organic tendril geometry (deterministic per edge id) ----
  function buildPath(edge, a, b) {
    const rand = mulberry32(hashId(`${edge.from}->${edge.to}`));
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // unit normal
    // 2 seeded bend control offsets -> slightly-curved dendrite, never straight
    const bend1 = (rand() - 0.5) * len * 0.22;
    const bend2 = (rand() - 0.5) * len * 0.22;
    const points = [];
    for (let i = 0; i <= PATH_SEGMENTS; i++) {
      const s = i / PATH_SEGMENTS;
      // cubic-ish blend of the two bends, zero at both endpoints
      const off = Math.sin(s * Math.PI) * (bend1 * (1 - s) + bend2 * s);
      points.push({ x: a.x + dx * s + nx * off, y: a.y + dy * s + ny * off });
    }
    // 1-3 short secondary offshoots at fixed fractional points, dead-end stubs
    // with a glowing dot at the tip (reference's dendrite forks)
    const branchCount = 1 + Math.floor(rand() * 3);
    const branches = [];
    for (let bi = 0; bi < branchCount; bi++) {
      const frac = 0.3 + rand() * 0.5;
      const idx = Math.round(frac * PATH_SEGMENTS);
      const root = points[idx];
      const prev = points[Math.max(0, idx - 1)];
      const baseAng = Math.atan2(root.y - prev.y, root.x - prev.x);
      const side = rand() < 0.5 ? 1 : -1;
      const ang = baseAng + side * (0.5 + rand() * 0.7);
      const blen = 14 + rand() * 26;
      const bpts = [root];
      const curl = (rand() - 0.5) * 0.9;
      for (let j = 1; j <= 6; j++) {
        const s = j / 6;
        const aj = ang + curl * s;
        bpts.push({ x: root.x + Math.cos(aj) * blen * s, y: root.y + Math.sin(aj) * blen * s });
      }
      branches.push({ points: bpts, tip: bpts[bpts.length - 1] });
    }
    // trunk edges: fading continuation past the node into the darkness
    let tail = null;
    if (edge.kind === 'trunk') {
      const tailLen = len * 0.35;
      const end = points[PATH_SEGMENTS];
      const dirx = dx / len, diry = dy / len;
      const drift = (rand() - 0.5) * 0.8;
      const tpts = [];
      for (let j = 0; j <= 8; j++) {
        const s = j / 8;
        const aj = Math.atan2(diry, dirx) + drift * s * 0.6;
        tpts.push({ x: end.x + Math.cos(aj) * tailLen * s, y: end.y + Math.sin(aj) * tailLen * s });
      }
      tail = { points: tpts, dots: [0.45 + rand() * 0.2, 0.85 + rand() * 0.1] };
    }
    // ambient electrons: fixed phase offsets + speeds per edge
    const electrons = Array.from({ length: ELECTRONS_PER_EDGE }, () => ({
      offset: rand(), speed: 0.04 + rand() * 0.05, dir: rand() < 0.85 ? 1 : -1,
    }));
    return { points, branches, tail, electrons };
  }

  function pointAlong(points, s) {
    const f = Math.max(0, Math.min(0.9999, s)) * (points.length - 1);
    const i = Math.floor(f);
    const frac = f - i;
    const p0 = points[i], p1 = points[i + 1];
    return { x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac };
  }

  function rebuild() {
    graph = buildGraph(stats, live);
    positions = layoutGraph(graph, width, height);
    paths = new Map();
    graph.edges.forEach((edge) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (a && b) paths.set(`${edge.from}->${edge.to}`, buildPath(edge, a, b));
    });
    // A11y mirror: nodeReadout() is otherwise only ever called per-node
    // PER-FRAME inside drawLabelBlock() below (60x/sec) — fine for canvas
    // drawing, but the mirror only needs a snapshot once per rebuild(), so it
    // gets its own cache here rather than hooking into the frame loop.
    const readoutCache = new Map();
    graph.nodes.forEach((node) => { if (node.type === 'module') readoutCache.set(node.id, nodeReadout(node)); });
    a11yLayer.sync(graph.nodes, readoutCache);
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // <= not < : matches the CSS convention's `max-width: 600px` (inclusive),
    // same as widget-host.js's `matchMedia('(max-width: 600px)')` — keeps the
    // canvas and DOM widgets agreeing on which pixel the tier starts at.
    narrow = width <= 600;
    const tooNarrow = width < 480;
    canvas.style.visibility = tooNarrow ? 'hidden' : '';
    narrowMsg.classList.toggle('visible', tooNarrow);
    rebuild();
  }

  async function resyncStats() {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) return;
      stats = await res.json();
      live.goalDelta = 0; live.kanbanDelta = 0; live.pipelineDelta = 0; live.auditDelta = 0;
      rebuild();
    } catch { /* server briefly away — keep last graph, honest-stale */ }
  }

  function spawnBurst(fromId, toId, color) {
    if (reduced) return;
    const key = `${fromId}->${toId}`;
    if (!paths.has(key)) return;
    bursts.push({ edgeKey: key, progress: 0, speed: 0.9 + Math.random() * 0.5, color: color || COLORS.accent });
    if (bursts.length > 80) bursts.shift();
  }

  function flashEdge(fromId, toId) {
    flashes.set(`${fromId}->${toId}`, 1);
  }

  // ---- live event wiring (WS-only, no polling) ----
  const unsub = ctx.subscribe(['tick', 'perception', 'action', 'health', 'goal-update', 'audit', 'entity-state'], (msg) => {
    if (msg.type === 'tick') {
      ripples.push({ r: 0, alpha: 0.3 });
      if (msg.payload.tick % RESYNC_EVERY_TICKS === 0) resyncStats();
    } else if (msg.type === 'perception') {
      const target = CHANNEL_TARGET[msg.payload.channel] || 'core';
      if (target === 'core') ripples.push({ r: 0, alpha: 0.45 });
      else spawnBurst('core', target);
    } else if (msg.type === 'action') {
      const target = toolTarget(msg.payload.tool);
      if (ctx.onAction) ctx.onAction(target, msg.payload.ok);
      flashEdge('core', target);
      spawnBurst('core', 'audit', msg.payload.ok ? COLORS.ok : COLORS.danger);
      if (target === 'kanban') live.kanbanDelta += 1;
      if (target === 'pipeline') live.pipelineDelta += 1;
      rebuild();
    } else if (msg.type === 'health') {
      const breakers = msg.payload.breakers || {};
      live.breakers = {};
      Object.keys(breakers).forEach((name) => {
        if (breakers[name].state !== 'closed') live.breakers[name] = breakers[name].state;
      });
      live.degraded = Object.keys(live.breakers).length > 0;
      rebuild();
    } else if (msg.type === 'goal-update') {
      live.goalDelta += 1;
      flashEdge('core', 'goals');
      rebuild();
    } else if (msg.type === 'audit') {
      live.auditDelta += 1;
      rebuild();
    } else if (msg.type === 'entity-state') {
      entityStatus = msg.payload.status || entityStatus;
    }
  });

  const offRefresh = ctx.onRefresh(() => resyncStats());

  // ---- interaction ----
  function nodeAt(px, py) {
    let hit = null;
    graph.nodes.forEach((node) => {
      if (node.type === 'core') return; // core clicks belong to the orb canvas
      const p = positions.get(node.id);
      if (!p) return;
      if (Math.hypot(p.x - px, p.y - py) < Math.max(18, p.r + 12)) hit = node;
    });
    return hit;
  }

  function onMove(e) {
    if (panDrag) return; // cursor is owned by the drag while panning
    hovered = nodeAt(e.clientX - pan.x, e.clientY - pan.y);
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
  }

  function onClick(e) {
    if (panMoved) { panMoved = false; return; } // this click ended a pan drag
    const hit = nodeAt(e.clientX - pan.x, e.clientY - pan.y);
    if (!hit) return;
    if (hit.type === 'module') ctx.onNodeClick(hit.id);
    else if (hit.type === 'memory-cluster') ctx.onNodeClick('memory');
    else if (hit.type === 'breaker') ctx.onNodeClick('health');
  }

  // Pan drag — starts only on empty canvas (a node hit falls through to click).
  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (nodeAt(e.clientX - pan.x, e.clientY - pan.y)) return;
    panDrag = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
    panMoved = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e) {
    if (!panDrag) return;
    const dx = e.clientX - panDrag.sx;
    const dy = e.clientY - panDrag.sy;
    if (!panMoved && Math.abs(dx) + Math.abs(dy) > 5) panMoved = true;
    pan.x = panDrag.ox + dx;
    pan.y = panDrag.oy + dy;
    clampPan();
    notifyPan();
  }

  function onPointerUp(e) {
    if (!panDrag) return;
    panDrag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    canvas.style.cursor = 'grab';
    if (panMoved) savePan(pan);
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  // ---- line-icon glyphs (simple strokes, reference style) ----
  const ICONS = {
    goals(x, y, s) { // target/crosshair
      c2d.beginPath(); c2d.arc(x, y, s * 0.55, 0, Math.PI * 2); c2d.stroke();
      c2d.beginPath(); c2d.arc(x, y, s * 0.12, 0, Math.PI * 2); c2d.fill();
      [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([ux, uy]) => {
        c2d.beginPath();
        c2d.moveTo(x + ux * s * 0.7, y + uy * s * 0.7);
        c2d.lineTo(x + ux * s * 1.0, y + uy * s * 1.0);
        c2d.stroke();
      });
    },
    kanban(x, y, s) { // bar chart
      [[-0.55, 0.45], [0, 0.8], [0.55, 0.6]].forEach(([ox, hgt]) => {
        c2d.beginPath();
        c2d.moveTo(x + ox * s, y + s * 0.7);
        c2d.lineTo(x + ox * s, y + s * 0.7 - hgt * s * 1.4);
        c2d.stroke();
      });
    },
    pipeline(x, y, s) { // lightning bolt
      c2d.beginPath();
      c2d.moveTo(x + s * 0.25, y - s * 0.8);
      c2d.lineTo(x - s * 0.35, y + s * 0.15);
      c2d.lineTo(x + s * 0.05, y + s * 0.15);
      c2d.lineTo(x - s * 0.25, y + s * 0.8);
      c2d.lineTo(x + s * 0.4, y - s * 0.1);
      c2d.lineTo(x + s * 0.02, y - s * 0.1);
      c2d.closePath();
      c2d.stroke();
    },
    memory(x, y, s) { // brain: two lobes + fissure squiggle
      c2d.beginPath(); c2d.arc(x - s * 0.28, y, s * 0.5, Math.PI * 0.5, Math.PI * 1.5); c2d.stroke();
      c2d.beginPath(); c2d.arc(x + s * 0.28, y, s * 0.5, Math.PI * 1.5, Math.PI * 0.5); c2d.stroke();
      c2d.beginPath();
      c2d.moveTo(x, y - s * 0.5);
      c2d.quadraticCurveTo(x - s * 0.2, y - s * 0.15, x, y);
      c2d.quadraticCurveTo(x + s * 0.2, y + s * 0.25, x, y + s * 0.5);
      c2d.stroke();
    },
    health(x, y, s) { // EKG heartbeat
      c2d.beginPath();
      c2d.moveTo(x - s * 0.9, y);
      c2d.lineTo(x - s * 0.35, y);
      c2d.lineTo(x - s * 0.15, y - s * 0.6);
      c2d.lineTo(x + s * 0.1, y + s * 0.6);
      c2d.lineTo(x + s * 0.3, y);
      c2d.lineTo(x + s * 0.9, y);
      c2d.stroke();
    },
    audit(x, y, s) { // padlock
      c2d.strokeRect(x - s * 0.5, y - s * 0.1, s, s * 0.8);
      c2d.beginPath(); c2d.arc(x, y - s * 0.1, s * 0.32, Math.PI, 0); c2d.stroke();
      c2d.beginPath(); c2d.arc(x, y + s * 0.3, s * 0.08, 0, Math.PI * 2); c2d.fill();
    },
  };

  // ---- drawing helpers ----
  function strokePolyline(points, color, alpha, lw) {
    c2d.beginPath();
    c2d.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) c2d.lineTo(points[i].x, points[i].y);
    c2d.strokeStyle = color;
    c2d.globalAlpha = alpha;
    c2d.lineWidth = lw;
    c2d.stroke();
    c2d.globalAlpha = 1;
  }

  function glowDot(x, y, r, color, alpha) {
    c2d.beginPath();
    c2d.arc(x, y, r * 2.6, 0, Math.PI * 2);
    c2d.fillStyle = color;
    c2d.globalAlpha = alpha * 0.22;
    c2d.fill();
    c2d.beginPath();
    c2d.arc(x, y, r, 0, Math.PI * 2);
    c2d.globalAlpha = alpha;
    c2d.fill();
    c2d.globalAlpha = 1;
  }

  function drawLabelBlock(node, p) {
    const cx = width / 2, cy = height / 2;
    const ang = Math.atan2(p.y - cy, p.x - cx);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const gap = p.r + 18;
    let tx = p.x + ux * gap;
    let ty = p.y + uy * gap;
    let align = 'center';
    if (ux > 0.35) align = 'left';
    else if (ux < -0.35) align = 'right';
    if (Math.abs(uy) > 0.8) { ty += uy * 8; }

    // Bottom-center dock exclusion: flip the label to the node's inward side
    // instead of letting it render behind the compose dock. Screen-y is
    // ty + pan.y (this whole pass runs inside the pan translate) — a hard
    // clamp would make the label overlap its own node, so flip instead.
    if (ty + pan.y > height - 150 && Math.abs(p.x + pan.x - width / 2) < 360) {
      ty = p.y - (gap + 16);
    }

    const { value, ratio, danger } = nodeReadout(node);
    const isHovered = hovered && hovered.id === node.id;
    c2d.textAlign = align;
    c2d.textBaseline = 'alphabetic';
    // Narrow tier (<600px): drop the small-caps module-name line and pull the
    // value line up to where it sat — halves the label's vertical footprint
    // so satellite labels don't collide once node spacing shrinks.
    if (!narrow) {
      c2d.font = '500 10px Outfit, "Segoe UI", sans-serif';
      c2d.fillStyle = isHovered ? COLORS.dim : COLORS.faint;
      c2d.fillText(node.label.split('').join(' '), tx, ty - 8);
    }
    const valueY = narrow ? ty : ty + 8;
    c2d.font = '13px "JetBrains Mono", monospace';
    c2d.fillStyle = danger ? COLORS.danger : (isHovered ? COLORS.text : COLORS.accent);
    c2d.fillText(value, tx, valueY);
    if (ratio !== null && ratio !== undefined) {
      const barW = narrow ? 28 : 44;
      const barY = valueY + 6;
      const bx = align === 'right' ? tx - barW : align === 'center' ? tx - barW / 2 : tx;
      c2d.fillStyle = COLORS.faint;
      c2d.globalAlpha = 0.35;
      c2d.fillRect(bx, barY, barW, 1.5);
      c2d.globalAlpha = 1;
      c2d.fillStyle = COLORS.accent;
      c2d.fillRect(bx, barY, barW * Math.max(0, Math.min(1, ratio)), 1.5);
    }
  }

  function drawSystemStatus() {
    const label = 'S Y S T E M   S T A T U S';
    let value = 'OPTIMAL';
    let color = COLORS.accent;
    if (entityStatus === 'stopped') { value = 'OFFLINE'; color = COLORS.faint; }
    else if (entityStatus !== 'alive') { value = 'BOOTING'; color = COLORS.dim; }
    else if (live.degraded) { value = 'DEGRADED'; color = COLORS.danger; }
    c2d.textAlign = 'center';
    c2d.font = '500 10px Outfit, "Segoe UI", sans-serif';
    c2d.fillStyle = COLORS.faint;
    c2d.fillText(label, width / 2, 26);
    c2d.font = '13px "JetBrains Mono", monospace';
    c2d.fillStyle = color;
    c2d.fillText(value.split('').join(' '), width / 2, 44);
  }

  // ---- GlitterWrap flow field render. The ambient outward particle drift.
  // Does its OWN trail-fade (destination-out) + additive star draw, then resets
  // composite to source-over and globalAlpha to 1 so bloom/tendrils draw after
  // normally. Reused scratch vars only — zero per-frame allocation.
  function drawFlowField(dt) {
    if (reduced) return; // no rAF-driven motion under prefers-reduced-motion

    const cx = width / 2, cy = height / 2;
    // Projection scale: max(w,h)*0.5 so stars reach past the horizontal edges
    // on widescreen (was min*1.4, which height-clamped stars to ~400px reach on
    // 1280x800 and left the sides empty). max gives ~640px reach — stars at
    // tx=1.0 fly off the sides, filling the whole viewport with motion.
    const projScale = Math.max(width, height) * 0.5;
    const elapsed = t;

    // State reactivity — small multiplicative tweaks on stepZ / brightness from
    // the orb's voiceState + activity, not branchy per-particle logic:
    //   listening: field leans inward (reverse z step) — toward the mic
    //   speaking : radiates faster + density pulse with activity amplitude
    //   default  : gentle outward drift
    let dirMul = 1;          // +1 outward, -1 inward
    let speedMul = 1;
    let brightMul = 1;
    if (voiceState === 'listening') {
      dirMul = -1;           // particles drift inward toward the mic
      speedMul = 0.8;
      brightMul = 1.05;
    } else if (voiceState === 'speaking') {
      speedMul = 1.5 + activity * 0.8; // faster radiation + density pulse
      brightMul = 1.0 + activity * 0.4;
    } else if (voiceState === 'processing') {
      speedMul = 1.1;
      brightMul = 1.05;
    }

    // Warp speed. Old value (0.0003) was ~5x too slow AND compounded by a dt
    // bug: the GlitterWrap reference multiplies deltaSec*60 to normalize to
    // "frames at 60fps", but this port passed raw seconds (~0.0167), so the
    // effective motion was ~60x too slow — stars took minutes to cross, reading
    // as static dots. Raised to a real warp speed and the dt*60 normalization
    // is applied below at the z step. persp = FOCAL/z means stars accelerate
    // exponentially as z->0 (the signature warp rush toward the camera).
    const stepZ = 0.0028 * speedMul;

    // NOTE: the GlitterWrap reference fades prior pixels each frame via a
    // destination-out rect to build a smear/trail buffer. That does NOT work
    // here: frame() clears the whole canvas with clearRect before drawFlowField
    // runs, so a trail buffer can never accumulate — and the rest of the HUD
    // (tendrils, nodes, EKG) REQUIRES that full clear each frame. We rely on the
    // streak-from-previous-position + dot head for the motion look instead. The
    // streak's px,py carries over from the previous frame, which is what gives
    // the flow its sense of motion. FLOW_TRAIL is kept (unused) for parity with
    // the reference and a future opt-in persistent-canvas path.
    void FLOW_TRAIL;

    // additive draw of the particles themselves
    c2d.globalCompositeOperation = 'lighter';
    c2d.lineCap = 'round';

    for (let i = 0; i < FLOW_COUNT; i++) {
      const s = flow[i];
      // advance depth — inward when listening, outward otherwise. dt*60
      // normalizes to "frames at 60fps" (matches the GlitterWrap reference) so
      // warp speed is framerate-independent: stepZ is tuned per-1/60s.
      s.z -= stepZ * s.vmul * (dt * 60) * dirMul;
      // respawn at far plane when it has flown past (z<=focal) or, on listening,
      // when it has receded past the far plane (z>=1). Cull off-screen stars too.
      if (s.z <= FLOW_FOCAL || s.z >= 1.0001) {
        // Respawn across the FULL field [-1,1] at the far plane. Matches the
        // pool init: stars spread across the viewport at z=1, then accelerate
        // outward as z shrinks. (Core-ring respawn was the bug that trapped
        // every star inside the orb's footprint.)
        s.x = (flowRand() - 0.5) * 2;
        s.y = (flowRand() - 0.5) * 2;
        s.z = dirMul >= 0 ? 1.0 : FLOW_FOCAL + 0.02;
        s.seeded = false;
        s.nextFlash = elapsed + 2 + flowRand() * 7;
        continue;
      }

      // perspective project (guard divisor like the reference)
      const persp = FLOW_FOCAL / Math.max(s.z, 0.0001);
      // turbulence: gentle sinusoidal wobble growing as the star approaches
      const amp = (1 - s.z) * 0.04;
      const tx = s.x + Math.sin(elapsed * 1.2 + s.seed) * amp;
      const ty = s.y + Math.cos(elapsed * 1.0 + s.seed * 1.3) * amp;
      const sx = cx + tx * persp * projScale;
      const sy = cy + ty * persp * projScale;

      // cull off-screen — respawn next frame (keeps the pool alive)
      if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) {
        s.z = 0; // triggers respawn on the next pass
        continue;
      }

      const color = FLOW_COLOR[s.colorIdx];
      // depth-faded brightness: nearer (low z) reads brighter. Clamp raised
      // from [0.04,0.55] to [0.18,0.85] — the old floor was below visibility
      // on a near-black base, which is why the field read as invisible.
      const depthA = Math.max(0.18, Math.min(0.85, (1 - s.z) * 0.9 + 0.1)) * brightMul;

      // streak from previous to current position. At warp speed near stars
      // move many px/frame, so the raw prev->curr line is already a real tail;
      // far stars barely move and read as dots. The extrapolation (3x delta)
      // lengthens near-star tails into dramatic light-speed streaks while
      // leaving far stars as points — the depth contrast IS the warp read.
      if (s.seeded) {
        const dx = sx - s.px, dy = sy - s.py;
        const tailX = sx + dx * 3, tailY = sy + dy * 3;
        c2d.strokeStyle = color;
        c2d.globalAlpha = depthA * 0.75;
        c2d.lineWidth = 1.1;
        c2d.beginPath();
        c2d.moveTo(tailX, tailY);
        c2d.lineTo(sx, sy);
        c2d.stroke();
      } else {
        s.seeded = true;
      }

      // glitter flash scheduling -> boost size/brightness briefly
      let flashMult = 1;
      if (elapsed >= s.nextFlash) {
        s.flashUntil = elapsed + 0.04 + flowRand() * 0.07; // 40-110ms sparkle
        s.nextFlash = elapsed + 4 + flowRand() * 8;
      }
      if (elapsed < s.flashUntil) flashMult = 2.4;

      // dot head — 1.5px (was 1px) so it reads at distance on pure black.
      const head = 1.5 * flashMult;
      c2d.fillStyle = color;
      c2d.globalAlpha = Math.min(1, depthA * flashMult);
      c2d.fillRect(sx - head * 0.5, sy - head * 0.5, head, head);

      s.px = sx;
      s.py = sy;
    }

    // reset composite + alpha so bloom wash + tendrils draw normally after
    c2d.globalCompositeOperation = 'source-over';
    c2d.globalAlpha = 1;
    c2d.lineCap = 'butt';
  }

  // ---- ambient bloom — full-viewport voice-state wash, drawn first (behind
  // the starfield/tendrils/nodes) so listening/speaking/thinking read as an
  // atmosphere shift, not just an orb-local effect ----
  function drawBloom() {
    const HUES = { speaking: '#f5d020', listening: '#43e5a0', processing: '#a78bfa' };
    const hue = HUES[voiceState] || COLORS.accent;
    const boost = voiceState === 'speaking' ? 0.55 + activity * 0.45
      : voiceState === 'listening' ? 0.40
      : voiceState === 'processing' ? 0.45 : 0.25;
    const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.4);
    const rad = Math.min(width, height) * (0.28 + 0.05 * boost * pulse);
    const g = c2d.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, rad);
    // Opacities trimmed ~40% (0.055->0.033, 0.025->0.015) so the bloom wash no
    // longer fights the pure-black base — it's a faint state tint now, not a
    // haze. The flow-field particles read clearly through it.
    g.addColorStop(0, hexA(hue, 0.033 * boost + 0.012));
    g.addColorStop(0.6, hexA(hue, 0.015 * boost));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c2d.fillStyle = g;
    c2d.fillRect(0, 0, width, height);
  }

  function drawFaintHudRings() {
    // large concentric guide rings framing the whole scene (reference backdrop)
    const cx = width / 2, cy = height / 2;
    [0.42, 0.47].forEach((frac, i) => {
      c2d.beginPath();
      c2d.arc(cx, cy, Math.min(width, height) * frac, 0, Math.PI * 2);
      c2d.strokeStyle = COLORS.accent;
      c2d.globalAlpha = 0.05 - i * 0.015;
      c2d.lineWidth = 1;
      c2d.stroke();
      c2d.globalAlpha = 1;
    });
  }

  // ---- frame loop ----
  function frame(timestamp) {
    const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
    lastTime = timestamp;
    if (!reduced) t += dt;

    c2d.save();
    c2d.scale(dpr, dpr);
    c2d.clearRect(0, 0, width, height);

    // Base layer FIRST: the GlitterWrap flow field (ambient outward particle
    // drift). Drawn before bloom so the voice-state wash reads through it.
    // The dt here is the existing frame dt, already capped at 0.05s.
    drawFlowField(dt);

    drawBloom();
    drawFaintHudRings();

    // 1. ambient starfield (fixed positions, gentle twinkle) — dimmed slightly
    // so the bloom wash reads through instead of competing with it
    bgDots.forEach((d) => {
      const a = d.a * (reduced ? 1 : 0.75 + 0.25 * Math.sin(t * d.tws + d.tw));
      glowDot(d.u * width, d.v * height, d.r, COLORS.accent, a * 0.8);
    });

    // Everything from here to the node pass moves with the constellation pan.
    c2d.save();
    c2d.translate(pan.x, pan.y);

    // 2. tendrils: organic curve + branches + fading tail + tip dots
    graph.edges.forEach((edge) => {
      const key = `${edge.from}->${edge.to}`;
      const path = paths.get(key);
      if (!path) return;
      const flash = flashes.get(key) || 0;
      const base = edge.kind === 'trunk' ? 0.20 : 0.13;
      strokePolyline(path.points, COLORS.accent, Math.min(1, base + flash * 0.7), 1);
      if (flash > 0) flashes.set(key, Math.max(0, flash - dt * 1.5));
      path.branches.forEach((br) => {
        strokePolyline(br.points, COLORS.accent, base * 0.7, 0.7);
        glowDot(br.tip.x, br.tip.y, 1.3, COLORS.accent, 0.5 + (reduced ? 0 : 0.3 * Math.sin(t * 1.3 + br.tip.x)));
      });
      if (path.tail) {
        strokePolyline(path.tail.points, COLORS.accent, base * 0.5, 0.7);
        path.tail.dots.forEach((s) => {
          const p = pointAlong(path.tail.points, s);
          glowDot(p.x, p.y, 1.4, COLORS.accent, 0.45);
        });
      }
      // 3. continuous ambient electrons flowing along the tendril
      if (!reduced) {
        path.electrons.forEach((el) => {
          const s = ((t * el.speed * el.dir + el.offset) % 1 + 1) % 1;
          const p = pointAlong(path.points, s);
          const trail = pointAlong(path.points, Math.max(0, s - 0.03 * el.dir));
          strokePolyline([trail, p], COLORS.accent, 0.25, 1.4);
          glowDot(p.x, p.y, 1.5, COLORS.accent, 0.55);
        });
      }
    });

    // 4. tick ripples expanding from the core
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += dt * Math.min(width, height) * 0.22;
      r.alpha -= dt * 0.45;
      if (r.alpha <= 0) { ripples.splice(i, 1); continue; }
      c2d.beginPath();
      c2d.arc(width / 2, height / 2, r.r, 0, Math.PI * 2);
      c2d.strokeStyle = COLORS.accent;
      c2d.globalAlpha = r.alpha * 0.45;
      c2d.lineWidth = 1;
      c2d.stroke();
      c2d.globalAlpha = 1;
    }

    // 5. event-driven bright bursts (layered over ambient electrons)
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.progress += dt * b.speed;
      if (b.progress >= 1) { bursts.splice(i, 1); continue; }
      const path = paths.get(b.edgeKey);
      if (!path) { bursts.splice(i, 1); continue; }
      const p = pointAlong(path.points, b.progress);
      glowDot(p.x, p.y, 2.4, b.color, 0.95 * Math.sin(b.progress * Math.PI));
    }

    // 6. nodes — ring-icon satellites (reference treatment)
    graph.nodes.forEach((node) => {
      if (node.type === 'core') return; // core-orb canvas renders the core
      const p = positions.get(node.id);
      if (!p) return;
      const isHovered = hovered && hovered.id === node.id;
      const breathe = 1 + (reduced ? 0 : Math.sin(t * 1.2 + p.x * 0.02) * 0.03);

      if (node.type === 'module') {
        // ring size: weight modulates SUBTLY around the reference's uniform
        // satellite rings — clamped so a data-heavy module never dwarfs the rest
        const R = Math.min(26, Math.max(14, 15 + (node.weight - 1) * 5)) * breathe;
        // halo
        const halo = c2d.createRadialGradient(p.x, p.y, R * 0.4, p.x, p.y, R * 2.4);
        halo.addColorStop(0, 'rgba(79, 216, 255, 0.10)');
        halo.addColorStop(1, 'rgba(79, 216, 255, 0)');
        c2d.fillStyle = halo;
        c2d.beginPath(); c2d.arc(p.x, p.y, R * 2.4, 0, Math.PI * 2); c2d.fill();
        // dark disc + thin ring
        c2d.beginPath(); c2d.arc(p.x, p.y, R, 0, Math.PI * 2);
        c2d.fillStyle = 'rgba(8, 14, 24, 0.85)';
        c2d.fill();
        c2d.strokeStyle = isHovered ? '#dff2ff' : COLORS.accent;
        c2d.globalAlpha = isHovered ? 0.95 : 0.6;
        c2d.lineWidth = 1.2;
        c2d.shadowBlur = isHovered ? 12 : 6;
        c2d.shadowColor = COLORS.accent;
        c2d.stroke();
        c2d.shadowBlur = 0;
        c2d.globalAlpha = 1;
        // line icon
        c2d.strokeStyle = isHovered ? '#eaf7ff' : COLORS.accent;
        c2d.fillStyle = c2d.strokeStyle;
        c2d.lineWidth = 1.3;
        c2d.lineJoin = 'round';
        c2d.lineCap = 'round';
        (ICONS[node.id] || ICONS.goals)(p.x, p.y, R * 0.52);
        drawLabelBlock(node, p);
      } else if (node.type === 'memory-cluster') {
        const R = Math.max(7, p.r) * breathe;
        c2d.beginPath(); c2d.arc(p.x, p.y, R, 0, Math.PI * 2);
        c2d.fillStyle = 'rgba(8, 14, 24, 0.8)';
        c2d.fill();
        c2d.strokeStyle = COLORS.accent;
        c2d.globalAlpha = 0.45;
        c2d.lineWidth = 1;
        c2d.stroke();
        c2d.globalAlpha = 1;
        glowDot(p.x, p.y, 1.8, COLORS.accent, 0.7);
        c2d.font = '9px "JetBrains Mono", monospace';
        c2d.textAlign = 'center';
        c2d.fillStyle = isHovered ? COLORS.text : COLORS.faint;
        // Bottom-center dock exclusion: flip above the node instead of
        // rendering the label behind the compose dock (screen-y is p.y +
        // pan.y since this pass runs inside the pan translate) — the
        // "EPISODIC 458" stray-label bug.
        const labelY = (p.y + pan.y + R + 12 > height - 150 && Math.abs(p.x + pan.x - width / 2) < 360)
          ? p.y - R - 8
          : p.y + R + 12;
        c2d.fillText(`${node.label} ${node.meta && node.meta.count ? node.meta.count : ''}`.trim(), p.x, labelY);
      } else if (node.type === 'breaker') {
        const R = Math.max(6, p.r) * breathe;
        const color = BREAKER_COLOR[node.state] || COLORS.warn;
        c2d.beginPath(); c2d.arc(p.x, p.y, R, 0, Math.PI * 2);
        c2d.fillStyle = 'rgba(8, 14, 24, 0.8)';
        c2d.fill();
        c2d.strokeStyle = color;
        c2d.globalAlpha = 0.8;
        c2d.lineWidth = 1.2;
        c2d.stroke();
        c2d.globalAlpha = 1;
        glowDot(p.x, p.y, 1.6, color, 0.8);
        if (isHovered) {
          c2d.font = '9px "JetBrains Mono", monospace';
          c2d.textAlign = 'center';
          c2d.fillStyle = color;
          c2d.fillText(`${node.label} · ${node.state.toUpperCase()}`, p.x, p.y + R + 12);
        }
      }
    });

    c2d.restore(); // end constellation pan layer

    drawSystemStatus();

    c2d.restore();
    raf = requestAnimationFrame(frame);
  }

  const onResize = () => { resize(); clampPan(); notifyPan(); };
  window.addEventListener('resize', onResize);
  resize();
  clampPan();
  notifyPan(); // apply the persisted pan to the DOM core-orb on load
  resyncStats(); // initial density fetch — one-shot, not a poll
  raf = requestAnimationFrame(frame);

  const onVis = () => {
    if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    else if (!raf) { lastTime = 0; raf = requestAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', onVis);

  return {
    cleanup() {
      if (raf) cancelAnimationFrame(raf);
      unsub();
      offRefresh();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      a11yLayer.cleanup();
      narrowMsg.remove();
    },
    setVoiceState(s) { voiceState = (s === 'listening' || s === 'processing' || s === 'speaking') ? s : 'idle'; },
    setActivity(v) { activity = Math.max(0, Math.min(1, Number(v) || 0)); },
  };
}
