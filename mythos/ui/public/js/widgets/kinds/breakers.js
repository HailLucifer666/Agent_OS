// breakers.js — circuit-breaker chips from the synthesized WS 'health' broadcast.
// Only non-closed breakers get a chip; all-closed shows a single calm line.

export function mountBreakers(el, ctx) {
  el.innerHTML = `<div class="widget-chips" data-role="chips"><span class="widget-sub mono">all circuits closed</span></div>`;
  const chipsEl = el.querySelector('[data-role="chips"]');

  const unsub = ctx.subscribe(['health'], (msg) => {
    const breakers = (msg.payload && msg.payload.breakers) || {};
    const open = Object.values(breakers).filter((b) => b.state !== 'closed');
    if (open.length === 0) {
      chipsEl.innerHTML = `<span class="widget-sub mono">all circuits closed (${Object.keys(breakers).length})</span>`;
      return;
    }
    chipsEl.innerHTML = open
      .map((b) => `<span class="widget-chip mono chip-${b.state}">${b.name} · ${b.state.toUpperCase()}</span>`)
      .join('');
  });

  return unsub;
}
