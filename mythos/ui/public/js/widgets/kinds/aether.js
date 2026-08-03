// aether.js — "NEAREST DEVICE" widget chip.
// Paints the live Aether focus owner + RSSI, sourced from the 'perception' WS
// broadcast. The server's perception.* relay (server/index.js) slims each
// perception to {channel, kind, salience, text} — so this widget paints from
// `text` (the sensor's summary: "Nearest: PC · -59 dBm"). Flashes briefly on
// any change, which naturally marks a handoff (owner name flips in the text).

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function mountAether(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `<div class="widget-chips" data-role="chips"><span class="widget-sub mono">no device</span></div>`;
  const chipsEl = el.querySelector('[data-role="chips"]');
  let flashTimer = null;

  function flash() {
    chipsEl.classList.add('chip-flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => chipsEl.classList.remove('chip-flash'), 600);
  }

  const unsub = ctx.subscribe(['perception'], (msg) => {
    const p = msg.payload;
    if (!p || p.kind !== 'aether') return;
    const text = p.text || 'aether';
    flash();
    // xss-safe: escaped interpolation
    chipsEl.innerHTML = `<span class="widget-chip mono">${escapeHtml(text)}</span>`;
  });

  return () => { if (flashTimer) clearTimeout(flashTimer); unsub(); };
}
