// memory-widget.js — a glanceable list of what the entity actually knows: the
// most recent semantic topics, with a live count.
//
// Named memory-widget.js, not memory.js, to stay unambiguous against
// src/core/memory/ and ui/public/js/views/memory.js (the full overlay panel).
// This is the card, not a second memory browser.
//
// WHY THERE IS NO RECALL-STRENGTH BAR, though the mockup had one:
// design/mythos-living-core.html's Memory panel showed a strength meter per
// entry, and porting it looked easy — recall() genuinely computes a score, and
// server/routes/memory.js discards it. But the route browses with recall(''),
// and an empty query makes that score DEGENERATE: ''.split(/\s+/) is [''], not
// [], so semantic.js gets terms=[''], every lower.includes('') is true,
// matched=1, and score is 1/1 for EVERY entry. A bar drawn from that is 100%
// full on every row, always, while looking exactly like a real measurement.
// Worse than showing nothing. So the route keeps discarding the score, and
// this widget shows only facts it can stand behind.

import { h, keyedList, cleanupBag } from '../../dom.js';

const LIMIT = 8;
const POLL_MS = 30000;

// Pure. Exported for node:test.
// Newest first — `ts` is the sidecar's updated stamp. Entries with no timestamp
// sort last rather than being dropped; they are real memories, we just cannot
// place them in time.
export function rankMemories(entries, limit) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.summary)
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.ts) || -Infinity;
      const bt = Date.parse(b.ts) || -Infinity;
      return bt - at;
    })
    .slice(0, limit || LIMIT);
}

export function mountMemoryWidget(el, ctx) {
  const bag = cleanupBag();

  const headline = h('div', { class: 'widget-value-text mono text-faint' }, 'loading…');
  const list = h('div', { class: 'widget-feed' });
  el.replaceChildren(headline, list);

  let disposed = false;
  bag.add(() => { disposed = true; });

  function clear() {
    keyedList(list, [], (x) => x, () => h('div'));
  }

  function paint(entries, unreadable) {
    if (unreadable) {
      headline.textContent = 'memory unreachable';
      clear();
      return;
    }
    const ranked = rankMemories(entries, LIMIT);
    if (!ranked.length) {
      headline.textContent = 'no semantic memories yet';
      clear();
      return;
    }
    headline.textContent = `${entries.length} topic${entries.length === 1 ? '' : 's'}`;

    keyedList(
      list,
      ranked,
      // ponytail: summary#index is collision-safe for rendering but re-keys
      // rows when the list reorders. Ceiling: expose the semantic record's
      // stable sidecar id through /api/memory/semantic (server/routes/memory.js
      // deliberately strips it, along with score) and key on that instead.
      (e, i) => e.summary + '#' + i,
      (e) => h('div', { class: 'widget-feed-row mono', title: e.summary }, e.summary),
      (node, e) => { node.textContent = e.summary; node.title = e.summary; },
    );
  }

  async function load() {
    try {
      const res = await fetch('/api/memory/semantic?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (disposed) return;
      paint((data && data.entries) || [], false);
    } catch {
      // The fetch failed, so we never read the store. Distinct from "the store
      // is empty", and must not be shown as it.
      if (disposed) return;
      paint([], true);
    }
  }

  load();
  const timer = setInterval(load, POLL_MS);
  bag.add(() => clearInterval(timer));
  if (ctx && typeof ctx.onRefresh === 'function') bag.add(ctx.onRefresh(() => load()));

  return () => bag.run();
}
