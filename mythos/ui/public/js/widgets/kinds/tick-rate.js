// tick-rate.js — cognitive cadence: measured from deltas between WS 'tick'
// broadcasts (never a client-side interval guessing the server's).

export function mountTickRate(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="widget-value mono" data-role="rate">—</div>
    <div class="widget-sub mono" data-role="tick">awaiting first tick</div>
  `;
  const rateEl = el.querySelector('[data-role="rate"]');
  const tickEl = el.querySelector('[data-role="tick"]');

  let lastAt = 0;
  const deltas = [];

  const unsub = ctx.subscribe(['tick'], (msg) => {
    const now = performance.now();
    if (lastAt) {
      deltas.push(now - lastAt);
      if (deltas.length > 10) deltas.shift();
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      rateEl.textContent = `${(1000 / avg).toFixed(2)} Hz`;
    }
    lastAt = now;
    tickEl.textContent = `tick #${msg.payload.tick}`;
  });

  return unsub;
}
