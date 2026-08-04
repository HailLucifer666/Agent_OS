// aether.js — "NEAREST DEVICE" widget chip.
// Paints the live Aether focus owner + RSSI, sourced from the 'perception' WS
// broadcast. The server's perception.* relay (server/index.js) slims each
// perception to {channel, kind, salience, text} — so this widget paints from
// `text` (the sensor's summary: "Nearest: PC · -59 dBm"). Flashes briefly on
// any change, which naturally marks a handoff (owner name flips in the text)
// and clears to "…Aether offline" when the aggregator drops.

import { h, cleanupBag } from '../../dom.js';

export function mountAether(el, ctx) {
  const bag = cleanupBag();

  // One chip element; its text is always a real text node (xss-safe by
  // construction — no innerHTML, no escape helper needed).
  const chip = h('span', { class: 'widget-sub mono' }, 'no device');
  el.replaceChildren(h('div', { class: 'widget-chips' }, chip));

  // Flash is a CSS animation gated by the class; the timer removes it so the
  // next change restarts cleanly. Re-adding the class mid-flash restarts it —
  // new data means a new flash.
  let flashTimer = null;
  bag.add(() => { if (flashTimer) clearTimeout(flashTimer); });
  function flash() {
    chip.classList.add('chip-flash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => chip.classList.remove('chip-flash'), 600);
  }

  bag.add(ctx.subscribe(['perception'], (msg) => {
    const p = msg.payload;
    if (!p || p.kind !== 'aether') return;
    chip.textContent = p.text || 'aether';
    // Live reading gets the chip style (vs. the muted "no device" placeholder).
    chip.className = 'widget-chip mono';
    flash();
  }));

  return () => bag.run();
}
