// core-orb.js — the central HUD circle, drawn to match the JARVIS reference
// mockup exactly: dark disc with a thin bright ice-blue ring (brighter glints
// top/bottom), a diamond glyph, the entity's wordmark (config.MYTHOS_NAME via
// the entity-state broadcast — never hardcoded), a status line driven by real
// entity state, and an EKG-style waveform that pulses with the tick cadence.
//
// Rendering mechanics (dpr scaling, ResizeObserver, pulse envelope, reduced-
// motion, visibilitychange pause) are CA from app/public/js/jarvis-core.js;
// the drawn content is the reference design instead of the abstract plasma orb.

const TAU = Math.PI * 2;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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

  let size = 100;
  let raf = null;
  let lastTime = 0;
  let t = 0;
  let level = 0;          // pulse envelope 0..1 (decays)
  let entityName = 'MYTHOS';
  let entityStatus = 'booting'; // booting | alive | stopped
  let degraded = false;
  let confirmPending = false;

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

  function statusLine() {
    if (entityStatus === 'stopped') return 'ENTITY OFFLINE';
    if (entityStatus !== 'alive') return 'ENTITY BOOTING';
    if (confirmPending) return 'AWAITING CONFIRM';
    if (degraded) return 'ENTITY DEGRADED';
    return 'ENTITY ONLINE';
  }

  function statusColor() {
    if (entityStatus !== 'alive') return DIM;
    if (confirmPending) return WARN;
    if (degraded) return DANGER;
    return ACCENT;
  }

  // ---- drawing ----
  function drawRing(c, R) {
    // faint fill disc — a touch lighter than the page, glassy
    const disc = c2d.createRadialGradient(c, c - R * 0.5, R * 0.1, c, c, R);
    disc.addColorStop(0, 'rgba(30, 45, 70, 0.55)');
    disc.addColorStop(0.7, 'rgba(12, 20, 34, 0.75)');
    disc.addColorStop(1, 'rgba(6, 10, 18, 0.9)');
    c2d.beginPath();
    c2d.arc(c, c, R, 0, TAU);
    c2d.fillStyle = disc;
    c2d.fill();

    // thin base ring
    c2d.beginPath();
    c2d.arc(c, c, R, 0, TAU);
    c2d.strokeStyle = 'rgba(210, 235, 255, 0.55)';
    c2d.lineWidth = 1.4;
    c2d.shadowBlur = 10 + level * 14;
    c2d.shadowColor = ACCENT;
    c2d.stroke();
    c2d.shadowBlur = 0;

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

  function drawGlyph(c, R) {
    // diamond/hourglass glyph — two overlapping triangle outlines
    const gy = c - R * 0.42;
    const gw = R * 0.13;
    const gh = R * 0.11;
    c2d.strokeStyle = ACCENT;
    c2d.lineWidth = 1.4;
    c2d.shadowBlur = 6;
    c2d.shadowColor = ACCENT;
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
    const spaced = name.split('').join('  '); // hair-space tracking
    c2d.fillStyle = TEXT;
    c2d.shadowBlur = 14;
    c2d.shadowColor = 'rgba(180, 225, 255, 0.6)';
    c2d.fillText(spaced, c, c - R * 0.06);
    c2d.shadowBlur = 0;

    // status line
    const spx = Math.max(8, R * 0.075);
    c2d.font = `500 ${spx}px Outfit, 'Segoe UI', sans-serif`;
    c2d.fillStyle = statusColor();
    c2d.fillText(statusLine().split('').join(' '), c, c + R * 0.14);
  }

  function drawWaveform(c, R) {
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
    c2d.strokeStyle = ACCENT;
    c2d.globalAlpha = 0.75;
    c2d.lineWidth = 1.2;
    c2d.shadowBlur = 5 + level * 8;
    c2d.shadowColor = ACCENT;
    c2d.stroke();
    c2d.globalAlpha = 1;
    c2d.shadowBlur = 0;
  }

  function frame(timestamp) {
    const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
    lastTime = timestamp;
    if (!reduced) t += dt;
    level = Math.max(0, level - dt * 1.6); // pulse decay

    c2d.clearRect(0, 0, canvas.width, canvas.height);
    c2d.save();
    c2d.scale(dpr, dpr);
    const c = size / 2;
    const R = size * 0.46;
    drawRing(c, R);
    drawGlyph(c, R);
    drawWordmark(c, R);
    drawWaveform(c, R);
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
    cleanup() {
      unsub();
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
