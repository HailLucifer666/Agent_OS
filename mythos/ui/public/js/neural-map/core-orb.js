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

// hex '#rrggbb' -> 'rgba(r,g,b,a)' — canvas gradients need explicit alpha stops
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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
  // dpr capped at 1.5: the ~800-particle swarm is fill-cost-bound (each glowDot
  // is 2 arc fills), and on 2x/3x screens that cost scales with dpr^2 while the
  // visual gain past 1.5 is negligible for these soft additive dots.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ACCENT = cssVar('--accent', '#4fd8ff');
  const TEXT = cssVar('--text', '#d7e3f4');
  const DIM = cssVar('--text-dim', '#8ba3c4');
  const DANGER = cssVar('--danger', '#ff5f66');
  const WARN = cssVar('--status-degraded', '#eab308');
  const THINKING = cssVar('--module-goals', '#a78bfa'); // matches mic-processing (voice.css)

  // ---- orb state palette: the SINGLE source of truth is the --orb-* CSS tokens
  // (Phase 1 shipped them in semantic.css). All hardcoded state hues are gone;
  // these read tokens with the SAME fallback hexes so a missing token is a no-op.
  const STATE_HEX = {
    offline: cssVar('--orb-offline', '#8ba3c4'),
    booting: cssVar('--orb-booting', '#8ba3c4'),
    confirm: cssVar('--orb-confirm', '#eab308'),
    degraded: cssVar('--orb-degraded', '#ff5f66'),
    thinking: cssVar('--orb-thinking', '#a78bfa'),
    listening: cssVar('--orb-listening', '#43e5a0'),
    speaking: cssVar('--orb-speaking', '#f5d020'),
    online: cssVar('--orb-online', '#4fd8ff'),
    // Wave 2 (2026-08-13): s2s-bridge.js's mic-suspend gate (own-TTS/media
    // echo guard) used to drop frames while the orb kept showing 'listening'
    // — the operator had no visual reason to doubt they were being heard.
    // Reuses the dim/offline token rather than inventing a new hue: this is
    // "not actually listening right now", closer to offline than to any
    // active state.
    muted: cssVar('--orb-offline', '#8ba3c4'),
  };
  // idle/online share the accent token; legacy local aliases kept for ACTION_COLORS
  // and the per-state plasma/orbital code below, which still read named consts.
  const LISTENING = STATE_HEX.listening;
  const SPEAKING = STATE_HEX.speaking;

  const ACTION_COLORS = {
    goals: THINKING,
    kanban: cssVar('--module-kanban', '#2dd4bf'),
    pipeline: cssVar('--module-pipeline', '#34d399'),
    memory: cssVar('--module-memory', '#60a5fa'),
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
  let activity = 0;             // live voice amplitude 0..1 (speaking halo waves)
  let ringR = 46;                // updated each frame; sparks/particles read this
  let actionFlash = null;        // { color, ok, decay }
  let shockwave = 0;             // swarm kick envelope 0..1 (decays like `level`);
                                 // briefly expands the swarm radius in the action color.
  let speakPulse = 0;            // TTS-cadence envelope 0..1 (decays like `level`).
                                 // Fed by pulseSpeaking() on each speech-chunk WS msg,
                                 // because the mic is muted during playback (voice-loop
                                 // BUG-027) so setActivity() never fires while speaking.
                                 // Drives the speaking-state exhale wobble.
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
  // STATE_COLOR now aliases STATE_HEX (token-backed). Local consts (DIM/WARN/...)
  // are kept above only for ACTION_COLORS / plasma tinting reads.
  const STATE_COLOR = STATE_HEX;
  const STATE_LINE = {
    offline: 'ENTITY OFFLINE', booting: 'ENTITY BOOTING', confirm: 'AWAITING CONFIRM',
    degraded: 'ENTITY DEGRADED', thinking: 'PROCESSING', listening: 'LISTENING',
    speaking: 'SPEAKING', online: 'ENTITY ONLINE', muted: 'MIC MUTED',
  };

  function resolveState() {
    if (entityStatus === 'stopped') return 'offline';
    if (entityStatus !== 'alive') return 'booting';
    if (confirmPending) return 'confirm';
    if (degraded) return 'degraded';
    if (voiceState === 'speaking') return 'speaking';
    if (voiceState === 'processing') return 'thinking';
    if (voiceState === 'muted') return 'muted';
    if (voiceState === 'listening') return 'listening';
    return 'online';
  }
  function statusColor() { return STATE_COLOR[resolveState()]; }
  function statusLine() { return STATE_LINE[resolveState()]; }

  // aria-live announce — #hud-status-live is one of exactly three live regions
  // in the whole HUD (the others: kanban.js's #kanban-note, conversation.js's
  // sr-only #conv-live transcript mirror); this pushes STATE_LINE[state] only on
  // an actual state TRANSITION, never per frame (resolveState() is recomputed
  // every frame for drawing; echoing at that rate makes a screen reader unusable).
  const statusLiveEl = document.getElementById('hud-status-live');
  let lastAnnouncedState = null;
  function announceState(state) {
    if (state === lastAnnouncedState) return;
    lastAnnouncedState = state;
    if (statusLiveEl) statusLiveEl.textContent = STATE_LINE[state];
  }

  // ---- Fibonacci-sphere iridescent swarm (~800 particles) ----
  // Replaces the old 48-particle halo. Built ONCE with mulberry32 (stable across
  // frames/resizes — never flickers). Each particle stores its Fibonacci base
  // direction (x,y,z) on the unit sphere plus a per-particle phase/size seed;
  // the per-frame physics (curl turbulence, breathing, rotation, hue) is computed
  // in the draw loop from those fixed bases + time + state. No allocation in the
  // hot loop: positions reuse a typed array, color reuses the scratch object below.
  // ponytail: WebGL instanced-points shader is the ceiling for higher counts /
  // true bloom on GPU-capable machines — see redesign PLAN.
  const SWARM_COUNT = 800;
  const GOLDEN_ANGLE = 2.399963229728653;          // golden angle for Fibonacci sphere
  const swarmRand = mulberry32(0xA11CE0DE);
  // SoA layout: x,y,z = unit-sphere base direction; phase = per-particle hue/size
  // seed; size = base dot radius (px, before depth scaling). Float32 so the loop
  // is cache-friendly and there is zero GC pressure.
  const swarmX = new Float32Array(SWARM_COUNT);
  const swarmY = new Float32Array(SWARM_COUNT);
  const swarmZ = new Float32Array(SWARM_COUNT);
  const swarmPhase = new Float32Array(SWARM_COUNT);
  const swarmSize = new Float32Array(SWARM_COUNT);
  for (let i = 0; i < SWARM_COUNT; i++) {
    const frac = (i + 0.5) / SWARM_COUNT;
    const y0 = 1.0 - 2.0 * frac;
    const r0 = Math.sqrt(Math.max(0.0, 1.0 - y0 * y0));
    const th = GOLDEN_ANGLE * i;
    swarmX[i] = r0 * Math.cos(th);
    swarmY[i] = y0;
    swarmZ[i] = r0 * Math.sin(th);
    swarmPhase[i] = swarmRand() * TAU;
    swarmSize[i] = 0.7 + swarmRand() * 1.1;
  }

  // module-level reusable HSL->RGB scratch (THREE.Color.setHSL equivalent, inline
  // so the swarm loop never calls `new` and never allocates a string per particle
  // — we set c2d.fillStyle once to the rgba string built into `colorRGBA`).
  const rgbScratch = { r: 0, g: 0, b: 0 };
  function hslToRgb(h, s, l) {
    // h in [0,1); s,l in [0,1]. Writes into rgbScratch and returns it.
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
    };
    rgbScratch.r = f(0); rgbScratch.g = f(8); rgbScratch.b = f(4);
    return rgbScratch;
  }

  // hex '#rrggbb' -> hue in [0,1) (used to pull the iridescent palette toward the
  // resolved state's base color). Cheap avg of the RGB->HSV hue; saturation/light
  // still come from the reference iridescent formula so the swarm shimmers.
  function hexHue(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 0.52;             // grey -> default cyan-violet base
    const d = mx - mn;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    return h < 0 ? h + 1 : h;
  }
  // Precomputed iridescent palette. Hue is continuous across the swarm, so we
  // quantize it to HUE_BINS bins and cache the rgb() strings ONCE. sat/light
  // vary per state, so the palette is rebuilt ONLY when they change (state
  // transitions are infrequent — a few/sec at most — so this rebuild is ~0 GC
  // pressure in the 60fps hot loop). This is the fix for the per-particle
  // template-literal `rgb(...)` that would otherwise churn ~48k short-lived
  // strings/sec at 800 particles — the exact pattern the GlitterWrap reference
  // calls out as the main cause of GC-pause stutter.
  const HUE_BINS = 36; // 10deg resolution — imperceptible across an additive shimmer
  const SWARM_PALETTE = new Array(HUE_BINS);
  let _paletteSat = -1, _paletteLight = -1;
  function buildSwarmPalette(sat, light) {
    if (sat === _paletteSat && light === _paletteLight) return;
    _paletteSat = sat; _paletteLight = light;
    for (let b = 0; b < HUE_BINS; b++) {
      const rgb = hslToRgb(b / HUE_BINS, sat, light);
      SWARM_PALETTE[b] = `rgb(${(rgb.r * 255) | 0},${(rgb.g * 255) | 0},${(rgb.b * 255) | 0})`;
    }
  }

  // Precompute the base hue for each state once (state set is closed & tiny) so
  // the loop reads a single number, not hexHue() per particle.
  const STATE_HUE = Object.fromEntries(
    Object.entries(STATE_HEX).map(([k, hex]) => [k, hexHue(hex)])
  );

  // Reusable per-frame physics factors (filled once at the top of drawSwarm from
  // `state`, then read inside the loop — no per-particle branching on state).
  const swarmFx = {
    flowMul: 1,        // time scale
    rotMul: 1,         // golden-angle spin speed (t*0.25 base)
    turbMul: 1,        // curl turbulence amplitude
    radiusMul: 1,      // base radius multiplier (inhale/exhale/shockwave)
    radiusWobble: 0,   // additive sinusoidal radius term (speaking pulse)
    wobbleFreq: 7,     // frequency of that wobble
    sat: 0.75,         // HSL saturation
    light: 0.6,        // HSL lightness
    alphaMul: 1,       // global alpha multiplier (offline dim)
    hueBase: STATE_HUE.online,
  };
  function applySwarmFx(state) {
    // Reset to defaults then layer state-specific multiplicative terms. These are
    // SMALL additions, not branchy overrides — the iridescent shimmer + breathing
    // still run underneath.
    swarmFx.flowMul = 1;
    swarmFx.rotMul = 1;
    swarmFx.turbMul = 1;
    swarmFx.radiusMul = 1;
    swarmFx.radiusWobble = 0;
    swarmFx.wobbleFreq = 7;
    swarmFx.sat = 0.75;
    swarmFx.light = 0.6;
    swarmFx.alphaMul = 1;
    swarmFx.hueBase = STATE_HUE[state] ?? STATE_HUE.online;
    if (reduced) {
      // prefers-reduced-motion: freeze time evolution. We still draw the swarm so
      // the orb reads as a textured sphere, but t contributions are clamped.
      swarmFx.flowMul = 0;
      swarmFx.turbMul = 0;
      swarmFx.radiusWobble = 0;
    }
    // action-flash shockwave decays like `level` and briefly expands the swarm.
    if (shockwave > 0) swarmFx.radiusMul *= 1 + shockwave * 0.15;
    switch (state) {
      case 'listening':
        // inhale: radius breathes IN (contracts), turbulence tightens, green tint.
        swarmFx.radiusMul *= reduced ? 1 : (1 - 0.08 * Math.sin(t * 2.618));
        swarmFx.turbMul *= 0.8;
        swarmFx.sat = 0.7; swarmFx.light = 0.58;
        break;
      case 'speaking':
        // exhale/pulse outward, warm yellow. The mic is muted during TTS playback
        // (voice-loop BUG-027) so `activity` stays 0 — we pulse from the TTS
        // chunk cadence instead (speakPulse, fed by pulseSpeaking() on each
        // speech-chunk WS msg). max() so a nonzero mic activity still wins if
        // the S2S duplex path ever feeds one.
        swarmFx.radiusWobble = 0.12 * Math.max(activity, speakPulse);
        swarmFx.sat = 0.8; swarmFx.light = 0.62;
        break;
      case 'thinking':
      case 'processing':
        // faster vortex: spin multiplier up, turbulence up, purple.
        swarmFx.rotMul = 2.4;     // t*0.25 -> ~t*0.6
        swarmFx.turbMul = 1.4;
        swarmFx.sat = 0.72; swarmFx.light = 0.6;
        break;
      case 'confirm':
        // slow shimmer, near-freeze — dampen all motion toward 0.3x, amber.
        swarmFx.flowMul *= 0.3;
        swarmFx.rotMul *= 0.3;
        swarmFx.turbMul *= 0.3;
        swarmFx.radiusWobble = 0;
        swarmFx.sat = 0.75; swarmFx.light = 0.58;
        break;
      case 'degraded':
        // scatter: boost turbulence, reduce coherence (lower sat so it reads sickly).
        swarmFx.turbMul = 1.8;
        swarmFx.sat = 0.6; swarmFx.light = 0.55;
        break;
      case 'offline':
      case 'booting':
        // dim stillness: motion ~0, alpha ~0.4x.
        swarmFx.flowMul = 0;
        swarmFx.rotMul = 0;
        swarmFx.turbMul = 0.2;
        swarmFx.alphaMul = 0.4;
        break;
      // idle/online: default iridescent drift — no modulation needed.
    }
  }

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

  function drawSwarm(c, R, color, state) {
    // Port of the reference ai_orb.jsx frame-body, converted Three.js -> Canvas2D.
    // The Fibonacci bases are unit-sphere; we project (px,py,pz in [-1,1]) onto
    // R*0.9 so the swarm fills ~0.9 of the ring (sits just inside the glass disc).
    applySwarmFx(state);
    const fx = swarmFx;
    // Rebuild the cached palette only when sat/light actually change (state
    // transitions) — then the hot loop does an integer bin lookup, zero allocs.
    buildSwarmPalette(fx.sat, fx.light);
    const projScale = R * 0.9;                       // unit-sphere coords -> canvas px
    // reference constants (kept named so the port is auditable against ai_orb.jsx)
    const flow = 0.8;
    const turb = 0.45;
    const shell = 0.25;
    const hueShift = 0.35;
    const tt = t * flow * fx.flowMul;                // frozen when reduced/offline
    const dist = turb * 0.22 * fx.turbMul;
    const rotA = tt * (0.25 * fx.rotMul);
    const cA = Math.cos(rotA), sA = Math.sin(rotA);

    // Additive blending for the swarm — overlapping dots accumulate into a glow.
    c2d.save();
    c2d.globalCompositeOperation = 'lighter';

    for (let i = 0; i < SWARM_COUNT; i++) {
      const bx = swarmX[i], by = swarmY[i], bz = swarmZ[i], ph = swarmPhase[i];
      // layered sine "curl" turbulence (reference w1/w2/w3)
      const w1 = Math.sin(3.0 * bx + tt * 1.7 + Math.cos(2.0 * bz - tt)) * Math.cos(2.0 * by - tt * 1.3);
      const w2 = Math.sin(4.0 * bz - tt * 1.1 + Math.cos(3.0 * bx + tt * 0.7)) * Math.cos(3.0 * by + tt);
      const w3 = Math.sin(2.0 * by + tt * 2.1 + Math.cos(4.0 * bx - tt * 0.5)) * Math.cos(2.0 * bz + tt * 0.9);
      // breathing + band shell (radial modulation). Reference uses golden-angle*0.5
      // inside the shell gate; we approximate with the particle's base angle so the
      // gate still varies per-particle without re-deriving th from i each frame.
      const breath = 1.0 + 0.06 * Math.sin(tt * 1.2) + 0.03 * Math.sin(tt * 2.7 + 1.3);
      const band = 0.5 + 0.5 * Math.sin(ph + tt * 0.6);     // ph replaces frac*6.28318*3.0 band term
      const shellMix = band * shell;
      const shellGate = 0.55 + 0.35 * Math.sin(ph * 0.5 + tt);
      const rMod = breath * (1.0 - shellMix * shellGate);
      // Y-rotation (project x/z through rotA)
      const xr = bx * cA - bz * sA;
      const zr = bx * sA + bz * cA;
      // 3D position in unit-sphere space, scaled by breath*rMod
      const pxU = (xr + w1 * dist) * rMod;
      const pyU = (by + w2 * dist * 1.15) * rMod;
      const pzU = (zr + w3 * dist) * rMod;
      // orthographic projection onto the canvas, with depth for size/alpha
      const sx = c + pxU * projScale;
      const sy = c + pyU * projScale;
      const depth = (pzU + 1) * 0.5;                        // 0 back .. 1 front
      // state-reactive radius modulation (inhale/exhale/shockwave)
      const radState = fx.radiusMul * (1 + fx.radiusWobble * Math.sin(tt * fx.wobbleFreq + ph));
      // iridescent HSL palette pulled toward the state's base hue. Hue quantized
      // to HUE_BINS and looked up in the prebuilt SWARM_PALETTE — zero per-
      // particle string alloc, zero hslToRgb calls in the hot loop.
      const swirl = 0.5 + 0.5 * Math.sin(by * 2.0 + xr * 1.5 + tt * 1.4 + w1 * 2.0);
      let hue = fx.hueBase + hueShift * 0.28 * swirl + 0.05 * Math.sin(tt * 0.5 + ph);
      hue = hue - Math.floor(hue);                          // wrap to [0,1) (hue % 1.0)
      const bin = (hue * HUE_BINS) | 0;                     // 0..HUE_BINS-1
      const pcolor = SWARM_PALETTE[bin < HUE_BINS ? bin : HUE_BINS - 1];
      // depth-scaled size + alpha; back particles smaller/dimmer. projScale carries R.
      const sz = swarmSize[i] * (0.6 + depth * 0.8) * radState;
      const a = (0.10 + depth * 0.32) * fx.alphaMul;
      // glowDot does the soft halo + core dot (2 arc fills); per-particle a via globalAlpha.
      glowDot(sx, sy, sz, pcolor, a);
    }
    c2d.globalAlpha = 1;
    c2d.restore();              // resets globalCompositeOperation to 'source-over'
  }

  // ---- plasma core — drifting additive radial gradients, bloom rides state + activity ----
  function drawPlasmaCore(c, R, color, state) {
    const boost = state === 'speaking' ? 0.5 + activity * 0.6
      : state === 'thinking' ? 0.45
      : state === 'listening' ? 0.35 : 0.25;
    c2d.save();
    c2d.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = reduced ? i * 2.1 : t * (0.30 + i * 0.17) + i * 2.1;
      const ox = Math.cos(a) * R * 0.10, oy = Math.sin(a * 1.31) * R * 0.10;
      const rad = R * (0.50 + i * 0.14);
      const g = c2d.createRadialGradient(c + ox, c + oy, 0, c + ox, c + oy, rad);
      g.addColorStop(0, hexA(color, 0.10 + boost * 0.12));
      g.addColorStop(0.55, hexA(color, 0.04 + boost * 0.05));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c2d.fillStyle = g;
      c2d.beginPath(); c2d.arc(c, c, R * 0.98, 0, TAU); c2d.fill();
    }
    // chromatic rim: violet outer wash for depth (fixed, not state-colored)
    const rim = c2d.createRadialGradient(c, c, R * 0.86, c, c, R);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(140, 120, 255, 0.06)');
    c2d.fillStyle = rim;
    c2d.beginPath(); c2d.arc(c, c, R, 0, TAU); c2d.fill();
    c2d.restore();
  }

  // ---- orbital system — tilted ellipses + comet tracers with tails ----
  const ORBITS = [
    { rx: 1.30, ry: 0.40, tilt: -0.55, speed: 0.22, dir: 1 },
    { rx: 1.46, ry: 0.34, tilt: 0.85, speed: 0.15, dir: -1 },
    { rx: 1.64, ry: 0.48, tilt: 0.15, speed: 0.09, dir: 1, minSize: 280 }, // desktop only
  ];
  function drawOrbitals(c, R, color) {
    ORBITS.forEach((o) => {
      if (o.minSize && size < o.minSize) return;
      c2d.save();
      c2d.translate(c, c);
      c2d.rotate(o.tilt);
      c2d.beginPath();
      c2d.ellipse(0, 0, R * o.rx, R * o.rx * o.ry, 0, 0, TAU);
      c2d.strokeStyle = color;
      c2d.globalAlpha = 0.09;
      c2d.lineWidth = 1;
      c2d.stroke();
      c2d.globalAlpha = 1;
      if (!reduced) {
        const a = t * o.speed * o.dir * TAU * 0.16 + o.tilt * 7; // deterministic phase spread
        for (let k = 5; k >= 0; k--) {                            // tail first, head last
          const ak = a - o.dir * k * 0.06;
          const px = Math.cos(ak) * R * o.rx, py = Math.sin(ak) * R * o.rx * o.ry;
          glowDot(px, py, k === 0 ? 1.7 : 1.1, color, (1 - k / 6) * (k === 0 ? 0.9 : 0.35));
        }
      }
      c2d.restore();
    });
  }

  // ---- arc rings — two counter-rotating broken arcs just outside the base ring ----
  const ARC_RINGS = [
    { r: 1.09, w: 1.6, speed: 0.55, dir: 1, segs: [[0.0, 1.35], [2.1, 0.55], [3.3, 1.85], [5.6, 0.4]] },
    { r: 1.15, w: 0.9, speed: 0.34, dir: -1, segs: [[0.5, 2.2], [3.2, 0.5], [4.4, 1.15]] },
  ];
  function arcSpeedMul(state) {
    if (state === 'thinking') return 1.8;
    if (state === 'speaking') return 1.0 + activity * 1.4;
    if (state === 'listening') return 0.55;
    return 1;
  }
  function drawArcRings(c, R, color, state) {
    const mul = arcSpeedMul(state);
    ARC_RINGS.forEach((ring) => {
      const rot = reduced ? 0 : t * ring.speed * ring.dir * mul;
      c2d.save();
      c2d.strokeStyle = color;
      c2d.lineWidth = ring.w;
      c2d.lineCap = 'round';
      c2d.globalAlpha = 0.55;
      c2d.shadowBlur = 6;
      c2d.shadowColor = color;
      ring.segs.forEach(([a0, len]) => {
        c2d.beginPath();
        c2d.arc(c, c, R * ring.r, a0 + rot, a0 + rot + len);
        c2d.stroke();
      });
      c2d.restore();
    });
  }

  // ---- neural web — fibonacci-sphere nodes rotating inside the orb, synapse
  // edges, traveling firing pulses (independent of the synapse-spark radial FX) ----
  const WEB_NODES = Array.from({ length: 24 }, (_, i) => {
    const y = 1 - (i / 23) * 2;
    const rXZ = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * Math.PI * (3 - Math.sqrt(5)); // golden angle
    return { x: Math.cos(theta) * rXZ, y, z: Math.sin(theta) * rXZ };
  });
  // precompute: each node's 2 nearest neighbors -> unique edge list
  const WEB_EDGES = (() => {
    const edges = new Set();
    WEB_NODES.forEach((n, i) => {
      const near = WEB_NODES.map((m, j) => ({ j, d: (n.x - m.x) ** 2 + (n.y - m.y) ** 2 + (n.z - m.z) ** 2 }))
        .filter((e) => e.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
      near.forEach((e) => edges.add(i < e.j ? `${i}-${e.j}` : `${e.j}-${i}`));
    });
    return [...edges].map((k) => k.split('-').map(Number));
  })();
  let firings = [];      // { edgeIdx, prog }  cap 6
  let fireTimer = 0.6;

  function webProject(n, rot, R) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const x = n.x * cos - n.z * sin;
    const z = n.x * sin + n.z * cos;
    return { sx: x * R * 0.58, sy: n.y * R * 0.42, depth: (z + 1) / 2 }; // depth 0(back)..1(front)
  }
  function drawNeuralWeb(c, R, color, state, dt) {
    const rot = reduced ? 0.8 : t * 0.25;
    const pts = WEB_NODES.map((n) => webProject(n, rot, R));
    // edges (behind nodes)
    WEB_EDGES.forEach(([a, b]) => {
      const d = (pts[a].depth + pts[b].depth) / 2;
      c2d.beginPath();
      c2d.moveTo(c + pts[a].sx, c + pts[a].sy);
      c2d.lineTo(c + pts[b].sx, c + pts[b].sy);
      c2d.strokeStyle = color;
      c2d.globalAlpha = 0.05 + d * 0.10;
      c2d.lineWidth = 0.7;
      c2d.stroke();
      c2d.globalAlpha = 1;
    });
    // firing pulses — spawn cadence: thinking 3x faster
    if (!reduced) {
      fireTimer -= dt * (state === 'thinking' ? 3 : 1);
      if (fireTimer <= 0) {
        firings.push({ edgeIdx: Math.floor(Math.random() * WEB_EDGES.length), prog: 0 });
        if (firings.length > 6) firings.shift();
        fireTimer = 0.5 + Math.random() * 1.2;
      }
    }
    for (let i = firings.length - 1; i >= 0; i--) {
      const f = firings[i];
      f.prog += dt * 1.8;
      if (f.prog >= 1) { firings.splice(i, 1); continue; }
      const [a, b] = WEB_EDGES[f.edgeIdx];
      const e = f.prog < 0.5 ? 2 * f.prog * f.prog : 1 - Math.pow(-2 * f.prog + 2, 2) / 2; // easeInOut
      const x = c + pts[a].sx + (pts[b].sx - pts[a].sx) * e;
      const y = c + pts[a].sy + (pts[b].sy - pts[a].sy) * e;
      glowDot(x, y, 1.4, color, 0.85 * Math.sin(f.prog * Math.PI));
      if (f.prog > 0.85) glowDot(c + pts[b].sx, c + pts[b].sy, 2.2, color, (f.prog - 0.85) * 5); // arrival flare
    }
    // nodes (front)
    pts.forEach((p) => glowDot(c + p.sx, c + p.sy, 0.8 + p.depth * 0.9, color, 0.10 + p.depth * 0.30));
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
    // faint fill disc — a touch lighter than the page, glassy (alphas trimmed
    // ~30% vs the 48-halo era: the ~800-particle additive swarm + plasma core
    // now provide the orb's body luminance underneath this, so the disc only
    // needs to read as tinted glass rather than re-darken the whole sphere).
    const disc = c2d.createRadialGradient(c, c - R * 0.5, R * 0.1, c, c, R);
    disc.addColorStop(0, 'rgba(30, 45, 70, 0.33)');
    disc.addColorStop(0.7, 'rgba(12, 20, 34, 0.45)');
    disc.addColorStop(1, 'rgba(6, 10, 18, 0.54)');
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
    c2d.shadowBlur = 10;
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
      const beat = Math.pow(Math.max(0, Math.sin(frac * Math.PI * 4 - phase)), 9);
      const wig = Math.sin(frac * Math.PI * 26 - phase * 3) * 0.18;
      const y = wy - (beat * 2.4 + wig) * amp;
      if (i === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    }
    c2d.strokeStyle = color;
    c2d.globalAlpha = 0.65;
    c2d.lineWidth = 1.0;
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
    shockwave = Math.max(0, shockwave - dt * 1.6); // swarm-kick decay (same envelope as level)
    speakPulse = Math.max(0, speakPulse - dt * 2.2); // TTS-cadence decay — slightly faster than shockwave so each chunk pops
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
    announceState(state);
    drawPlasmaCore(c, R, color, state);      // behind everything
    drawOrbitals(c, R, color);               // tilted ellipses + comets
    drawSwarm(c, R, color, state);           // ~800-particle Fibonacci iridescent swarm (additive)
    drawRing(c, R, color, state);            // glass disc + base ring sit on top of the swarm
    drawArcRings(c, R, color, state);        // Jarvis broken arcs
    drawNeuralWeb(c, R, color, state, dt);   // internal synapse web
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
    // voice-loop states (idle|listening|processing|speaking|muted) — each has
    // its own glow color: idle=cyan, listening=green, processing=purple,
    // speaking=yellow, muted=dim (Wave 2, 2026-08-13 — s2s-bridge.js's mic gate).
    // Hardware states (downloading/disabled/error/unsupported) collapse to idle.
    setVoiceState(s) {
      voiceState = (s === 'listening' || s === 'processing' || s === 'speaking' || s === 'muted') ? s : 'idle';
    },
    // live voice amplitude 0..1 — drives the speaking-state plasma boost, arc
    // speed, and outward halo waves. Harmless no-op at other states.
    setActivity(v) { activity = Math.max(0, Math.min(1, Number(v) || 0)); },
    // TTS-cadence kick — called by app.js on each speech-chunk WS msg while
    // MYTHOS is speaking. The mic is muted during playback so setActivity gets
    // no signal; this is the synthetic pulse that drives the speaking exhale.
    // Spikes speakPulse to 1, decays in the frame loop. Harmless at other states.
    pulseSpeaking() { speakPulse = 1; },
    // category comes from hud-canvas.js's toolTarget() — single source of
    // truth for tool->category mapping, never re-derived here.
    flashAction(category, ok) {
      const color = ACTION_COLORS[category] || ACCENT;
      actionFlash = { color, ok, decay: 1 };
      shockwave = 1;                          // kick the swarm: expands radius outward briefly
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
