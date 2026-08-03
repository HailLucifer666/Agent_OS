// terminal.js — a compact tail of the backend log stream, as a widget.
//
// NOT a replacement for views/backend-terminal.js. That overlay panel is the
// full instrument: four event types, health anomalies, action rows, tag chips.
// This is the glanceable version — the last N `log` lines only — for operators
// who want a running pulse on the card layer without opening a panel.
//
// Colour conventions are deliberately COPIED from backend-terminal.js's
// .terminal-level-* rules (info=--text-dim, warn=--status-degraded,
// error=--status-warn, debug=--text-faint) so the same severity never renders
// two different colours in two places in the same HUD.
//
// Data: WS 'log', payload shape from src/core/logger.js
//   { ts: ISOString, level: 'debug'|'info'|'warn'|'error', msg: string, ...extra }
// Subscribed with {replay:true} — server/index.js keeps a ring buffer for 'log'
// (replayBuffers, server/index.js), so a card mounted mid-session backfills
// instead of sitting empty until the next log line happens to fire.

import { h, keyedList } from '../../dom.js';

const MAX_LINES = 40;

const LEVEL_CLASS = {
  debug: 'text-faint',
  info: 'text-dim',
  warn: 'text-warn',
  error: 'text-warn',
};

// Pure. Exported for node:test — the truncation and level-defaulting rules are
// the only logic here worth pinning down.
export function normalizeLogLine(payload, fallbackSeq) {
  const p = payload || {};
  const level = LEVEL_CLASS[p.level] ? p.level : 'info';
  return {
    // ts is an ISO string from the logger; it is unique enough per line in
    // practice, but two lines can share a millisecond, so the sequence number
    // guarantees a stable keyedList key either way.
    key: `${p.ts || ''}#${fallbackSeq}`,
    level,
    time: shortTime(p.ts),
    msg: String(p.msg == null ? '' : p.msg),
  };
}

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 8);
}

export function mountTerminal(el, ctx) {
  const list = h('div', { class: 'widget-feed' });
  const empty = h('div', { class: 'widget-value-text mono text-faint' }, 'no log lines yet');
  el.replaceChildren(empty, list);

  const lines = [];
  let seq = 0;

  function paint() {
    empty.style.display = lines.length ? 'none' : '';
    keyedList(
      list,
      lines,
      (l) => l.key,
      (l) => h('div', { class: 'widget-feed-row mono', title: l.msg },
        h('span', { class: 'text-faint' }, l.time ? `${l.time} ` : ''),
        h('span', { class: LEVEL_CLASS[l.level] }, l.msg),
      ),
      // Rows are immutable once rendered — a log line never changes after it is
      // emitted, so there is nothing to patch. keyedList still reuses the node.
      undefined,
    );
  }

  const unsub = ctx.subscribe(['log'], (msg) => {
    lines.push(normalizeLogLine(msg && msg.payload, seq++));
    // Newest at the bottom, matching a real terminal. Trim from the front.
    while (lines.length > MAX_LINES) lines.shift();
    paint();
    list.scrollTop = list.scrollHeight;
  }, { replay: true });

  paint();
  return unsub;
}
