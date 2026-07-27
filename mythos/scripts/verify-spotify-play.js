#!/usr/bin/env node
'use strict';

// verify-spotify-play.js — live verification harness for BUG-026.
//
// BUG-026: "Spotify play still doesn't start playback after the focus fix."
// The 5th-attempt fix (commit 756966e) added a cua-driver (Rust UIA
// hit-tester) click path in src/core/effectors/from-spotify.js's
// spotify_play()/cuaPlayViaDriver(): walk Spotify's real Chromium
// accessibility tree for a "Play <track>" button, click it by element_index
// (background->foreground escalation), then verify via the window-title
// oracle ("Artist - Track" while playing).
//
// This script deliberately does NOT use the full server boot + WS utterance
// pattern (verify-planner.js / verify-memory-guard.js's template) because
// that route forces the request through the voice agent's NLU tool-selection
// (an LLM call) before it ever reaches spotify_play() — an extra, unrelated
// source of nondeterminism/cost for a bug that is specifically about the
// CLICK mechanism, not tool selection. Instead it wires the exact same
// production pieces src/main.js uses to register/start this effector
// (main.js:300-301 registerFromPc/registerFromSpotify, main.js:571,578
// pcChild.startPcChild()/cuaDriver.startCuaDriver()) directly in-process,
// then calls hub.invoke('spotify_play', {query}) exactly as the voice agent
// would — and independently re-checks the window-title oracle itself
// (a second, separate cua-driver list_windows call + its own term-match
// logic) rather than only trusting spotify_play's self-reported `verified`
// flag, since that flag comes from the exact code path under test.
//
// Requirements:
//   - Windows host with a real Spotify desktop install, already running
//     (adapters/pc-child's list_windows must find a "spotify" process) —
//     this is BUG-026's documented hard precondition; SKIP if absent.
//   - cua-driver binary installed (adapters/cua-driver resolveBinary()) —
//     without it spotify_play() silently falls back to the click_at/keystroke
//     paths BUGS.md already shows are unreliable, so this script requires
//     cua-driver ONLINE and reports SKIP otherwise (never treats the
//     fallback path succeeding as proof of the cua-driver fix).
//
// Usage:
//   node scripts/verify-spotify-play.js
//   node scripts/verify-spotify-play.js "Bohemian Rhapsody Queen"

const { log } = require('./verify-lib');
const { createBus } = require('../src/core/bus');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
const pcChild = require('../adapters/pc-child');
const cuaDriver = require('../adapters/cua-driver');

const QUERY = process.argv[2] || 'Bohemian Rhapsody Queen';

function queryTerms(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
}

// Independent re-implementation of from-spotify.js's strict-majority term
// match against the window-title oracle — this is this script's OWN check,
// not a call into the module under test.
function titleMatchesQuery(title, query) {
  const terms = queryTerms(query);
  if (!terms.length || !title) return false;
  const t = String(title).toLowerCase();
  const matched = terms.filter(term => t.includes(term)).length;
  const required = Math.max(1, Math.ceil(terms.length * 0.6));
  return matched >= required;
}

async function waitForOnline(getStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getStatus();
    if (s.state === 'ONLINE') return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  return getStatus();
}

async function main() {
  if (process.platform !== 'win32') {
    log('⚠️', `BUG-026 spotify-play requires Windows (pc-child/cua-driver). Skipping on ${process.platform}`);
    process.exit(3);
  }

  log('🧪', `BUG-026 spotify-play verification starting (query="${QUERY}")`);

  const bus = createBus();
  const hub = createEffectorHub({ bus, config: {} });
  registerFromPc(hub, {});
  registerFromSpotify(hub, { effectors: hub, bus: null, memory: null, goals: null, config: null });

  pcChild.startPcChild();
  cuaDriver.startCuaDriver();

  let exitCode = 3; // default: SKIP unless a definitive PASS/FAIL is reached below
  try {
    log('⏳', 'waiting for pc-child ONLINE...');
    const pcStatus = await waitForOnline(pcChild.getStatus, 20000);
    if (pcStatus.state !== 'ONLINE') {
      log('⏭️', `SKIP: pc-child adapter never reached ONLINE (state=${pcStatus.state}, hint=${pcStatus.hint || 'none'})`);
      return;
    }
    log('✅', 'pc-child ONLINE');

    log('⏳', 'waiting for cua-driver ONLINE...');
    const cuaStatus = await waitForOnline(cuaDriver.getStatus, 15000);
    if (cuaStatus.state !== 'ONLINE') {
      log('⏭️', `SKIP: cua-driver never reached ONLINE (state=${cuaStatus.state}, hint=${cuaStatus.hint || 'none'}) — cua-driver-rs binary missing/not on PATH`);
      return;
    }
    log('✅', 'cua-driver ONLINE');

    // Hard precondition per BUGS.md: a real Spotify desktop install must
    // actually be running. Confirm via the real list_windows tool (not a
    // process-list guess) before attempting anything.
    const listBefore = await hub.invoke('list_windows', {}, {});
    const winsBefore = (listBefore.ok && listBefore.result && listBefore.result.windows) || [];
    const spotifyBefore = winsBefore.find((w) => w.processName && w.processName.toLowerCase().includes('spotify'));
    if (!spotifyBefore) {
      log('⏭️', 'SKIP: no Spotify window/process found — a real Spotify desktop install is a hard precondition for BUG-026');
      return;
    }
    const baselineTitle = spotifyBefore.title || '';
    log('ℹ️', `Spotify found running (pid=${spotifyBefore.pid}), baseline title="${baselineTitle}"`);

    log('▶️', `invoking spotify_play({query:"${QUERY}"}) — real cua-driver click path...`);
    const playResult = await hub.invoke('spotify_play', { query: QUERY }, {});
    log('ℹ️', `spotify_play returned: ${JSON.stringify(playResult).slice(0, 500)}`);

    if (!playResult.ok) {
      log('❌', `spotify_play failed outright: ${JSON.stringify(playResult.result).slice(0, 300)}`);
      exitCode = 1;
      return;
    }

    const method = playResult.result && playResult.result.method;
    log('ℹ️', `play method used: ${method}`);

    // Independent oracle re-check: wait a beat, then re-query the window
    // title ourselves via a FRESH cua-driver list_windows call, computed with
    // this script's own titleMatchesQuery() — not spotify_play()'s own
    // self-reported .verified flag.
    await new Promise((r) => setTimeout(r, 2500));
    let finalTitle = null;
    const lw2 = await cuaDriver.invoke('list_windows', {});
    if (lw2.ok) {
      const wins2 = (lw2.result && lw2.result.structuredContent && lw2.result.structuredContent.windows) || [];
      const w2 = wins2.find((x) => (x.app_name || '').toLowerCase().includes('spotify'));
      finalTitle = w2 ? w2.title : null;
    }
    if (finalTitle === null) {
      // Fall back to pc-child's own list_windows (same oracle, different transport)
      const lwPc = await hub.invoke('list_windows', {}, {});
      const winsPc = (lwPc.ok && lwPc.result && lwPc.result.windows) || [];
      const wPc = winsPc.find((w) => w.processName && w.processName.toLowerCase().includes('spotify'));
      finalTitle = wPc ? wPc.title : null;
    }

    log('ℹ️', `final Spotify window title (independent re-check): "${finalTitle}"`);
    const matches = titleMatchesQuery(finalTitle, QUERY);

    if (matches) {
      log('🎉', `BUG-026 spotify-play: PASS — window title "${finalTitle}" matches query "${QUERY}" (method=${method})`);
      exitCode = 0;
    } else {
      log('💀', `BUG-026 spotify-play: FAIL — final title "${finalTitle}" does not match query "${QUERY}" (baseline="${baselineTitle}", method=${method}, self-reported verified=${playResult.result && playResult.result.verified})`);
      exitCode = 1;
    }
  } finally {
    cuaDriver.shutdownCuaDriver();
    pcChild.shutdownPcChild();
    // give the taskkill spawns a moment to land before the process exits
    await new Promise((r) => setTimeout(r, 800));
  }

  process.exit(exitCode);
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
