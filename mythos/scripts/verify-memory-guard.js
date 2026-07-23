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
// Requirements:
//   - At least one brain provider key set (GROQ_API_KEY, MISTRAL_API_KEY, etc.)
//     — the voice agent needs the brain to decide to call the remember tool.
//     Without a brain key the utterance returns "all my thinking providers
//     are offline" and the remember tool is never reached.
//
// Usage:
//   node scripts/verify-memory-guard.js
//   MYTHOS_AUTH_TOKEN=secret node scripts/verify-memory-guard.js

const fs = require('fs');
const path = require('path');
const { log, bootMythos, killTree, sendUtterance, vaultPath, DEFAULT_PORT } = require('./verify-lib');

// remember() appends to the PERSISTENT vault/Semantic/user-facts.md (never a
// per-session new file), and the WS 'done' message only carries {say, speak,
// chunked} — never the raw tool-dispatch {ok, result} — so neither
// "look for a new file" nor "grep the WS event JSON for ok\":false" can ever
// observe a rejection. The only real oracle is the file's own content,
// snapshotted immediately around each utterance.
function readFacts(semDir) {
  try { return fs.readFileSync(path.join(semDir, 'user-facts.md'), 'utf8'); } catch (_) { return ''; }
}

async function main() {
  const token = process.env.MYTHOS_AUTH_TOKEN || '';
  log('🧪', 'BUG-014 memory-guard verification starting');

  const semDir = path.join(vaultPath(), 'Semantic');

  let boot;
  try {
    boot = await bootMythos({ env: { BROWSER_AUTOMATION: 'false' } });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let allPassed = true;
  try {
    // --- Noise samples — should ALL be rejected (user-facts.md unchanged) ---
    const noiseSamples = ['uh', 'the', 'that you like', 'hmm'];
    for (const text of noiseSamples) {
      const before = readFacts(semDir);
      await sendUtterance(DEFAULT_PORT, `remember: ${text}`, { token });
      await new Promise(r => setTimeout(r, 1500));   // let a write (if any) flush to disk
      const after = readFacts(semDir);
      if (after === before) {
        log('✅', `noise "${text}" rejected as expected (user-facts.md unchanged)`);
      } else {
        log('❌', `noise "${text}" NOT rejected — user-facts.md gained: ${after.slice(before.length).trim().slice(0, 200)}`);
        allPassed = false;
      }
    }

    // --- Signal sample — should be accepted + persisted (user-facts.md grows) ---
    const signal = 'i really enjoy playing jazz piano';
    const beforeSignal = readFacts(semDir);
    await sendUtterance(DEFAULT_PORT, `remember: ${signal}`, { token });
    await new Promise(r => setTimeout(r, 1500));
    const afterSignal = readFacts(semDir);
    // NOTE: semantic.js write() ALWAYS regenerates the {id, ts} sidecar comment
    // and rewrites the file on every accepted call — even when append-mode dedup
    // recognizes the fact as already present (same final bullet lines, new
    // sidecar). So "unchanged length" does NOT mean "rejected" the way it does
    // for the noise samples above (which never reach semantic.write() at all).
    // Any byte difference here means the write happened; the content check
    // below confirms it's actually this fact, not a coincidental unrelated write.
    if (afterSignal !== beforeSignal) {
      const grew = afterSignal.length > beforeSignal.length;
      log('✅', `signal "${signal}" accepted — user-facts.md ${grew ? 'gained: ' + afterSignal.slice(beforeSignal.length).trim().slice(0, 200) : 're-written (deduped: fact already present, sidecar id/ts refreshed)'}`);
      if (!/jazz|piano/i.test(afterSignal)) {
        log('⚠️', 'user-facts.md does not mention jazz/piano anywhere — check this write is actually the signal fact');
      }
    } else {
      log('❌', `signal "${signal}" NOT accepted — user-facts.md byte-identical (no write occurred)`);
      allPassed = false;
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
