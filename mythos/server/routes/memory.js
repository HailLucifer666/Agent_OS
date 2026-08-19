'use strict';

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

// server/routes/memory.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: memory (the facade with episodic/semantic/skills/identity/audit).
// The MEMORY_STORES allowlist is route-private — promoted INTO the factory
// per rule §4.2 #10 (was a closure const, only these routes read it).

const MEMORY_STORES = new Set(['episodic', 'semantic', 'skills', 'identity', 'audit']);

function mountMemoryRoutes(app, deps) {
  const { memory } = deps;

  // ---- /api/memory/:store — spec-mandated route ("omitted above for space"),
  // backed by each store's real browse surface: episodic.tail, semantic/skills/
  // identity recall('') (empty query matches every entry — verified against the
  // shipped scorers), audit.query. Entries are normalized to {ts, summary, kind}
  // so the memory view renders every store identically. ----
  app.get('/api/memory/:store', (req, res) => {
    const store = req.params.store;
    if (!MEMORY_STORES.has(store)) return res.status(404).json({ error: `unknown store: ${store}` });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
      let entries = [];
      if (store === 'episodic') {
        entries = memory.episodic.tail(limit).filter(Boolean).map((e) => ({
          ts: e.ts, summary: e.summary || '', kind: e.kind || 'episode',
        }));
      } else if (store === 'audit') {
        // Not every audit entry is a leash decision — immune heal records carry
        // no tier/tool, so both fields degrade to placeholders, never 'undefined'.
        entries = memory.audit.query({ limit }).map((e) => ({
          ts: e.ts, summary: `T${e.tier !== undefined && e.tier !== null ? e.tier : '-'} ${e.decision || '?'} ${e.tool || ''}`.trim(), kind: 'decision',
        }));
      } else {
        entries = memory[store].recall('', { limit }).map((r) => ({
          ts: (r.record && (r.record.ts || (r.record.sidecar && r.record.sidecar.updated))) || null,
          summary: (r.record && r.record.topic ? r.record.topic + ': ' : '') + (r.snippet || ''),
          kind: store,
          // NOT exposing r.score here, deliberately — it is degenerate on THIS
          // call path. recall('') passes an empty query, and
          // ''.split(/\s+/) is [''] (length 1, not 0), so semantic.js:162-165
          // computes terms=[''], lower.includes('') === true, matched=1,
          // score = 1/1 for EVERY entry. Forwarding that would let a HUD widget
          // draw a 100%-full "recall strength" bar on every row and present it
          // as a measurement. The score is meaningful for a real query; on the
          // browse call it is a constant wearing a number's clothes.
        }));
      }
      res.json({ store, entries });
    } catch (err) {
      res.status(500).json({ error: sanitizeRestError(err) });
    }
  });

  // ---- /api/audit/recent — BUG-019: fetch recent audit entries for panel history ----
  app.get('/api/audit/recent', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const entries = memory.audit.query({ limit });
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: sanitizeRestError(err) });
    }
  });
}

module.exports = { mountMemoryRoutes };
