#!/usr/bin/env node
'use strict';

// verify-screen-sensor.js — live verification harness for BUG-040.
//
// BUG-040: ambient screen awareness sensor (src/core/sensors/screen-sensor.js).
// Periodically screen_look's the desktop, hash-gates so unchanged screens
// skip the vision call entirely, and emits perception.screen with a
// one-sentence description.
//
// Unit-tested exhaustively in test/sensors-screen.test.js (11 cases).
// This script verifies the REAL boot path: pc-child's screen_look command
// + real vision brain provider + the hash-skip optimization in production.
//
// Requirements:
//   - Windows host (pc-child needs powershell.exe + the screen_look handler)
//   - At least one foreground app visible on screen
//   - A brain provider key configured for the vision lane (GROQ_API_KEY
//     or similar — the vision lane is documented in brain/lanes.default.js)
//
// Usage:
//   SCREEN_AWARENESS_ENABLED=true node scripts/verify-screen-sensor.js
//   SCREEN_AWARENESS_ENABLED=true SCREEN_AWARENESS_POLL_MS=10000 node scripts/verify-screen-sensor.js

const { log, bootMythos, killTree, captureEvents, DEFAULT_PORT } = require('./verify-lib');

async function main() {
  if (process.platform !== 'win32') {
    log('⚠️', 'screen-sensor requires Windows (pc-child screen_look). Skipping on ' + process.platform);
    process.exit(0);
  }
  if (process.env.SCREEN_AWARENESS_ENABLED !== 'true') {
    log('❌', 'SCREEN_AWARENESS_ENABLED must be set to "true" to run this verification');
    log('ℹ️', 'Usage: SCREEN_AWARENESS_ENABLED=true node scripts/verify-screen-sensor.js');
    process.exit(1);
  }

  const pollMs = Number(process.env.SCREEN_AWARENESS_POLL_MS) || 30000;
  log('🧪', `BUG-040 screen-sensor verification starting (pollMs=${pollMs})`);

  let boot;
  try {
    boot = await bootMythos({
      env: {
        SCREEN_AWARENESS_ENABLED: 'true',
        SCREEN_AWARENESS_POLL_MS: String(pollMs),
        // BROWSER_AUTOMATION stays on so pc-child spawns — screen-sensor needs it
      }
    });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let pass = true;
  try {
    // Wait long enough for TWO poll cycles — the second is the hash-skip test
    const waitMs = (pollMs * 2) + 5000;
    log('⏳', `capturing perception.screen events for ${Math.round(waitMs / 1000)}s (2 poll cycles)...`);
    const events = await captureEvents(DEFAULT_PORT, ['perception'], waitMs);

    const screenEvents = events.filter(e =>
      (e.payload && e.payload.kind === 'screen') ||
      (e.type === 'perception' && e.payload && e.payload.channel === 'ambient-screen')
    );

    if (screenEvents.length === 0) {
      log('❌', 'NO perception.screen events fired. Likely causes:');
      log('ℹ️', '  - pc-child screen_look failed (check boot logs for pc-child errors)');
      log('ℹ️', '  - vision brain provider offline (no GROQ_API_KEY or vision-lane provider)');
      log('ℹ️', '  - screen unchanged from the previous MYTHOS run (hash gate is sticky across boots — wait 60s and retry, or move a window before running)');
      pass = false;
    } else {
      log('✅', `${screenEvents.length} perception.screen event(s) fired`);
      const first = screenEvents[0];
      const summary = (first.payload && (first.payload.summary || first.payload.text)) || '(no summary)';
      log('ℹ️', `first description: ${String(summary).slice(0, 150)}`);

      // Hash-skip check: if screen was unchanged, we expect EXACTLY ONE event
      // (the first poll). A second event would mean the hash gate failed.
      if (screenEvents.length > 1) {
        log('⚠️', `multiple events fired (${screenEvents.length}) — either the screen changed mid-run (expected if you moved windows) OR the hash-skip gate is broken. If you did NOT touch the screen, this is a BUG-040 regression.`);
      } else {
        log('✅', 'hash-skip held on the unchanged screen (only 1 event over 2 cycles)');
      }
    }
  } finally {
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', 'BUG-040 screen-sensor: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-040 screen-sensor: FAIL (see above)');
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
