'use strict';

// server/routes/media.js — W9 god-file decomposition (Phase 2).
// Extracted from server/index.js per the §4.2 factory contract.
// Deps used: pcChild, leash, dispatchAction. The route-private art-cache state
// (lastArtPath/lastArtMime) is promoted INTO the factory per rule §4.2 #10 —
// it was a closure `let` in createServer, now it lives with the only routes
// that touch it.
//
// AD-1 (merged-order step 2): the raw-effectors.invoke fallback W10 left in
// place is gone — dispatchAction is always wired by the real server, so this
// route now has exactly one execution path, like every other dispatch surface.

const path = require('path');
const express = require('express');

function mountMediaRoutes(app, deps) {
  const { pcChild, leash, dispatchAction } = deps;

  // ---- /api/media — Windows SMTC now-playing (polls from media widget) ----
  // BUG-004/BUG-038: album art travels as a temp FILE written by the PS child
  // (never as base64 inside the JSON pipe). This route remembers the server-side
  // artPath from the child's own response; /api/media/art below streams it. The
  // client only ever sees a boolean + mime — no client-supplied paths are read.
  let lastArtPath = null;
  let lastArtMime = 'image/png';
  app.get('/api/media', async (req, res) => {
    try {
      if (!pcChild) return res.json({ ok: false, error: 'pc-child offline' });
      const result = await pcChild.sendCommand({ cmd: 'media_status' });
      if (result.ok) {
        const media = { ...result.result };
        if (media.artPath && path.basename(media.artPath) === 'mythos-media-art.bin') {
          lastArtPath = media.artPath;
          lastArtMime = media.artMime || 'image/png';
          media.art = true;
        } else {
          lastArtPath = null;
          media.art = false;
        }
        delete media.artPath;
        res.json({ ok: true, media });
      } else {
        res.json({ ok: false, error: result.error });
      }
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.get('/api/media/art', (req, res) => {
    if (!lastArtPath) return res.status(404).end();
    require('fs').readFile(lastArtPath, (err, buf) => {
      if (err) return res.status(404).end();
      res.set('Content-Type', lastArtMime);
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    });
  });

  // Media transport — buttons on the media widget. media_key is Tier 2
  // (auto-allowed by leash.check below).
  // REMEDIATION P2-12: dispatches through the shared dispatchAction (audit +
  // episodic + breaker + action.completed) instead of a raw effectors.invoke
  // — previously this route's calls left NO audit/episodic trace at all (the
  // 2026-07-29 audit found 42 of 43 media_key records with no outcome
  // recorded; this was the source). channel:'dashboard-media-widget'
  // distinguishes these from voice- or cortex-originated media_key calls.
  const MEDIA_KEYS = ['play_pause', 'next_track', 'prev_track', 'volume_up', 'volume_down', 'volume_mute'];
  app.post('/api/media/control', express.json(), async (req, res) => {
    try {
      const key = req.body && req.body.key;
      if (!MEDIA_KEYS.includes(key)) return res.status(400).json({ ok: false, error: 'invalid media key' });
      // A click on the dashboard transport IS a present operator — the same
      // standing as a voice turn. Without a connectionId the leash cannot
      // apply operator-present trust and every button 403s in silence.
      const decision = leash.check(
        { tool: 'media_key', args: { key } },
        { goalId: null, connectionId: 'dashboard-media-widget' },
      );
      if (!decision.allow) {
        return res.status(403).json({
          ok: false,
          error: decision.reason,
          reason: decision.reason,
          requireConfirm: Boolean(decision.requireConfirm),
        });
      }
      // AD-1: dispatchAction is always wired by the real server (server/index.js
      // passes it into mountMediaRoutes' deps) — the raw effectors.invoke
      // fallback this used to have was dead in production and bypassed the
      // single execution surface (anti-drift-single-dispatch.test.js).
      const result = await dispatchAction({ tool: 'media_key', args: { key } }, { tier: decision.tier, channel: 'dashboard-media-widget' });
      res.json({ ok: !!result.ok });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { mountMediaRoutes };
