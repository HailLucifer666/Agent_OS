'use strict';

// vector-index.js — tiny cosine-similarity index over memory embeddings.
// One JSON sidecar per store under vault/Index/<store>.vec.json:
//   { provider, dim, items: [{ ref, vec: [..], ts }] }
// Loaded into Float32Arrays at init, appended on write, saved debounced.
// Partitioned by embedding provider — vectors from different providers are
// never comparable, so a provider switch resets the index (honest restart,
// reindex() rebuilds). Capped at MAX_ITEMS, oldest pruned first.
// Pure math + fs-store; no network. Never throws to callers.

const MAX_ITEMS = 5000;
const SAVE_DEBOUNCE_MS = 2000;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function createVectorIndex({ fs, store }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function') {
    throw new Error('createVectorIndex requires a vault fs-store with readJSON/writeJSON');
  }
  if (!store) throw new Error('createVectorIndex requires a store name');

  const relPath = `Index/${store}.vec.json`;
  let provider = null;
  let dim = 0;
  let items = []; // { ref, vec: Float32Array, ts }
  let saveTimer = null;

  function init() {
    try {
      const data = fs.readJSON(relPath, null);
      if (data && Array.isArray(data.items)) {
        provider = data.provider || null;
        dim = data.dim || 0;
        items = data.items
          .filter((it) => it && it.ref && Array.isArray(it.vec) && it.vec.length === dim)
          .map((it) => ({ ref: it.ref, vec: Float32Array.from(it.vec), ts: it.ts || 0 }));
      }
    } catch { items = []; provider = null; dim = 0; }
    return { count: items.length, provider, dim };
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeJSON(relPath, {
          provider, dim,
          items: items.map((it) => ({ ref: it.ref, vec: Array.from(it.vec), ts: it.ts })),
        });
      } catch { /* index is a cache — losing a save never breaks memory */ }
    }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  // add(ref, embedding) — embedding = { provider, dim, vec }. Provider switch
  // resets the index (old vectors incomparable with the new provider's space).
  function add(ref, embedding) {
    if (!ref || !embedding || !embedding.vec) return false;
    if (provider !== embedding.provider || dim !== embedding.dim) {
      provider = embedding.provider;
      dim = embedding.dim;
      items = [];
    }
    // replace an existing entry for the same ref
    const idx = items.findIndex((it) => it.ref === ref);
    if (idx !== -1) items.splice(idx, 1);
    items.push({ ref, vec: embedding.vec, ts: Date.now() });
    if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
    scheduleSave();
    return true;
  }

  // search(embedding, k) -> [{ ref, score }] best-first. Empty when the query
  // embedding's provider doesn't match the index partition.
  function search(embedding, k) {
    if (!embedding || !embedding.vec || embedding.provider !== provider || embedding.dim !== dim) return [];
    const scored = items.map((it) => ({ ref: it.ref, score: cosine(embedding.vec, it.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k || 10);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      fs.writeJSON(relPath, {
        provider, dim,
        items: items.map((it) => ({ ref: it.ref, vec: Array.from(it.vec), ts: it.ts })),
      });
    } catch { /* cache */ }
  }

  function stats() { return { store, count: items.length, provider, dim }; }

  return { init, add, search, flush, stats };
}

// Reciprocal-rank fusion of N ranked lists of { ref, ... }. k=60 standard.
function rrfMerge(lists, k) {
  k = k || 60;
  const scores = new Map(); // ref -> { item, score }
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const prev = scores.get(item.ref);
      const add = 1 / (k + rank + 1);
      if (prev) prev.score += add;
      else scores.set(item.ref, { item, score: add });
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ ...e.item, score: e.score }));
}

module.exports = { createVectorIndex, rrfMerge, cosine };
