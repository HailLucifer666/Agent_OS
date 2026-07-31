// actions.js — live agent-action feed: WS 'action' broadcasts into a small ring
// buffer. WS-only (anti-drift #6) — no polling.
//
// THREE states, not two (Wave 0 evidence contract, src/core/effectors/evidence.js).
// This widget used to draw `p.ok ? '✓' : '✗'`, so a tick meant "the tool call
// returned", never "the thing happened". On 2026-07-31 it ticked three ui_type
// calls while the screenshot MYTHOS took 28s later showed an empty Notepad — the
// panel was, in good faith, corroborating a fabrication. An effector that cannot
// prove the world changed now reports unverified:true, and that gets its own
// glyph rather than borrowing the success one.
//
//   ✓ gold  — verified: an oracle other than the call itself confirmed it
//   ~ warn  — attempted: the call returned, nothing could confirm it landed
//   ✗ faint — failed
//
// Every interpolated string goes through escapeHtml() per the HUD-wide rule (see
// kinds/dynamic.js's header). That is load-bearing here, not ceremony: from
// Wave 2 onward `reason` carries text read back out of the target control, i.e.
// whatever the operator dictated, straight into innerHTML.

const MAX_ROWS = 8;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ok + unverified -> the middle state. Kept in one place so the HUD and the
// voice layer cannot drift into disagreeing about what a tick means.
function glyphFor(p) {
  if (!p.ok) return { mark: '✗', cls: 'text-faint', label: 'failed' };
  if (p.unverified) return { mark: '~', cls: 'text-warn', label: 'attempted, not confirmed' };
  return { mark: '✓', cls: 'text-gold', label: 'verified' };
}

export function mountActions(el, ctx) {
  el.innerHTML = `<div class="widget-feed" data-role="feed"><div class="widget-sub mono">no actions yet</div></div>`;
  const feed = el.querySelector('[data-role="feed"]');
  const rows = [];

  const unsub = ctx.subscribe(['action'], (msg) => {
    const p = msg.payload || {};
    const g = glyphFor(p);
    const reason = p.reason
      ? ` <span class="text-faint">${escapeHtml(p.reason)}</span>`
      : '';
    rows.push(
      `<div class="widget-feed-row mono">` +
      `<span class="${g.cls}" title="${g.label}" aria-label="${g.label}">${g.mark}</span> ` +
      `${escapeHtml(p.tool || '?')}${reason}</div>`
    );
    if (rows.length > MAX_ROWS) rows.shift();
    feed.innerHTML = rows.slice().reverse().join('');
  });

  return unsub;
}
