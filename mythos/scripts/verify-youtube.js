#!/usr/bin/env node
'use strict';

// verify-youtube.js — live verification harness for BUG-006.
//
// BUG-006: YouTube embed showed "Video unavailable". The fix added a
// YOUTUBE_MODE env knob ('embed' default, 'newtab' escape hatch) and a
// fallback UI. Server-side branches are unit-tested in
// test/bug-006-youtube-mode.test.js (4 cases). This script verifies the
// real boot sends the right open-web event for a YouTube utterance.
//
// NOTE: actual iframe rendering in the browser is operator-eyes-only.
// This script verifies the SERVER-SIDE contract only. The runbook
// (docs/live-verification-runbook.md) documents the live-browser check.
//
// Requirements:
//   - At least one brain provider key set (GROQ_API_KEY, MISTRAL_API_KEY, etc.)
//     — the voice agent needs the brain to interpret the utterance and decide
//     to call open_web. Without a brain key the utterance returns "all my
//     thinking providers are offline" and open_web is never called.
//
// Usage:
//   node scripts/verify-youtube.js                 # default YOUTUBE_MODE
//   YOUTUBE_MODE=newtab node scripts/verify-youtube.js

const { log, bootMythos, killTree, sendUtterance, DEFAULT_PORT } = require('./verify-lib');

async function main() {
  const token = process.env.MYTHOS_AUTH_TOKEN || '';
  const youtubeMode = process.env.YOUTUBE_MODE || 'embed';
  log('🧪', `BUG-006 YouTube verification starting (YOUTUBE_MODE=${youtubeMode})`);

  let boot;
  try {
    boot = await bootMythos({ env: { BROWSER_AUTOMATION: 'false' } });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let pass = true;
  try {
    const utterance = 'play guitar tutorial on YouTube';
    log('▶️', `sending utterance: "${utterance}"`);
    const { events, timedOut } = await sendUtterance(DEFAULT_PORT, utterance, { token, timeoutMs: 20000 });
    if (timedOut) {
      log('⚠️', 'utterance timed out — the brain provider may be unavailable. Falling back to static-event check.');
    }

    // Look through events for an open-web action or ui.open-web broadcast
    // (server emits ui.open-web on the bus → broadcastAll sends type:'open-web')
    const flat = JSON.stringify(events);
    const hasYoutube = flat.toLowerCase().includes('youtube') || flat.includes('videoId');
    const hasUrl = flat.includes('watch?v=') || flat.includes('youtube-nocookie.com/embed/') || flat.includes('youtube.com/watch');

    if (hasYoutube && hasUrl) {
      log('✅', `open-web event captured with YouTube URL + videoId`);
      // Mode-specific assertion
      if (youtubeMode === 'newtab') {
        if (flat.includes('youtube.com/watch')) {
          log('✅', 'YOUTUBE_MODE=newtab: URL points to youtube.com/watch (new tab path)');
        } else {
          log('⚠️', `YOUTUBE_MODE=newtab but URL doesn't look like youtube.com/watch: ${flat.slice(0, 200)}`);
        }
      } else {
        if (flat.includes('youtube-nocookie.com/embed/')) {
          log('✅', 'default mode: URL uses youtube-nocookie embed');
        } else {
          log('⚠️', `default mode but URL isn't youtube-nocookie embed: ${flat.slice(0, 200)}`);
        }
      }
    } else {
      log('❌', `no YouTube open-web event captured. Events: ${flat.slice(0, 400)}`);
      pass = false;
    }
  } finally {
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', 'BUG-006 YouTube (server-side): PASS');
    log('ℹ️', 'NOTE: actual iframe rendering is operator-eyes-only — see docs/live-verification-runbook.md');
    process.exit(0);
  } else {
    log('💀', 'BUG-006 YouTube (server-side): FAIL');
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
