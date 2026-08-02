// spend.js — brain-spend counter + tiny sparkline of calls per minute-bucket.
// Fed by WS 'brain-spend' broadcasts only.

const BUCKETS = 20;

export function mountSpend(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="widget-value mono" data-role="count">0</div>
    <div class="widget-sub mono" data-role="last">no brain calls yet</div>
    <canvas class="widget-spark" data-role="spark" width="150" height="28"></canvas>
  `;
  const countEl = el.querySelector('[data-role="count"]');
  const lastEl = el.querySelector('[data-role="last"]');
  const spark = el.querySelector('[data-role="spark"]');
  const sctx = spark.getContext('2d');

  let total = 0;
  const buckets = new Array(BUCKETS).fill(0);
  let bucketStart = Date.now();

  function rotateBuckets() {
    const now = Date.now();
    let steps = Math.floor((now - bucketStart) / 60000);
    if (steps <= 0) return;
    steps = Math.min(steps, BUCKETS);
    for (let i = 0; i < steps; i++) { buckets.shift(); buckets.push(0); }
    bucketStart = now;
  }

  function drawSpark() {
    const w = spark.width, h = spark.height;
    sctx.clearRect(0, 0, w, h);
    const max = Math.max(1, ...buckets);
    const bw = w / BUCKETS;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fd8ff';
    sctx.fillStyle = accent;
    buckets.forEach((v, i) => {
      const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - 2));
      sctx.globalAlpha = 0.35 + 0.65 * (v / max);
      sctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    });
    sctx.globalAlpha = 1;
  }

  const unsub = ctx.subscribe(['brain-spend'], (msg) => {
    rotateBuckets();
    total += 1;
    buckets[BUCKETS - 1] += 1;
    const p = msg.payload || {};
    countEl.textContent = String(total);
    lastEl.textContent = `${p.provider || '?'} · ${p.lane || '?'}`;
    drawSpark();
  });

  drawSpark();
  return unsub;
}
