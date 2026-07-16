// core-orb.js — the central HUD circle, drawn to match the JARVIS reference
// mockup exactly: dark disc with a thin bright ice-blue ring (brighter glints
// top/bottom), a diamond glyph, the entity's wordmark (config.MYTHOS_NAME via
// the entity-state broadcast — never hardcoded), a status line driven by real
// entity state, and an EKG-style waveform that pulses with the tick cadence.
//
// Rendering mechanics (dpr scaling, ResizeObserver, pulse envelope, reduced-
// motion, visibilitychange pause) are CA from app/public/js/jarvis-core.js;
// the drawn content is the reference design instead of the abstract plasma orb.
//
// State model: one resolveState() picks a single base hue (priority: offline >
// booting > confirm > degraded > thinking > listening > online) so ring/glyph/
// waveform/particles/sparks are always one coherent color, never fighting.
// Animation TEXTURE (heartbeat/shimmer/breathe) is independent of and additive
// to that color — a degraded+thinking+ticking orb shows all three at once.
// Action-flash is a separate, spatially-outside, short-lived color layer fed
// by hud-canvas.js's existing toolTarget() categorization (single source of
// truth for "what kind of action" — this file never re-parses tool names).

const TAU = Math.PI * 2;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// mulberry32 — local seeded PRNG (same convention as hud-canvas.js's own copy)
// so the ambient particle ring is stable across frames/resizes, never flickering.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let z = Math.imul(a ^ (a >>> 15), 1 | a);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

export function mountCoreOrb(canvas, ctx) {
  const c2d = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ACCENT = cssVar('--accent', '#4fd8ff');
  const TEXT = cssVar('--text', '#d7e3f4');
  const DIM = cssVar('--text-dim', '#8ba3c4');
  const DANGER = cssVar('--danger', '#ff5f66');
  const WARN = cssVar('--status-degraded', '#eab308');
  const THINKING = cssVar('--accent-goals-purple', '#a78bfa'); // matches mic-processing (voice.css)
  // Orb glow colors per user spec:
  //   idle = cyan, listening = green, speaking = yellow, error = red
  const LISTENING = '#43e5a0';   // green
  const SPEAKING = '#f5d020';    // warm yellow, readable on dark navy

  const ACTION_COLORS = {
    goals: THINKING,
    kanban: cssVar('--accent-kanban', '#2dd4bf'),
    pipeline: cssVar('--accent-pipeline', '#34d399'),
    memory: cssVar('--accent-memory', '#60a5fa'),
    health: WARN,
    audit: DIM,
    core: ACCENT,
  };

  let size = 100;
  let raf = null;
  let lastTime = 0;
  let t = 0;
  let level = 0;          // tick heartbeat envelope 0..1 (decays)
  let entityName = 'MYTHOS';
  let entityStatus = 'booting'; // booting | alive | stopped
  let degraded = false;
  let confirmPending = false;
  let voiceState = 'idle';      // idle | listening | processing (from voice-loop, via app.js)
  let ringR = 46;                // updated each frame; sparks/particles read this
  let actionFlash = null;        // { color, ok, decay }
  let sparks = [];               // { angle, life, len, color }
  let sparkTimer = 0.9 + Math.random() * 0.8;

  function syncSize() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    if (w < 10) return;
    size = Math.floor(w);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  const ro = new ResizeObserver(syncSize);
  ro.observe(canvas);
  syncSize();

  // ---- unified state resolution — one hue, one priority chain ----
  const STATE_COLOR = {
    offline: DIM, booting: DIM, confirm: WARN, degraded: DANGER,
    thinking: THINKING, listening: LISTENING, speaking: SPEAKING, online: ACCENT,
  };
  const STATE_LINE = {
    offline: 'ENTITY OFFLINE', booting: 'ENTITY BOOTING', confirm: 'AWAITING CONFIRM',
    degraded: 'ENTITY DEGRADED', thinking: 'PROCESSING', listening: 'LISTENING',
    speaking: 'SPEAKING', online: 'ENTITY ONLINE',
  };

  function resolveState() {
    if (entityStatus === 'stopped') return 'offline';
    if (entityStatus !== 'alive') return 'booting';
    if (confirmPending) return 'confirm';
    if (degraded) return 'degraded';
    if (voiceState === 'speaking') return 'speaking';
    if (voiceState === 'processing') return 'thinking';
    if (voiceState === 'listening') return 'listening';
    return 'online';
  }
  function statusColor() { return STATE_COLOR[resolveState()]; }
  function statusLine() { return STATE_LINE[resolveState()]; }

  // ---- ambient particles orbiting just outside the ring ----
  const orbRand = mulberry32(0xA11CE0DE);
  const particles = Array.from({ length: 16 }, () => ({
    angle0: orbRand() * TAU, band: orbRand(), dir: orbRand() < 0.5 ? 1 : -1,
    speed: 0.08 + orbRand() * 0.14, r: 0.6 + orbRand() * 0.7,
    phase: orbRand() * TAU, tws: 0.3 + orbRand() * 0.5,
  }));

  function glowDot(x, y, r, color, alpha) {
    c2d.beginPath();
    c2d.arc(x, y, r * 2.6, 0, TAU);
    c2d.fillStyle = color;
    c2d.globalAlpha = alpha * 0.22;
    c2d.fill();
    c2d.beginPath();
    c2d.arc(x, y, r, 0, TAU);
    c2d.globalAlpha = alpha;
    c2d.fill();
    c2d.globalAlpha = 1;
  }

  function drawAmbientParticles(c, R, color) {
    particles.forEach((p) => {
      const angle = reduced ? p.angle0 : p.angle0 + t * p.speed * p.dir;
      const bob = reduced ? 0 : Math.sin(t * p.tws + p.phase) * 0.035;
      const rad = R * (1.08 + p.band * 0.34 + bob);
      const x = c + Math.cos(angle) * rad;
      const y = c + Math.sin(angle) * rad;
      const alpha = reduced ? 0.18 : 0.15 + 0.15 * (0.5 + 0.5 * Math.sin(t * p.tws * 1.3 + p.phase));
      glowDot(x, y, p.r, color, alpha);
    });
  }

  // ---- firing synapses — short sparks radiating from the ring edge ----
  function spawnSpark(color, count, len) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      sparks.push({ angle: Math.random() * TAU, life: 1, len: len * (0.7 + Math.random() * 0.6), color });
    }
    if (sparks.length > 40) sparks.splice(0, sparks.length - 40);
  }

  function drawSynapseSparks(c, dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt * 1.8;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      const grow = Math.sin(Math.min(1, (1 - s.life) * 3) * Math.PI / 2);
      const x0 = c + Math.cos(s.angle) * ringR;
      const y0 = c + Math.sin(s.angle) * ringR;
      const x1 = c + Math.cos(s.angle) * (ringR + s.len * grow);
      const y1 = c + Math.sin(s.angle) * (ringR + s.len * grow);
      c2d.beginPath();
      c2d.moveTo(x0, y0);
      c2d.lineTo(x1, y1);
      c2d.strokeStyle = s.color;
      c2d.globalAlpha = s.life * 0.9;
      c2d.lineWidth = 1.1;
      c2d.shadowBlur = 6;
      c2d.shadowColor = s.color;
      c2d.stroke();
      c2d.shadowBlur = 0;
      c2d.globalAlpha = 1;
    }
  }

  // ---- action-flash — brief category-colored ring just outside the base ring ----
  function drawActionFlash(c, R) {
    if (!actionFlash || actionFlash.decay <= 0) return;
    const blur = reduced ? 0 : 14 * actionFlash.decay;
    const lw = reduced ? 2 : 2 + actionFlash.decay * 2;
    c2d.beginPath();
    c2d.arc(c, c, R * 1.05, 0, TAU);
    c2d.strokeStyle = actionFlash.color;
    c2d.globalAlpha = actionFlash.decay * 0.8;
    c2d.lineWidth = lw;
    c2d.shadowBlur = blur;
    c2d.shadowColor = actionFlash.color;
    c2d.stroke();
    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
    if (actionFlash.ok === false) {
      c2d.beginPath();
      c2d.arc(c, c, R * 1.12, 0, TAU);
      c2d.strokeStyle = DANGER;
      c2d.globalAlpha = actionFlash.decay * 0.6;
      c2d.lineWidth = 1.5;
      c2d.stroke();
      c2d.globalAlpha = 1;
    }
  }

  // ---- drawing ----
  function drawRing(c, R, color, state) {
    // faint fill disc — a touch lighter than the page, glassy
    const disc = c2d.createRadialGradient(c, c - R * 0.5, R * 0.1, c, c, R);
    disc.addColorStop(0, 'rgba(30, 45, 70, 0.55)');
    disc.addColorStop(0.7, 'rgba(12, 20, 34, 0.75)');
    disc.addColorStop(1, 'rgba(6, 10, 18, 0.9)');
    c2d.beginPath();
    c2d.arc(c, c, R, 0, TAU);
    c2d.fillStyle = disc;
    c2d.fill();

    // listening: slow breathing alpha on the base ring stroke (texture, not a
    // different hue — the entity genuinely still reads as "online").
    const breathe = (state === 'listening' && !reduced) ? 0.88 + 0.12 * Math.sin(t * 2.618) : 1;
    // thinking/speaking: additive shimmer on glow intensity, independent of tick heartbeat.
    const shimmer = ((state === 'thinking' || state === 'speaking') && !reduced) ? 0.5 + 0.5 * Math.sin(t * 3.4) : 0;

    // thin base ring
    c2d.beginPath();
    c2d.arc(c, c, R, 0, TAU);
    c2d.strokeStyle = 'rgba(210, 235, 255, 0.55)';
    c2d.lineWidth = 1.4;
    c2d.globalAlpha = breathe;
    c2d.shadowBlur = 10 + level * 14 + shimmer * 10;
    c2d.shadowColor = color;
    c2d.stroke();
    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;

    // brighter glint arcs at top and bottom (reference: highlighted ring segments)
    [[-TAU / 4 - 0.5, -TAU / 4 + 0.5], [TAU / 4 - 0.6, TAU / 4 + 0.6]].forEach(([a0, a1]) => {
      c2d.beginPath();
      c2d.arc(c, c, R, a0, a1);
      c2d.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      c2d.lineWidth = 2;
      c2d.shadowBlur = 12;
      c2d.shadowColor = '#cfeaff';
      c2d.stroke();
      c2d.shadowBlur = 0;
    });

    // secondary faint inner ring
    c2d.beginPath();
    c2d.arc(c, c, R * 0.94, 0, TAU);
    c2d.strokeStyle = 'rgba(120, 200, 255, 0.12)';
    c2d.lineWidth = 1;
    c2d.stroke();
  }

  function drawGlyph(c, R, color) {
    // diamond/hourglass glyph — two overlapping triangle outlines
    const gy = c - R * 0.42;
    const gw = R * 0.13;
    const gh = R * 0.11;
    c2d.strokeStyle = color;
    c2d.lineWidth = 1.4;
    c2d.shadowBlur = 6;
    c2d.shadowColor = color;
    c2d.beginPath(); // upper triangle (point down)
    c2d.moveTo(c - gw, gy - gh);
    c2d.lineTo(c + gw, gy - gh);
    c2d.lineTo(c, gy + gh * 0.4);
    c2d.closePath();
    c2d.stroke();
    c2d.beginPath(); // lower triangle (point up), overlapping
    c2d.moveTo(c - gw, gy + gh);
    c2d.lineTo(c + gw, gy + gh);
    c2d.lineTo(c, gy - gh * 0.4);
    c2d.closePath();
    c2d.stroke();
    c2d.shadowBlur = 0;
  }

  function drawWordmark(c, R) {
    // entity name — wide letterspaced light sans (reference "JARVIS" treatment)
    const name = entityName.toUpperCase();
    const px = Math.max(14, R * 0.22);
    c2d.font = `300 ${px}px Outfit, 'Segoe UI', sans-serif`;
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    const spaced = name.split('').join('  '); // hair-space tracking
    c2d.fillStyle = TEXT;
    c2d.shadowBlur = 14;
    c2d.shadowColor = 'rgba(180, 225, 255, 0.6)';
    c2d.fillText(spaced, c, c - R * 0.06);
    c2d.shadowBlur = 0;

    // status line
    const spx = Math.max(8, R * 0.075);
    c2d.font = `500 ${spx}px Outfit, 'Segoe UI', sans-serif`;
    c2d.fillStyle = statusColor();
    c2d.fillText(statusLine().split('').join(' '), c, c + R * 0.14);
  }

  function drawWaveform(c, R, color) {
    // EKG squiggle — flat baseline with heartbeat spikes; amplitude rides the
    // tick-pulse envelope (this IS the orb pulse, rendered as the reference's
    // waveform rather than a generic glow).
    const wy = c + R * 0.34;
    const half = R * 0.34;
    const amp = (reduced ? 0.4 : 0.35 + level * 1.4) * R * 0.045;
    const phase = reduced ? 0 : t * 2.2;
    c2d.beginPath();
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const x = c - half + frac * half * 2;
      // periodic EKG-ish shape: sparse sharp spikes over a soft wiggle
      const beat = Math.pow(Math.max(0, Math.sin(frac * Math.PI * 6 - phase)), 9);
      const wig = Math.sin(frac * Math.PI * 26 - phase * 3) * 0.18;
      const y = wy - (beat * 2.4 + wig) * amp;
      if (i === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    }
    c2d.strokeStyle = color;
    c2d.globalAlpha = 0.75;
    c2d.lineWidth = 1.2;
    c2d.shadowBlur = 5 + level * 8;
    c2d.shadowColor = color;
    c2d.stroke();
    c2d.globalAlpha = 1;
    c2d.shadowBlur = 0;
  }

  function frame(timestamp) {
    const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
    lastTime = timestamp;
    if (!reduced) t += dt;
    level = Math.max(0, level - dt * 1.6); // pulse decay
    if (actionFlash) {
      actionFlash.decay -= dt * 1.6;
      if (actionFlash.decay <= 0) actionFlash = null;
    }
    if (!reduced) {
      sparkTimer -= dt;
      if (sparkTimer <= 0) {
        spawnSpark(statusColor(), 1, ringR * 0.16);
        sparkTimer = 0.7 + Math.random() * 1.1;
      }
    }

    c2d.clearRect(0, 0, canvas.width, canvas.height);
    c2d.save();
    c2d.scale(dpr, dpr);
    const c = size / 2;
    const R = size * 0.46;
    ringR = R;
    const state = resolveState();
    const color = STATE_COLOR[state];
    drawAmbientParticles(c, R, color);
    drawRing(c, R, color, state);
    drawSynapseSparks(c, dt);
    drawGlyph(c, R, color);
    drawWordmark(c, R);
    drawWaveform(c, R, color);
    drawActionFlash(c, R);
    c2d.restore();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf && !document.hidden) { lastTime = 0; raf = requestAnimationFrame(frame); }
  }
  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }
  const onVis = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVis);

  if (ctx && ctx.onClick) {
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('mousedown', ctx.onClick);
  }

  // ---- live wiring ----
  const unsub = ctx.subscribe(['entity-state', 'tick', 'health', 'confirm-request'], (msg) => {
    if (msg.type === 'tick') {
      level = Math.min(1, level + 0.85); // one heartbeat per cognitive tick
      if (!reduced) spawnSpark(statusColor(), 2, ringR * 0.14);
    } else if (msg.type === 'entity-state') {
      if (msg.payload.name) entityName = msg.payload.name;
      entityStatus = msg.payload.status || entityStatus;
    } else if (msg.type === 'health') {
      const breakers = msg.payload.breakers || {};
      degraded = Object.values(breakers).some((b) => b.state !== 'closed');
    } else if (msg.type === 'confirm-request') {
      confirmPending = true;
      setTimeout(() => { confirmPending = false; }, 30000); // leash TTL window
    }
  });

  start();

  return {
    setDegraded(v) { degraded = !!v; },
    notifyConfirmResolved() { confirmPending = false; },
    // voice-loop states (idle|listening|processing|speaking) — each has its own
    // glow color: idle=cyan, listening=green, processing=purple, speaking=yellow.
    // Hardware states (downloading/disabled/error/unsupported) collapse to idle.
    setVoiceState(s) {
      voiceState = (s === 'listening' || s === 'processing' || s === 'speaking') ? s : 'idle';
    },
    // category comes from hud-canvas.js's toolTarget() — single source of
    // truth for tool->category mapping, never re-derived here.
    flashAction(category, ok) {
      const color = ACTION_COLORS[category] || ACCENT;
      actionFlash = { color, ok, decay: 1 };
      spawnSpark(color, 6, ringR * 0.26);
    },
    cleanup() {
      unsub();
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
