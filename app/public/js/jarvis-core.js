// jarvis-core.js — unified NOVA Core reactor canvas. Three visual layers composited together:
//   Outer: hex geometric scaffolding (frames, brackets, scan line)
//   Mid:   arc kinetic energy (gradient rings, orbiting nodes, glow aura)
//   Inner: plasma living core (orb, swirling surface, corona)
// All layers share one state machine, palette, and speed multiplier.
// window.JarvisCore.mount(canvasEl, { onClick }) -> controller { setState(s), pulse(), destroy() }
(function () {
  'use strict';

  // ── palette (shared across all layers) ─────────────────────────────────────
  const PALETTE = {
    idle:             { r: 79, g: 216, b: 255, a: 0.45 },
    listening:        { r: 79, g: 216, b: 255, a: 1 },
    thinking:         { r: 164, g: 143, b: 255, a: 1 },
    acting:           { r: 67, g: 229, b: 160, a: 1 },
    speaking:         { r: 122, g: 132, b: 255, a: 1 },
    error:            { r: 255, g: 95, b: 102, a: 1 },
    'confirm-pending': { r: 234, g: 179, b: 8, a: 1 },
    degraded:         { r: 79, g: 216, b: 255, a: 0.25 },
    disabled:         { r: 79, g: 216, b: 255, a: 0.12 },
    'hands-free':     { r: 67, g: 229, b: 160, a: 1 },
  };

  const SPEED_MULT = {
    idle: 0.4, listening: 1, thinking: 2.6, acting: 1.8,
    speaking: 1.2, error: 0.15, 'confirm-pending': 0.6,
    degraded: 0.2, disabled: 0, 'hands-free': 0.8,
  };

  function rgba(c, a) {
    return `rgba(${c.r},${c.g},${c.b},${a !== undefined ? a : c.a})`;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  const TAU = Math.PI * 2;

  // Simple noise-like function from summed sines (no deps)
  function noiseField(x, y, t) {
    return Math.sin(x * 1.3 + t) * Math.cos(y * 0.9 + t * 0.7)
         + Math.sin(x * 0.7 - y * 1.1 + t * 1.3) * 0.5
         + Math.cos(x * 2.1 + y * 0.5 - t * 0.5) * 0.25;
  }

  // ── mount ─────────────────────────────────────────────────────────────────
  function mount(canvas, { onClick } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let state = 'idle';
    let size = 100;
    let raf = null;
    let lastTime = 0;
    let t = 0;
    let level = 0, targetLevel = 0;
    let pulseId = 0;
    let pulseRings = [];

    // ── hex layer state ─────────────────────────────────────────────────────
    const HEX_LAYERS = 3;
    const hexRotations = Array.from({ length: HEX_LAYERS }, () => Math.random() * TAU);

    // ── arc layer state ─────────────────────────────────────────────────────
    // [radiusFrac, arcSpanRad, baseSpeed, lineWidth, glowStrength]
    const ARC_RINGS = [
      [0.72, Math.PI * 1.5,  0.05, 1, 6],
      [0.66, Math.PI * 0.5, -0.15, 1.2, 8],
      [0.59, Math.PI * 1.2,  0.10, 1, 10],
      [0.52, Math.PI * 0.7, -0.22, 1.4, 12],
      [0.45, Math.PI * 1.4,  0.08, 1.2, 14],
      [0.38, Math.PI * 0.4, -0.28, 1.6, 16],
    ];
    const ARC_TICKS = 36;
    const arcAngles = ARC_RINGS.map(() => Math.random() * TAU);

    // Orbiting nodes
    const ORBIT_NODES = 10;
    const orbitAngles = Array.from({ length: ORBIT_NODES }, (_, i) =>
      (i / ORBIT_NODES) * TAU + Math.random() * 0.3
    );
    const orbitRadii = Array.from({ length: ORBIT_NODES }, () =>
      0.42 + Math.random() * 0.28
    );
    const orbitSpeeds = Array.from({ length: ORBIT_NODES }, () =>
      (0.12 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1)
    );

    // ── resize via ResizeObserver ────────────────────────────────────────────
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

    // ── layer 1: hex outer shell ─────────────────────────────────────────────
    function drawHexLayer(c, color, mult) {
      const col = color;

      // Corner brackets (frame the canvas)
      const bracketLen = c * 0.10;
      const bracketOff = c * 0.82;
      ctx.strokeStyle = rgba(col, 0.25 * col.a);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'square';
      // top-left
      ctx.beginPath();
      ctx.moveTo(c - bracketOff, c - bracketOff + bracketLen);
      ctx.lineTo(c - bracketOff, c - bracketOff);
      ctx.lineTo(c - bracketOff + bracketLen, c - bracketOff);
      ctx.stroke();
      // top-right
      ctx.beginPath();
      ctx.moveTo(c + bracketOff - bracketLen, c - bracketOff);
      ctx.lineTo(c + bracketOff, c - bracketOff);
      ctx.lineTo(c + bracketOff, c - bracketOff + bracketLen);
      ctx.stroke();
      // bottom-left
      ctx.beginPath();
      ctx.moveTo(c - bracketOff, c + bracketOff - bracketLen);
      ctx.lineTo(c - bracketOff, c + bracketOff);
      ctx.lineTo(c - bracketOff + bracketLen, c + bracketOff);
      ctx.stroke();
      // bottom-right
      ctx.beginPath();
      ctx.moveTo(c + bracketOff - bracketLen, c + bracketOff);
      ctx.lineTo(c + bracketOff, c + bracketOff);
      ctx.lineTo(c + bracketOff, c + bracketOff - bracketLen);
      ctx.stroke();

      // 3 hexagonal ring layers
      for (let layer = 0; layer < HEX_LAYERS; layer++) {
        if (!reduced) hexRotations[layer] += (0.015 + layer * 0.007) * mult * (layer % 2 ? -1 : 1) * (1 / 60);
        const rFrac = 0.88 - layer * 0.10;
        const hexR = Math.max(1, c * rFrac * (1 + level * 0.015));

        ctx.beginPath();
        for (let v = 0; v < 6; v++) {
          const angle = (v / 6) * TAU + hexRotations[layer];
          const vx = c + Math.cos(angle) * hexR;
          const vy = c + Math.sin(angle) * hexR;
          if (v === 0) ctx.moveTo(vx, vy);
          else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        const layerAlpha = (0.06 + 0.08 * (layer + 1)) * col.a;
        ctx.strokeStyle = rgba(col, layerAlpha);
        ctx.lineWidth = layer === 0 ? 1.2 : 0.8;
        ctx.stroke();

        // Segment dots — light up based on state intensity
        const segmentsLit = Math.floor(mult * 2 + level * 3);
        for (let seg = 0; seg < 6; seg++) {
          if (seg >= segmentsLit) continue;
          const segMid = (seg + 0.5) / 6 * TAU + hexRotations[layer];
          const midR = hexR * 0.93;
          ctx.beginPath();
          ctx.arc(c + Math.cos(segMid) * midR, c + Math.sin(segMid) * midR, 2, 0, TAU);
          ctx.fillStyle = rgba(col, 0.35 * col.a);
          ctx.fill();
        }
      }

      // Radial scan line
      const scanAngle = reduced ? 0 : t * 1.0 * mult;
      const scanR = c * 0.78;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(scanAngle) * scanR, c + Math.sin(scanAngle) * scanR);
      const scanGrad = ctx.createLinearGradient(c, c, c + Math.cos(scanAngle) * scanR, c + Math.sin(scanAngle) * scanR);
      scanGrad.addColorStop(0, rgba(col, 0));
      scanGrad.addColorStop(0.5, rgba(col, 0.25 * col.a));
      scanGrad.addColorStop(1, rgba(col, 0));
      ctx.strokeStyle = scanGrad;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ── layer 2: arc kinetic rings ──────────────────────────────────────────
    function drawArcLayer(c, color, mult) {
      const col = color;

      // Background aura glow
      const auraR = c * 0.65;
      const aura = ctx.createRadialGradient(c, c, c * 0.08, c, c, auraR);
      aura.addColorStop(0, rgba(col, 0.05 * col.a));
      aura.addColorStop(0.5, rgba(col, 0.015 * col.a));
      aura.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, size, size);

      // Energy pulse rings
      pulseRings.forEach(pr => {
        const prR = c * pr.radiusFrac;
        ctx.beginPath();
        ctx.arc(c, c, Math.max(1, prR), 0, TAU);
        ctx.strokeStyle = rgba(col, pr.alpha * col.a);
        ctx.lineWidth = 2 * pr.alpha;
        ctx.stroke();
      });

      // Arc rings
      ARC_RINGS.forEach((r, i) => {
        if (!reduced) arcAngles[i] += r[2] * mult * (1 / 60);
        const radius = Math.max(1, c * r[0] * (1 + level * 0.02));
        const startA = arcAngles[i];
        const endA = startA + r[1];

        ctx.beginPath();
        ctx.arc(c, c, radius, startA, endA);

        // Gradient stroke
        const gx1 = c + Math.cos(startA) * radius;
        const gy1 = c + Math.sin(startA) * radius;
        const gx2 = c + Math.cos(endA) * radius;
        const gy2 = c + Math.sin(endA) * radius;
        const grad = ctx.createLinearGradient(gx1, gy1, gx2, gy2);
        const baseAlpha = (0.12 + 0.5 * ((i + 1) / ARC_RINGS.length)) * col.a;
        grad.addColorStop(0, rgba(col, baseAlpha * 0.15));
        grad.addColorStop(0.3, rgba(col, baseAlpha));
        grad.addColorStop(0.7, rgba(col, baseAlpha));
        grad.addColorStop(1, rgba(col, baseAlpha * 0.08));

        ctx.strokeStyle = grad;
        ctx.lineWidth = r[3];
        ctx.lineCap = 'round';
        if (r[4] > 0 && state !== 'idle' && state !== 'disabled') {
          ctx.shadowBlur = r[4] * mult;
          ctx.shadowColor = rgba(col, 0.5);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      });

      // Inner full circle with ticks
      const innerR = Math.max(1, c * 0.35 * (1 + level * 0.02));
      ctx.beginPath();
      ctx.arc(c, c, innerR, 0, TAU);
      ctx.strokeStyle = rgba(col, 0.10);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      for (let ti = 0; ti < ARC_TICKS; ti++) {
        const a = (ti / ARC_TICKS) * TAU + (reduced ? 0 : arcAngles[ARC_RINGS.length - 1] * 0.06);
        const inner = innerR - 3;
        const outer = innerR;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
        ctx.lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
        ctx.strokeStyle = rgba(col, ti % 6 === 0 ? 0.35 : 0.1);
        ctx.lineWidth = ti % 6 === 0 ? 1.2 : 0.5;
        ctx.stroke();
      }

      // Orbiting nodes
      for (let n = 0; n < ORBIT_NODES; n++) {
        if (!reduced) orbitAngles[n] += orbitSpeeds[n] * mult * (1 / 60);
        const nr = c * orbitRadii[n] * (1 + level * 0.015);
        const nx = c + Math.cos(orbitAngles[n]) * nr;
        const ny = c + Math.sin(orbitAngles[n]) * nr;
        const nAlpha = (0.25 + 0.4 * Math.sin(t * 2 + n)) * col.a;
        ctx.beginPath();
        ctx.arc(nx, ny, 1.8, 0, TAU);
        ctx.fillStyle = rgba(col, nAlpha);
        if (state !== 'idle' && state !== 'disabled') {
          ctx.shadowBlur = 5;
          ctx.shadowColor = rgba(col, nAlpha * 0.4);
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // ── layer 3: plasma inner core ──────────────────────────────────────────
    function drawPlasmaCore(c, color, mult) {
      const col = color;

      const breathScale = 1 + Math.sin(t * 1.5 * mult) * 0.025 * mult + level * 0.04;
      const orbR = c * 0.22 * breathScale;

      // Corona glow layers
      for (let layer = 2; layer >= 0; layer--) {
        const coronaR = orbR * (1.3 + layer * 0.25);
        const corona = ctx.createRadialGradient(c, c, orbR * 0.4, c, c, coronaR);
        corona.addColorStop(0, rgba(col, 0));
        corona.addColorStop(0.35, rgba(col, (0.025 + layer * 0.008) * col.a));
        corona.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = corona;
        ctx.beginPath();
        ctx.arc(c, c, coronaR, 0, TAU);
        ctx.fill();
      }

      // Main orb body
      const bodyGrad = ctx.createRadialGradient(
        c - orbR * 0.2, c - orbR * 0.25, orbR * 0.05,
        c, c, orbR
      );
      bodyGrad.addColorStop(0, rgba({ r: 255, g: 255, b: 255 }, 0.25 * col.a));
      bodyGrad.addColorStop(0.15, rgba(col, 0.55 * col.a));
      bodyGrad.addColorStop(0.5, rgba(col, 0.3 * col.a));
      bodyGrad.addColorStop(0.8, rgba(col, 0.12 * col.a));
      bodyGrad.addColorStop(1, rgba(col, 0.02 * col.a));

      ctx.beginPath();
      ctx.arc(c, c, orbR, 0, TAU);
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      // Swirling plasma rings (clipped to orb)
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, orbR, 0, TAU);
      ctx.clip();

      const plasmaRings = 12;
      for (let pr = 0; pr < plasmaRings; pr++) {
        const rFrac = (pr + 1) / plasmaRings;
        const ringR = orbR * rFrac;
        ctx.beginPath();
        const steps = 60;
        for (let s = 0; s <= steps; s++) {
          const a = (s / steps) * TAU;
          const wobble = noiseField(a * 2, rFrac * 4, t * mult * 0.8) * orbR * 0.035;
          const rx = c + Math.cos(a) * (ringR + wobble);
          const ry = c + Math.sin(a) * (ringR + wobble);
          if (s === 0) ctx.moveTo(rx, ry);
          else ctx.lineTo(rx, ry);
        }
        ctx.closePath();
        const ringAlpha = (0.04 + 0.08 * Math.sin(rFrac * Math.PI)) * col.a;
        ctx.strokeStyle = rgba(col, ringAlpha);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Swirling hot spots
      const hotspots = 6;
      for (let h = 0; h < hotspots; h++) {
        const hAngle = (h / hotspots) * TAU + t * mult * (0.25 + h * 0.04);
        const hDist = orbR * (0.25 + 0.35 * Math.abs(Math.sin(t * 0.7 + h)));
        const hx = c + Math.cos(hAngle) * hDist;
        const hy = c + Math.sin(hAngle) * hDist;
        const hR = orbR * 0.07 + Math.sin(t * 2 + h) * orbR * 0.025;
        const hotGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, Math.max(1, hR));
        hotGrad.addColorStop(0, rgba({ r: 255, g: 255, b: 255 }, 0.2 * col.a));
        hotGrad.addColorStop(0.5, rgba(col, 0.1 * col.a));
        hotGrad.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = hotGrad;
        ctx.beginPath();
        ctx.arc(hx, hy, Math.max(1, hR), 0, TAU);
        ctx.fill();
      }

      ctx.restore();

      // Specular highlight
      const specGrad = ctx.createRadialGradient(
        c - orbR * 0.25, c - orbR * 0.3, 0,
        c - orbR * 0.25, c - orbR * 0.3, orbR * 0.4
      );
      specGrad.addColorStop(0, rgba({ r: 255, g: 255, b: 255 }, 0.12 * col.a));
      specGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(c, c, orbR, 0, TAU);
      ctx.fill();

      // Center bright dot
      const dotR = Math.max(1, orbR * 0.12 + level * orbR * 0.15 + (state === 'listening' || state === 'hands-free' ? 1.5 : 0));
      ctx.beginPath();
      ctx.arc(c, c, dotR, 0, TAU);
      ctx.fillStyle = rgba({ r: 255, g: 255, b: 255 }, 0.6 * col.a);
      ctx.shadowBlur = 8;
      ctx.shadowColor = rgba(col, 0.4);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // ── animation loop ────────────────────────────────────────────────────────

    function frame(timestamp) {
      const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
      lastTime = timestamp;

      if (!reduced) t += dt * (SPEED_MULT[state] || 1);

      const c = size / 2;
      const color = PALETTE[state] || PALETTE.idle;
      const mult = SPEED_MULT[state] || 1;

      level += (targetLevel - level) * 0.12;

      // Update pulse rings
      pulseRings.forEach(pr => {
        pr.radiusFrac += dt * 0.7;
        pr.alpha -= dt * 1.1;
      });
      pulseRings = pulseRings.filter(pr => pr.alpha > 0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // Composite: outer → mid → inner
      drawHexLayer(c, color, mult);
      drawArcLayer(c, color, mult);
      drawPlasmaCore(c, color, mult);

      ctx.restore();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (!raf && !document.hidden) {
        lastTime = 0;
        raf = requestAnimationFrame(frame);
      }
    }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }

    const onVis = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener('visibilitychange', onVis);

    if (onClick) {
      canvas.style.cursor = 'pointer';
      canvas.addEventListener('mousedown', onClick);
      canvas.addEventListener('touchstart', onClick, { passive: false });
    }

    start();

    return {
      setState(s) {
        const prev = state;
        state = PALETTE[s] ? s : 'idle';
        if (prev !== state && state !== 'disabled' && state !== 'degraded') {
          pulseRings.push({ radiusFrac: 0.25, alpha: 0.5 });
        }
      },
      pulse(v = 1) {
        const id = ++pulseId;
        targetLevel = Math.max(targetLevel, Math.min(1, v));
        setTimeout(() => {
          if (pulseId === id) targetLevel = 0;
        }, 120);
      },
      destroy() {
        stop();
        ro.disconnect();
        document.removeEventListener('visibilitychange', onVis);
      },
    };
  }

  window.JarvisCore = { mount };
})();
