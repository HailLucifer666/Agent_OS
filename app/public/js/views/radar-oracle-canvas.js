// radar-oracle-canvas.js — decorative particle wolf-head visual for The Radar.
// Pure canvas 2D animation, not data-dependent (no live signal data feeds this).

const SIGNAL_NODES = [
  { x: 0.50, y: 0.14, color: '#39d8e8' }, // cyan, top
  { x: 0.20, y: 0.38, color: '#3ddc84' }, // green, left
  { x: 0.80, y: 0.38, color: '#3ddc84' }, // green, right
  { x: 0.24, y: 0.78, color: '#8b5cf6' }, // purple, lower-left
  { x: 0.76, y: 0.78, color: '#8b5cf6' }, // purple, lower-right
  { x: 0.50, y: 0.92, color: '#e0785a' }, // red, bottom
];

// Builds a rough triangular-eared wolf/animal head silhouette out of point samples
// using a set of overlapping shape regions, tested via a signed "inside" function.
function isInsideHead(nx, ny) {
  // nx, ny normalized 0..1 within the canvas. Origin top-left.
  const cx = 0.5;
  const headTop = 0.16;
  const headBottom = 0.86;

  // Ears: two triangles near the top.
  const inLeftEar = ny > headTop && ny < 0.34 &&
    nx > 0.30 - (ny - headTop) * 0.35 && nx < 0.30 + (ny - headTop) * 0.55;
  const inRightEar = ny > headTop && ny < 0.34 &&
    nx < 0.70 + (ny - headTop) * 0.35 && nx > 0.70 - (ny - headTop) * 0.55;

  // Head mass: an elongated rounded diamond-ish silhouette narrowing to a snout.
  const bodyY = Math.max(0, Math.min(1, (ny - 0.28) / (headBottom - 0.28)));
  const widthAtY = 0.30 * Math.sin(Math.PI * Math.min(bodyY * 1.15, 1)) * (1 - bodyY * 0.25) + 0.05;
  const inHeadBody = ny >= 0.28 && ny <= headBottom && Math.abs(nx - cx) < widthAtY;

  // Snout taper near the bottom.
  const snoutY = (ny - 0.72) / (headBottom - 0.72);
  const inSnout = ny > 0.72 && ny <= headBottom && Math.abs(nx - cx) < 0.14 * (1 - snoutY * 0.4);

  return inLeftEar || inRightEar || inHeadBody || inSnout;
}

export function createOracleCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = window.devicePixelRatio || 1;
  let particles = [];
  let rafId = null;
  let destroyed = false;
  let t = 0;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedParticles();
  }

  function seedParticles() {
    particles = [];
    const density = Math.max(900, Math.floor((width * height) / 550));
    let attempts = 0;
    while (particles.length < density && attempts < density * 25) {
      attempts += 1;
      const nx = Math.random();
      const ny = Math.random() * 0.9 + 0.05;
      if (isInsideHead(nx, ny)) {
        particles.push({
          x: nx * width,
          y: ny * height,
          r: Math.random() * 1.4 + 0.4,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.015 + 0.005,
        });
      }
    }
  }

  function draw() {
    if (destroyed) return;
    t += 1;
    ctx.clearRect(0, 0, width, height);

    // faint radar rings
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.min(width, height) / 2;
    ctx.strokeStyle = 'rgba(57, 216, 232, 0.12)';
    ctx.lineWidth = 1;
    [0.55, 0.85].forEach((f, i) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
      ctx.stroke();
      void i;
    });

    // rotating sweep line
    const sweepAngle = (t * 0.004) % (Math.PI * 2);
    const grad = ctx.createLinearGradient(
      cx, cy,
      cx + Math.cos(sweepAngle) * maxR * 0.85,
      cy + Math.sin(sweepAngle) * maxR * 0.85,
    );
    grad.addColorStop(0, 'rgba(57, 216, 232, 0.25)');
    grad.addColorStop(1, 'rgba(57, 216, 232, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAngle) * maxR * 0.85, cy + Math.sin(sweepAngle) * maxR * 0.85);
    ctx.stroke();

    // particle dust
    ctx.fillStyle = '#39d8e8';
    particles.forEach((p) => {
      const shimmer = 0.45 + 0.55 * Math.abs(Math.sin(t * p.speed + p.phase));
      ctx.globalAlpha = shimmer * 0.85;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    // signal nodes
    SIGNAL_NODES.forEach((node, i) => {
      const px = node.x * width;
      const py = node.y * height;
      const pulse = 0.75 + 0.25 * Math.sin(t * 0.03 + i);
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(px, py, 6 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(px, py, 12 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    rafId = requestAnimationFrame(draw);
  }

  resize();
  draw();

  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  return {
    nodePositions: () => SIGNAL_NODES.map((n) => ({ x: n.x, y: n.y, color: n.color })),
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    },
  };
}
