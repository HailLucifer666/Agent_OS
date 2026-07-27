#!/usr/bin/env node
'use strict';

// verify-bug-001-spotify-play.js — live verification harness for BUG-001
// ("Spotify play doesn't play the song") / BUG-026 (the follow-on that
// actually fixed it, 5th attempt, commit 756966e).
//
// BUG-001's group is classified "blocked" (needs a real, licensed Spotify
// desktop install) — this script first checks that precondition live via
// pc-child (list_windows) rather than assuming it. If Spotify isn't running,
// it reports SKIP with that exact missing precondition. It never fabricates
// a PASS.
//
// Design note — this deliberately does NOT boot the full MYTHOS server
// (src/main.js). BUG-001/BUG-026 are about the MECHANISM: does calling
// spotify_play() actually cause the real desktop Spotify app to play audio?
// That mechanism lives entirely in src/core/effectors/from-spotify.js +
// from-pc.js, driven by the real adapters/pc-child (PowerShell UIA
// automation) and adapters/cua-driver (element-addressed clicking). None of
// that requires the brain/voice-agent/WS layer, so this script wires just
// those effectors onto a minimal hub — the exact same production code path
// main.js wires, minus the parts (brain, memory, goals) those tools don't
// use. This also avoids booting a second MYTHOS instance while other agents
// may be doing concurrent live verification against the same machine.
//
// What it checks (in order, aborting to SKIP/FAIL as soon as a check fails):
//   1. PRECONDITION: pc-child comes ONLINE and list_windows finds a real
//      Spotify process. If not found -> SKIP (missing precondition: no
//      licensed Spotify desktop install/process on this machine).
//   2. Calls the real spotify_play({query}) effector (same code path the
//      brain would call) and captures its result (method used: cua-driver /
//      click_at / keystroke_fallback, and any warnings).
//   3. Independently verifies actual playback via TWO separate oracles that
//      do not share code with each other or with spotify_play() beyond the
//      pc-child transport:
//        a. spotify_status() — from-spotify.js's own window-title heuristic
//           (looksLikePlayingTitle).
//        b. media_status() — Windows SMTC (System Media Transport Controls),
//           a completely OS-level, independent source of truth. The decisive
//           check: positionSec must ADVANCE between two reads several
//           seconds apart while playing:true. A static/absent position
//           cannot be faked by a UI element merely rendering a "now playing"
//           label — only a real, running audio transport advances it. This
//           is the strongest evidence available in this environment (no
//           system-audio-capture tooling exists in this repo).
//   4. Cleans up by pausing playback (media_key play_pause) and shutting
//      down the pc-child/cua-driver child processes THIS script spawned.
//
// Usage:
//   node scripts/verify-bug-001-spotify-play.js
//   node scripts/verify-bug-001-spotify-play.js "Yesterday The Beatles"   # custom query

const path = require('path');
const { log } = require('./verify-lib');

const MYTHOS_DIR = path.join(__dirname, '..');

const { createEffectorHub } = require(path.join(MYTHOS_DIR, 'src/core/effectors/hub'));
const { registerFromPc, media_status } = require(path.join(MYTHOS_DIR, 'src/core/effectors/from-pc'));
const {
  registerFromSpotify,
  spotify_status,
  spotify_play,
  spotify_play_pause,
} = require(path.join(MYTHOS_DIR, 'src/core/effectors/from-spotify'));
const pcChild = require(path.join(MYTHOS_DIR, 'adapters/pc-child'));
const cuaDriver = require(path.join(MYTHOS_DIR, 'adapters/cua-driver'));

const PC_ONLINE_TIMEOUT_MS = 10000;
const QUERY = process.argv[2] || 'Bohemian Rhapsody Queen';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForPcOnline() {
  const deadline = Date.now() + PC_ONLINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (pcChild.getStatus().state === 'ONLINE') return true;
    await sleep(300);
  }
  return false;
}

async function shutdown() {
  try { pcChild.shutdownPcChild(); } catch (_) {}
  try { cuaDriver.shutdownCuaDriver(); } catch (_) {}
}

async function main() {
  log('🧪', `BUG-001 / BUG-026 Spotify playback verification starting (query: "${QUERY}")`);

  const bus = { emit: () => {} };
  const hub = createEffectorHub({ bus, config: {} });
  registerFromPc(hub, {});
  registerFromSpotify(hub, { effectors: hub });

  pcChild.startPcChild();
  cuaDriver.startCuaDriver();

  const online = await waitForPcOnline();
  if (!online) {
    log('⏭️', 'SKIP: pc-child (PowerShell UIA automation) never came ONLINE');
    await shutdown();
    process.exit(3);
  }
  await sleep(1500); // let cua-driver settle (it starts async alongside pc-child)

  // ---- Precondition: a real Spotify desktop process must actually be running ----
  const baseline = await spotify_status();
  if (!baseline.ok || !baseline.result.running) {
    log('⏭️', `SKIP: missing precondition — no running Spotify desktop process found on this machine (${JSON.stringify(baseline)})`);
    await shutdown();
    process.exit(3);
  }
  log('ℹ️', `precondition OK: Spotify running (pid ${baseline.result.pid}), baseline title "${baseline.result.title}"`);
  log('ℹ️', `cua-driver adapter state: ${cuaDriver.getStatus().state}`);

  let pass = true;
  const evidence = [];

  try {
    // ---- Action: call the real spotify_play() effector ----
    log('▶️', `calling spotify_play({query: "${QUERY}"})`);
    const playResult = await spotify_play({ query: QUERY });
    log('ℹ️', `spotify_play result: ${JSON.stringify(playResult)}`);
    evidence.push({ step: 'spotify_play', result: playResult });

    if (!playResult.ok) {
      log('❌', 'spotify_play returned ok:false — playback was not even attempted successfully');
      pass = false;
    } else {
      // ---- Oracle A: from-spotify.js's own window-title heuristic ----
      await sleep(2000);
      const statusAfter = await spotify_status();
      log('ℹ️', `spotify_status (oracle A): ${JSON.stringify(statusAfter)}`);
      evidence.push({ step: 'spotify_status', result: statusAfter });

      // ---- Oracle B: Windows SMTC — the decisive, OS-level, code-independent check ----
      const m1 = await media_status();
      log('ℹ️', `media_status #1 (oracle B, SMTC): ${JSON.stringify(m1)}`);
      evidence.push({ step: 'media_status_1', result: m1 });

      await sleep(6000);
      const m2 = await media_status();
      log('ℹ️', `media_status #2 (oracle B, 6s later): ${JSON.stringify(m2)}`);
      evidence.push({ step: 'media_status_2', result: m2 });

      if (!m1.ok || !m2.ok || !m1.result.available || !m2.result.available) {
        log('❌', 'SMTC media_status unavailable — cannot independently confirm real playback (oracle B failed)');
        pass = false;
      } else {
        const delta = m2.result.positionSec - m1.result.positionSec;
        log('ℹ️', `SMTC positionSec delta over ~6s: ${delta} (playing1=${m1.result.playing}, playing2=${m2.result.playing})`);
        if (m2.result.playing && delta > 0) {
          log('✅', `real audio transport confirmed advancing (+${delta}s of real elapsed time) — playback is genuinely active, not just a UI label`);
        } else {
          log('❌', `SMTC does not show advancing playback (playing=${m2.result.playing}, delta=${delta}s) — cannot confirm real audio is playing`);
          pass = false;
        }
      }
    }

    // ---- Cleanup: pause so this check doesn't leave music running unattended ----
    log('🧹', 'pausing playback (cleanup)');
    const pauseResult = await spotify_play_pause();
    log('ℹ️', `pause result: ${JSON.stringify(pauseResult)}`);
  } finally {
    await shutdown();
  }

  if (pass) {
    log('🎉', 'BUG-001 / BUG-026 Spotify playback: PASS — real playback live-verified via an independent OS-level oracle (SMTC position advancing)');
    process.exit(0);
  } else {
    log('💀', 'BUG-001 / BUG-026 Spotify playback: FAIL — see evidence above');
    console.log(JSON.stringify(evidence, null, 2));
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  shutdown().finally(() => process.exit(2));
});
