// breakers.js — circuit-breaker chips from the synthesized WS 'health' broadcast.
// Only non-closed breakers get a chip; all-closed shows a single calm line.

// Breaker names/states come off the WS health broadcast. They are provider and
// lane ids today, but `state` also lands in a class attribute — escape both
// rather than trust the shape of a server payload.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mountBreakers(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `<div class="widget-chips" data-role="chips"><span class="widget-sub mono">all circuits closed</span></div>`;
  const chipsEl = el.querySelector('[data-role="chips"]');

  const unsub = ctx.subscribe(['health'], (msg) => {
    const breakers = (msg.payload && msg.payload.breakers) || {};
    const open = Object.values(breakers).filter((b) => b.state !== 'closed');
    if (open.length === 0) {
      // xss-safe: static template, no interpolation
      chipsEl.innerHTML = `<span class="widget-sub mono">all circuits closed (${Object.keys(breakers).length})</span>`;
      return;
    }
    // xss-safe: all interpolated fields escaped
    chipsEl.innerHTML = open
      .map((b) => `<span class="widget-chip mono chip-${escapeHtml(b.state)}">${escapeHtml(b.name)} · ${escapeHtml(String(b.state).toUpperCase())}</span>`)
      .join('');
  });

  return unsub;
}
