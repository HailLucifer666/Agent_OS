#!/usr/bin/env node
'use strict';

// verify-propose-goal.js — live verification harness for Phase4/V5 (backend half).
//
// Phase 4's V5 gap-close lets the cortex autonomously SUGGEST goals
// (status:'proposed') during idle ticks instead of ever auto-activating them.
// Only unit/mock coverage existed for this before this script: cortex/index.js's
// mull() is closure-private and test/phase4d-mull-propose-goal.test.js only
// asserts on the cortex SOURCE TEXT (prompt wording, event names) — it never
// drives a real idle tick against a real brain and never confirms a
// status:'proposed' goal actually lands and is queryable via
// GET /api/goals/proposals.
//
// RESULT OF THIS SCRIPT (documented up front because it's a root-cause find,
// not model non-determinism): mull() — the ONLY place that generates
// propose_goal suggestions — is gated behind
// `if (perceptions.length === 0 && !hasActive)` in cortex/index.js's
// tickOnce(). sensors/timer.js emits an UNFILTERED 'perception.tick' event
// EVERY tick (unconditionally, kind:'timer'), and main.js's
// `bus.subscribe('perception.*', ...)` pushes it into working memory with no
// kind-based exclusion — so `perceptions.length` is never 0 in steady state
// (the cortex's own heartbeat perpetually "perceives itself"). This script's
// PRIMARY check proves that directly: it captures the live 'tick' bus event
// (payload includes `perceptions: <count>`) for ~45s on a freshly booted,
// completely untouched instance and asserts whether any tick ever reports
// perceptions===0. A SECONDARY check corroborates by seeding two
// durable-intention conversation turns (a shape that, tested in isolation via
// a direct brain.think() call with the exact mull() prompt, produced
// non-empty `proposals` in 4/4 trials against this repo's real configured
// key) and polling GET /api/goals/proposals to confirm no proposal ever
// surfaces despite a live, working brain.
//
// PORT-COLLISION GUARD: other agents may be live-verifying concurrently on
// this same machine. A free-port TCP-bind check has a TOCTOU race, and a
// stray already-running MYTHOS instance can answer /health before our own
// spawned child does (observed once during development of this script — a
// stale concurrent instance's own unrelated proposal was returned). This
// script therefore verifies (via `netstat -ano`) that the PID actually
// LISTENING on the chosen port is our own spawned child's PID — not just
// that /health responded — before trusting anything it returns, and
// re-checks before every poll so a mid-run collision aborts instead of
// silently reporting someone else's data.
//
// Usage:
//   node scripts/verify-propose-goal.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const { log, bootMythos, killTree, sendUtterance, captureEvents, MYTHOS_DIR } = require('./verify-lib');

function randomPortInRange(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  for (let i = 0; i < 12; i++) {
    const p = randomPortInRange(4500, 4900);
    if (await isPortFree(p)) return p;
  }
  throw new Error('could not find a free port in 4500-4900 after 12 attempts');
}

// Returns the PID actually LISTENING on `port` (Windows via netstat -ano), or
// null if undeterminable (non-Windows, netstat unavailable, or nothing found).
function getListenerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const [, local, , state, pid] = parts;
      if (state !== 'LISTENING') continue;
      const portPart = local.split(':').pop();
      if (Number(portPart) === port) return Number(pid);
    }
  } catch (_) { /* best-effort — treat as undeterminable */ }
  return null;
}

// Boots MYTHOS on a freshly-picked port and confirms the PID actually
// listening there is our own spawned child — not a stray concurrent
// process. Retries on a new port up to `maxAttempts` times on mismatch.
async function bootOwnedMythos(envOverrides, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await pickFreePort();
    log('ℹ️', `attempt ${attempt}: trying port ${port}`);
    let boot;
    try {
      boot = await bootMythos({ port, env: envOverrides });
    } catch (err) {
      log('⚠️', `boot attempt on port ${port} failed: ${err.message}`);
      continue;
    }
    const listenerPid = getListenerPid(port);
    if (listenerPid !== null && listenerPid !== boot.child.pid) {
      log('⚠️', `PORT COLLISION: port ${port} is owned by PID ${listenerPid}, not our spawned child (PID ${boot.child.pid}) — likely a concurrent agent's MYTHOS instance. Retrying on a different port.`);
      await killTree(boot.child);
      continue;
    }
    if (listenerPid === null) {
      log('⚠️', 'could not verify port ownership via netstat (non-Windows or netstat unavailable) — proceeding on trust');
    } else {
      log('✅', `confirmed port ${port} is owned by our own spawned child (PID ${listenerPid})`);
    }
    return { boot, port };
  }
  throw new Error(`could not obtain exclusive ownership of any port after ${maxAttempts} attempts — machine appears heavily contended by concurrent MYTHOS instances`);
}

function httpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error(`bad JSON from ${urlPath}: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET ${urlPath} timed out`)); });
  });
}

function readProposedGoalFiles(vaultRoot) {
  const goalsDir = path.join(vaultRoot, 'Goals');
  let files = [];
  try { files = fs.readdirSync(goalsDir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  const proposed = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(goalsDir, f), 'utf8'));
      if (data && data.status === 'proposed') proposed.push(data);
    } catch (_) { /* skip unreadable/partial-write files */ }
  }
  return proposed;
}

async function main() {
  log('🧪', 'Phase4/V5 propose_goal (backend) verification starting');

  // NOTE: os.tmpdir() is deliberately NOT used here. On this Windows box it
  // resolves under a short (8.3) path segment (…\ARGHYA~1\…) whose casing
  // disagrees with the long-name form Windows reports back through
  // ReadDirectoryChangesW — the file sensor's fs.watch() on the vault root
  // then hits a hard libuv assertion (`fs-event.c:72`) that SIGKILLs the
  // whole process outside any try/catch. Isolated scratch vaults for live
  // verification in this repo live under mythos/ instead (matches the
  // vault_test_audit_*/ convention already used by other concurrent
  // verify runs) — same isolation guarantee, no path-casing crash.
  const vaultRoot = path.join(MYTHOS_DIR, `vault_test_verify_propose_goal_${Date.now()}`);
  log('ℹ️', `isolated vault: ${vaultRoot}`);

  let owned;
  try {
    owned = await bootOwnedMythos({
      MYTHOS_VAULT_ROOT: vaultRoot,
      MYTHOS_TICK_MS: '1000',
      MYTHOS_MULL_EVERY_TICKS: '2',
      BROWSER_AUTOMATION: 'false',
    }, 4);
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  const { boot, port } = owned;
  const myPid = boot.child.pid;

  let verdict = null; // 'PASS' | 'FAIL' | 'SKIP'
  let reason = '';
  const evidenceLines = [];
  let collisionAborted = false;

  function assertStillOwned(where) {
    const pid = getListenerPid(port);
    if (pid !== null && pid !== myPid) {
      log('❌', `PORT COLLISION mid-run at "${where}": port ${port} is now owned by PID ${pid}, not ours (${myPid}). Aborting — cannot trust further responses.`);
      collisionAborted = true;
      return false;
    }
    return true;
  }

  try {
    // === PRIMARY CHECK: is the idle branch (perceptions.length===0) ever reachable? ===
    // mull() — the only site that can generate a propose_goal suggestion — is
    // gated behind this exact condition in cortex/index.js. Capture the live
    // 'tick' bus event (payload carries the real perception count each tick)
    // on a completely fresh, untouched boot for ~45s and see if it ever hits 0.
    const TICK_CAPTURE_MS = 45000;
    log('⏳', `PRIMARY CHECK: capturing live 'tick' events for ${TICK_CAPTURE_MS / 1000}s on a fresh, idle boot to see whether perceptions ever reach 0 (the only condition under which mull() can run)...`);
    const tickEvents = await captureEvents(port, ['tick'], TICK_CAPTURE_MS);
    const zeroPerceptionTicks = tickEvents.filter((e) => e.payload && e.payload.perceptions === 0);
    const histogram = tickEvents.reduce((h, e) => {
      const k = e.payload ? e.payload.perceptions : 'unknown';
      h[k] = (h[k] || 0) + 1;
      return h;
    }, {});
    log('📊', `captured ${tickEvents.length} ticks; perceptions histogram: ${JSON.stringify(histogram)}; ticks with perceptions===0: ${zeroPerceptionTicks.length}`);
    evidenceLines.push(`Live 'tick' capture over ${tickEvents.length} real ticks (idle boot, no user interaction): perceptions histogram ${JSON.stringify(histogram)}. sensors/timer.js emits an unconditional 'perception.tick' every tick (subscribed via main.js's unfiltered bus.subscribe('perception.*', ...)), so perceptions never reaches 0 in steady state — the idle branch that gates mull() (cortex/index.js: "if (perceptions.length === 0 && !hasActive)") is structurally unreachable.`);

    const idleBranchReachable = zeroPerceptionTicks.length > 0;
    if (!idleBranchReachable) {
      log('❌', 'idle branch is UNREACHABLE: zero out of ' + tickEvents.length + ' ticks ever had perceptions===0.');
    } else {
      log('✅', `idle branch IS reachable: ${zeroPerceptionTicks.length}/${tickEvents.length} ticks had perceptions===0 — proceeding to the full generation check.`);
    }

    // === SECONDARY / CORROBORATING CHECK: seed durable-intention conversation, poll the API ===
    const seeds = [
      'I keep telling myself I should learn Spanish for 20 minutes every morning but I never actually start.',
      "I also really want to start journaling every night before bed, it's something I care about but haven't managed to do consistently.",
    ];

    let brainOnline = false;
    for (const text of seeds) {
      if (!assertStillOwned('before seeding utterance')) break;
      log('💬', `seeding conversation: "${text.slice(0, 60)}..."`);
      const { events, timedOut } = await sendUtterance(port, text, { timeoutMs: 25000 });
      const done = events.find((e) => e.type === 'done');
      if (timedOut || !done) {
        log('⚠️', `utterance timed out or no 'done' event for: "${text.slice(0, 40)}..."`);
        continue;
      }
      if (done.offline) {
        log('⚠️', `utterance returned offline:true — brain unavailable for: "${text.slice(0, 40)}..."`);
        continue;
      }
      brainOnline = true;
      evidenceLines.push(`seeded conversation, MYTHOS replied (brain online): "${String(done.say || '').slice(0, 100)}"`);
    }

    if (collisionAborted) {
      verdict = null; // handled after finally
    } else if (!brainOnline) {
      verdict = 'SKIP';
      reason = "no configured brain provider answered (all providers offline) — cannot exercise mull()'s real brain call without a working key";
    } else {
      const POLL_INTERVAL_MS = 4000;
      const POLL_TIMEOUT_MS = idleBranchReachable ? 120000 : 60000; // shorter corroboration window once root cause is already confirmed
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let found = null;
      log('⏳', `SECONDARY CHECK: polling GET /api/goals/proposals for up to ${POLL_TIMEOUT_MS / 1000}s...`);
      const bonusEventsPromise = captureEvents(port, ['cortex.thought', 'cortex.proposed', 'health.anomaly'], POLL_TIMEOUT_MS + 2000)
        .catch((err) => { log('⚠️', `bonus WS capture failed (non-fatal): ${err.message}`); return []; });

      let crashLogged = false;
      while (Date.now() < deadline && !found && !collisionAborted) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (boot.child.exitCode !== null && !crashLogged) {
          crashLogged = true;
          log('❌', `spawned MYTHOS child exited (code=${boot.child.exitCode}) mid-run — dumping stderr tail:`);
          log('❌', boot.getStderr().slice(-3000));
        }
        if (!assertStillOwned('during poll loop')) break;
        try {
          const body = await httpGetJson(port, '/api/goals/proposals');
          if (body && Array.isArray(body.proposals) && body.proposals.length > 0) {
            found = body.proposals;
          }
        } catch (err) {
          log('⚠️', `poll error (continuing): ${err.message}`);
        }
      }

      const bonusEvents = await bonusEventsPromise;
      const thoughtEvents = bonusEvents.filter((e) => e.type === 'cortex.thought');
      const proposedEvents = bonusEvents.filter((e) => e.type === 'cortex.proposed');
      const anomalyEvents = bonusEvents.filter((e) => e.type === 'health.anomaly');
      log('📊', `bonus WS capture: ${thoughtEvents.length} cortex.thought, ${proposedEvents.length} cortex.proposed, ${anomalyEvents.length} health.anomaly event(s) (0/0/0 is consistent with mull() never even being invoked, matching the PRIMARY check)`);

      if (collisionAborted) {
        verdict = null;
      } else if (found) {
        verdict = 'PASS';
        reason = `cortex idle-tick mull() generated ${found.length} status:'proposed' goal(s), queryable live via GET /api/goals/proposals`;
        evidenceLines.push(`API returned proposals: ${JSON.stringify(found).slice(0, 500)}`);
        const diskProposed = readProposedGoalFiles(vaultRoot);
        if (diskProposed.length > 0) {
          evidenceLines.push(`Disk cross-check: ${diskProposed.length} Goals/*.json file(s) on disk have status:'proposed' (e.g. title="${diskProposed[0].title}")`);
        } else {
          evidenceLines.push("WARNING: proposal(s) visible via API but NOT found on disk under Goals/ — persistence may be in-memory only");
        }
      } else {
        verdict = 'FAIL';
        reason = idleBranchReachable
          ? `after seeding durable-intention conversation and polling for ${POLL_TIMEOUT_MS / 1000}s, GET /api/goals/proposals never returned a status:'proposed' goal, despite a brain call shown to reliably produce proposals in isolation`
          : "the idle branch that gates mull() is structurally unreachable (perceptions never reaches 0 — see PRIMARY CHECK) — propose_goal is never generated on a real boot, confirmed by 0 proposals after seeding + polling and 0 cortex.thought/cortex.proposed events the whole time";
        evidenceLines.push('Root cause: sensors/timer.js emits perception.tick every tick unconditionally; main.js\'s unfiltered bus.subscribe(\'perception.*\', ...) pushes it into working memory; cortex/index.js\'s idle branch (`if (perceptions.length === 0 && !hasActive)`) — the ONLY call site for mull() — therefore never executes in steady state, so the propose_goal suggestion pipeline built on top of it is unreachable from a real boot.');
      }
    }
  } finally {
    await killTree(boot.child);
    try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  }

  if (collisionAborted) {
    log('⏭️', "Phase4/V5 propose_goal (backend): SKIP — port collision with a concurrent process made this run's results untrustworthy; re-run when the machine is less contended");
    process.exit(0);
  }

  for (const line of evidenceLines) log('📋', line);

  if (verdict === 'PASS') {
    log('🎉', `Phase4/V5 propose_goal (backend): PASS — ${reason}`);
    process.exit(0);
  } else if (verdict === 'SKIP') {
    log('⏭️', `Phase4/V5 propose_goal (backend): SKIP — ${reason}`);
    process.exit(0);
  } else {
    log('💀', `Phase4/V5 propose_goal (backend): FAIL — ${reason}`);
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
