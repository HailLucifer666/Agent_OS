import { escapeHtml } from '../../url.js';
// actions.js — live agent-action feed: WS 'action' broadcasts into a small ring
// buffer. WS-only (anti-drift #6) — no polling.
//
// FOUR states, not two (Wave 0 evidence contract, src/core/effectors/evidence.js).
// This widget used to draw `p.ok ? '✓' : '✗'`, so a tick meant "the tool call
// returned", never "the thing happened". On 2026-07-31 it ticked three ui_type
// calls while the screenshot MYTHOS took 28s later showed an empty Notepad — the
// panel was, in good faith, corroborating a fabrication. An effector that cannot
// prove the world changed now reports unverified:true, and that gets its own
// glyph rather than borrowing the success one.
//
// Separately (reported 2026-08-12): a denial or a breaker block carries no
// `ok` at all — only 'action.completed' has one — so `!p.ok` used to paint a
// REFUSAL with the same faint '✗' as a genuine failure. Refused means nothing
// was attempted; the relay now sends an explicit `state` so the widget can
// tell "the leash said no" apart from "it ran and broke".
//
//   ✓ gold  — verified: an oracle other than the call itself confirmed it
//   ~ warn  — attempted: the call returned, nothing could confirm it landed
//   ✗ faint — failed: the call ran and did not work
//   ⊘ warn  — refused: the leash denied or the breaker blocked it. NOT a failure
//             — nothing was attempted, and the operator can usually approve it.
//
// Every interpolated string goes through escapeHtml() per the HUD-wide rule (see
// kinds/dynamic.js's header). That is load-bearing here, not ceremony: from
// Wave 2 onward `reason` carries text read back out of the target control, i.e.
// whatever the operator dictated, straight into innerHTML.

const MAX_ROWS = 8;

// BUG-273 D2 — wall-clock HH:MM:SS for one action row, or null when the relay sent
// no timestamp (an older server, or a replayed row from before this field existed).
// Returning null rather than a placeholder is deliberate: a fabricated time on a row
// whose time is unknown is exactly the class of false certainty this fix is about.
//
// Q1/PRIVACY — WHY A CLOCK AND NOT THE ARGUMENTS. Arguments would disambiguate two
// same-tool rows far better, and they must not be rendered: whatsapp_send carries the
// message text and the recipient's phone number, and this feed sits on a HUD that is
// screen-shared and screenshotted. The clock is the smallest thing that separates two
// rows without putting anything new on screen.
export function rowClock(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// state + ok + unverified -> which of the four glyphs. Kept in one place so
// the HUD and the voice layer cannot drift into disagreeing about what a tick
// means. Exported (like media.js's formatClock) so node:test can reach it
// without a DOM.
export function glyphFor(p) {
  if (p.state === 'denied' || p.state === 'blocked') {
    return { mark: '⊘', cls: 'text-warn', label: 'refused' };
  }
  if (!p.ok) return { mark: '✗', cls: 'text-faint', label: 'failed' };
  if (p.unverified) return { mark: '~', cls: 'text-warn', label: 'attempted, not confirmed' };
  return { mark: '✓', cls: 'text-gold', label: 'verified' };
}

export function mountActions(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `<div class="widget-feed" data-role="feed"><div class="widget-sub mono">no actions yet</div></div>`;
  const feed = el.querySelector('[data-role="feed"]');
  const rows = [];

  const unsub = ctx.subscribe(['action'], (msg) => {
    const p = msg.payload || {};
    const g = glyphFor(p);
    const reason = p.reason
      ? ` <span class="text-faint">${escapeHtml(p.reason)}</span>`
      : '';
    // BUG-273 D2: escaped like everything else here even though it is generated from
    // a number — this row builder has one rule (see the header) and an exception is
    // how the next interpolated field arrives unescaped.
    const clock = rowClock(p.ts);
    const when = clock ? ` <span class="text-faint">${escapeHtml(clock)}</span>` : '';
    rows.push(
      `<div class="widget-feed-row mono">` +
      `<span class="${g.cls}" title="${g.label}" aria-label="${g.label}">${g.mark}</span>` +
      `${when} ` +
      `${escapeHtml(p.tool || '(unnamed action)')}${reason}</div>`
    );
    if (rows.length > MAX_ROWS) rows.shift();
    // xss-safe: static template, no interpolation
    feed.innerHTML = rows.slice().reverse().join('');
  });

  return unsub;
}
