// actions.js — live agent-action feed: WS 'action' broadcasts into a small ring
// buffer. WS-only (anti-drift #6) — no polling.

const MAX_ROWS = 8;

export function mountActions(el, ctx) {
  el.innerHTML = `<div class="widget-feed" data-role="feed"><div class="widget-sub mono">no actions yet</div></div>`;
  const feed = el.querySelector('[data-role="feed"]');
  const rows = [];

  const unsub = ctx.subscribe(['action'], (msg) => {
    const p = msg.payload || {};
    rows.push(`<div class="widget-feed-row mono"><span class="${p.ok ? 'text-gold' : 'text-faint'}">${p.ok ? '✓' : '✗'}</span> ${p.tool || '?'}${p.reason ? ` <span class="text-faint">${p.reason}</span>` : ''}</div>`);
    if (rows.length > MAX_ROWS) rows.shift();
    feed.innerHTML = rows.slice().reverse().join('');
  });

  return unsub;
}
