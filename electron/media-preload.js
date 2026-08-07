'use strict';

// electron/media-preload.js — the media window's OWN preload (B2/H6 fix,
// 2026-08-08).
//
// electron/media-window.js loadURL()s a caller-supplied URL (the open_web
// tool payload — see mythos/src/core/effectors/from-dashboard.js — which is
// Tier 0 auto-allowed per mythos/src/core/leash/tiers.js). Arbitrary
// third-party JS can therefore run in that window: an operator typo, a
// prompt-injected tool call, or a poisoned search result. It used to share
// electron/preload.js with the trusted HUD window, which meant that
// third-party JS could call window.mythos.setKey('GEMINI_API_KEY',
// attacker_key) and reroute all model traffic, or setKey('NODE_OPTIONS', ...)
// toward RCE in the forked server child.
//
// The media window only plays/renders content (YouTube embeds, arbitrary
// `web` pages) — it never needs anything from the main process. So this
// preload intentionally exposes NO contextBridge surface at all. contextIsolation
// + sandbox (set in media-window.js's webPreferences) are enough on their own;
// an empty preload is simply the file Electron loads for this window instead
// of the HUD's.
