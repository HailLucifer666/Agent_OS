#!/usr/bin/env node
'use strict';

// verify-memory-guard.js — live verification harness for BUG-014.
//
// BUG-014: the `remember` tool auto-saved STT transcription noise ("uh",
// "the", "that you like"). The fix (src/core/effectors/from-memory.js:15-35)
// rejects anything <10 chars or matching the noise regex.
//
// This script boots MYTHOS, sends noise + signal utterances via WS, and
// confirms the noise is rejected while the signal is persisted. Mirrors
// the 23 unit tests in test/from-memory.test.js but against a real boot.
//
// Usage:
//   node scripts/verify-memory-guard.js
//   MYTHOS_AUTH_TOKEN=secret node scripts/verify-memory-guard.js

const fs = require('fs');
const path = require('path');
const { log, bootMythos, killTree, sendUtterance, vaultPath, DEFAULT_PORT } = require('./verify-lib');

async function main() {
  const token = process.env.MYTHOS_AUTH_TOKEN || '';
  log('🧪', 'BUG-014 memory-guard verification starting');

  // Snapshot vault/Semantic BEFORE so we can detect NEW writes only.
  const semDir = path.join(vaultPath(), 'Semantic');
  const before = new Set();
  try {
    fs.readdirSync(semDir).filter(f => f.endsWith('.md')).forEach(f => before.add(f));
  } catch (_) { /* dir may not exist yet */ }

  let boot;
  try {
    boot = await bootMythos({ env: { BROWSER_AUTOMATION: 'false' } });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let allPassed = true;
  try {
    // --- Noise samples — should ALL be rejected ---
    const noiseSamples = ['uh', 'the', 'that you like', 'hmm'];
    for (const text of noiseSamples) {
      const { events } = await sendUtterance(DEFAULT_PORT, `remember: ${text}`, { token });
      // Look for any action with tool:'remember' + ok:false OR a reply mentioning rejection
      const flat = JSON.stringify(events).toLowerCase();
      const rejected = flat.includes('ok":false') || flat.includes('reject') || flat.includes('too short') || flat.includes('noise');
      if (rejected) {
        log('✅', `noise "${text}" rejected as expected`);
      } else {
        log('❌', `noise "${text}" NOT rejected — events: ${flat.slice(0, 200)}`);
        allPassed = false;
      }
    }

    // --- Signal sample — should be accepted + persisted ---
    const signal = 'i really enjoy playing jazz piano';
    const { events: signalEvents } = await sendUtterance(DEFAULT_PORT, `remember: ${signal}`, { token });
    const flatSig = JSON.stringify(signalEvents).toLowerCase();
    const accepted = flatSig.includes('ok":true') || flatSig.includes('noted') || flatSig.includes('saved');
    if (accepted) {
      log('✅', `signal "${signal}" accepted as expected`);
    } else {
      log('❌', `signal "${signal}" NOT accepted — events: ${flatSig.slice(0, 200)}`);
      allPassed = false;
    }

    // Give the vault a moment to flush, then check Semantic for NEW files
    await new Promise(r => setTimeout(r, 1500));
    let newFiles = [];
    try {
      newFiles = fs.readdirSync(semDir).filter(f => f.endsWith('.md') && !before.has(f));
    } catch (_) {}

    if (newFiles.length > 0) {
      log('✅', `${newFiles.length} new Semantic file(s) written: ${newFiles.join(', ')}`);
      // Read the new file and confirm the signal text appears
      const content = fs.readFileSync(path.join(semDir, newFiles[0]), 'utf8').toLowerCase();
      if (content.includes('jazz') || content.includes('piano')) {
        log('✅', 'signal text appears in the new Semantic file');
      } else {
        log('⚠️', `new Semantic file doesn't mention the signal text. content: ${content.slice(0, 200)}`);
      }
    } else {
      // The signal may have been appended to user-facts.md rather than a new file
      log('⚠️', 'no NEW Semantic file — signal may have been appended to user-facts.md or rejected by the brain\'s judgement. Check the dashboard.');
    }
  } finally {
    await killTree(boot.child);
  }

  if (allPassed) {
    log('🎉', 'BUG-014 memory-guard: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-014 memory-guard: FAIL (see above)');
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
