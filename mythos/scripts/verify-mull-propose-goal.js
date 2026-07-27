#!/usr/bin/env node
'use strict';

// verify-mull-propose-goal.js — live verification harness for Phase4/V8c.
//
// Phase4/V8c: the cortex's idle-time mull() reasoning pass is wired to route
// brain-returned goal proposals through the propose_goal effector (V8, Phase
// 4). Exhaustively unit-tested via SOURCE-STRING assertions only (see
// test/phase4d-mull-propose-goal.test.js's own header comment: "mull() is
// closure-private inside cortex/index.js, so we test the CONTRACT via
// source-shape guards" — it greps cortex/index.js's text, it never actually
// RUNS mull()). Per BUGS.md this specific routing has never had a live
// boot+dashboard verification.
//
// This script boots a REAL MYTHOS instance (node src/main.js) with an
// isolated scratch vault, points the 'simple' brain lane at a small local
// HTTP stub standing in for the LLM (so the test is deterministic — whether
// a real model decides to propose a goal is not something this repo can
// control or assert on), and lets the REAL cortex tick loop, REAL mull(),
// REAL propose_goal effector, REAL goals/index.js persistence, and REAL
// GET /api/goals/proposals dashboard route all run unmodified.
//
// The stub returns 3 proposals: [0] valid, [1] valid JSON but empty text
// (must be silently skipped), [2] valid text that must NEVER reach a goal
// file (proves the .slice(0,2) safety cap — mull must never even look at a
// 3rd proposal). This exercises the schemaHint parse, the propose_goal
// routing, the cap, and the skip-invalid guard against the real running
// code, not a source-text grep.
//
// Requirements:
//   - A brain provider key configured for the 'voice' lane (GROQ_API_KEY or
//     similar) so the seeding utterance gets a real spoken reply — this is
//     ONLY used to write a 'conversation' episodic record for mull() to find
//     something to think about; the 'simple' lane mull() actually calls is
//     fully stubbed and needs no real key.
//
// Usage:
//   node scripts/verify-mull-propose-goal.js

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { log, bootMythos, killTree, sendUtterance, captureEvents } = require('./verify-lib');

const PROPOSAL_ONE_TEXT = 'MYTHOS_VERIFY_V8C_PROPOSAL_ONE_' + Date.now();
const PROPOSAL_ONE_CATEGORY = 'Learning';
const PROPOSAL_ONE_REASON = 'MYTHOS_VERIFY_V8C_REASON_ONE';
const PROPOSAL_THREE_TEXT = 'MYTHOS_VERIFY_V8C_PROPOSAL_THREE_MUST_NEVER_APPEAR_' + Date.now();

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickFreePort(min, max) {
  for (let i = 0; i < 30; i++) {
    const p = min + Math.floor(Math.random() * (max - min));
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port found in [${min}, ${max}) after 30 tries`);
}

// A tiny stand-in for an OpenAI-compatible chat-completions endpoint (the
// shape providers/openai-compat.js speaks — POST {baseURL}/chat/completions,
// SSE 'data: {...}' lines, terminated by 'data: [DONE]'). Deterministic canned
// reply matching mull()'s schemaHint so this test never depends on whether a
// real model FEELS like proposing a goal today.
function createStubBrain() {
  const state = { requestCount: 0, lastMessages: null };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requestCount++;
      try { state.lastMessages = JSON.parse(body).messages; } catch (_) { state.lastMessages = null; }
      const payload = {
        thoughts: '', priority: 'low',
        proposals: [
          { text: PROPOSAL_ONE_TEXT, category: PROPOSAL_ONE_CATEGORY, reason: PROPOSAL_ONE_REASON },
          { text: '', category: 'General', reason: 'must be skipped — empty text' },
          { text: PROPOSAL_THREE_TEXT, category: 'Health', reason: 'third proposal — must be dropped by the .slice(0,2) cap' },
        ],
      };
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\ndata: [DONE]\n\n';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse);
    });
    req.on('error', () => { try { res.destroy(); } catch (_) {} });
  });
  return { server, state };
}

function listenAsync(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error(`bad JSON from ${url}: ${err.message}`)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  log('🧪', 'Phase4/V8c mull()->propose_goal live verification starting');

  const stub = createStubBrain();
  const stubPort = await listenAsync(stub.server, 0);
  log('✅', `stub brain listening on 127.0.0.1:${stubPort}`);

  const mythosPort = await pickFreePort(4500, 4900);
  log('ℹ️', `chosen MYTHOS port: ${mythosPort}`);

  // NOTE: deliberately NOT under os.tmpdir() — on this Windows host that
  // resolves through an 8.3 short-name segment (e.g. "ARGHYA~1"), and the
  // sensors.file file-watcher's fs.watch() on a path whose short/long-name
  // casing disagrees crashes the whole process with a libuv native assertion
  // ("Assertion failed: !_wcsnicmp(filename, dir, dirlen), fs-event.c") before
  // the cortex ever gets a chance to tick. A subfolder under the repo's own
  // mythos/ dir (long names throughout) sidesteps that entirely. Matches the
  // convention already used by other concurrent verify-*.js scratch vaults
  // (see the vault_test_audit_* dirs alongside this one) — cleaned up below.
  const vaultRoot = path.join(__dirname, '..', 'vault_test_audit_v8c_' + Date.now());
  fs.mkdirSync(vaultRoot, { recursive: true });
  log('ℹ️', `isolated scratch vault: ${vaultRoot}`);

  let boot;
  try {
    boot = await bootMythos({
      port: mythosPort,
      env: {
        MYTHOS_VAULT_ROOT: vaultRoot,
        // Fast, deterministic idle-mull cadence for this test only.
        MYTHOS_TICK_MS: '300',
        MYTHOS_MULL_EVERY_TICKS: '3',
        // Force the 'simple' brain lane (the only lane mull() calls) onto our
        // stub — CHAIN_SIMPLE is lanes.default.js's override env var. Cerebras
        // is "alive" purely by API-key presence (registry.js isProviderAlive),
        // no network probe, so pointing its base URL at our stub is enough.
        CEREBRAS_API_KEY: 'verify-stub-key-unused',
        CEREBRAS_API_URL: `http://127.0.0.1:${stubPort}/v1`,
        CHAIN_SIMPLE: 'cerebras:mythos-verify-stub',
        // Keep the tick loop free of unrelated real-world perceptions so
        // idle+mull fires reliably and isn't fighting other sensors/planner
        // chatter for the idle branch.
        CALENDAR_UPCOMING_ENABLED: 'false',
        GMAIL_TRIAGE_ENABLED: 'false',
        PLANNER_ENABLED: 'false',
        BROWSER_AUTOMATION: 'false',
      },
    });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    stub.server.close();
    process.exit(1);
  }

  let pass = true;
  const failures = [];
  try {
    // Seed a 'conversation' episodic record — mull() skips entirely
    // ("nothing to think about") when both recent conversations and recent
    // events are empty. Uses the real 'voice' lane (real GROQ/Mistral key),
    // untouched by our stub, which only overrides the 'simple' lane.
    log('⏳', 'sending seeding utterance over real WS...');
    const utt = await sendUtterance(mythosPort, 'I keep saying I will start journaling every night and never actually do it.', { timeoutMs: 20000 });
    if (utt.timedOut) {
      log('⚠️', 'seeding utterance timed out (voice lane may be offline) — mull may still find nothing to think about');
    } else {
      log('✅', 'seeding utterance completed — conversation episodic record written');
    }

    // Poll the REAL dashboard-facing route (server/routes/goals.js) that
    // ui/public/js/views/proposals.js itself calls — the actual operator-visible
    // surface, not an internal bus event. Concurrently capture the cortex's
    // own 'tick' broadcasts (cortex/index.js: bus.emit('tick', {perceptions})
    // -> server/index.js broadcastAll) so a failure can be diagnosed with the
    // exact live perceptions-per-tick count, not just "it didn't happen".
    const WAIT_MS = 20000;
    log('⏳', `polling GET /api/goals/proposals for up to ${WAIT_MS / 1000}s (several mull cycles at 3 ticks * 300ms) while watching real tick broadcasts...`);
    const tickCapturePromise = captureEvents(mythosPort, ['tick'], WAIT_MS);
    const deadline = Date.now() + WAIT_MS;
    let sawProposalOne = false;
    let allProposals = [];
    while (Date.now() < deadline) {
      let resp;
      try {
        resp = await httpGetJson(`http://127.0.0.1:${mythosPort}/api/goals/proposals`);
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      allProposals = resp.proposals || [];
      if (allProposals.some((p) => p.text === PROPOSAL_ONE_TEXT)) {
        sawProposalOne = true;
        // Keep polling a bit longer (don't return early) so a handful more
        // mull cycles get a chance to run — this is what lets us assert the
        // cap held across MULTIPLE cycles, not just the first one.
        if (Date.now() > deadline - 4000) break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const tickEvents = await tickCapturePromise;
    const idleTicks = tickEvents.filter((e) => e.payload && e.payload.perceptions === 0).length;

    log('ℹ️', `stub brain received ${stub.state.requestCount} request(s) for the 'simple' lane`);
    log('ℹ️', `observed ${tickEvents.length} real tick broadcast(s); ${idleTicks} had perceptions===0 (the idle-branch gate mull() lives behind)`);
    if (stub.state.requestCount === 0) {
      if (tickEvents.length > 0 && idleTicks === 0) {
        failures.push(
          `mull() never fired because the idle-branch gate never opened: all ${tickEvents.length} observed ` +
          `real ticks had perceptions>=1. Root cause: sensors/timer.js's createTimerSensor unconditionally ` +
          `emits 'perception.tick' every MYTHOS_TICK_MS (main.js wires bus.subscribe('perception.*', ` +
          `e => memory.working.pushPerception(e.payload)) — that heartbeat perception is queued every ` +
          `single tick, so cortex/index.js's \`if (perceptions.length === 0 && !hasActive)\` idle check ` +
          `(the ONLY code path that calls mull(), tick=${tickEvents[0] ? tickEvents[0].payload.tick : '?'}..${tickEvents.length ? tickEvents[tickEvents.length - 1].payload.tick : '?'}) never opens, ` +
          `structurally preventing mull() from ever running in live operation, independent of ` +
          `MYTHOS_MULL_EVERY_TICKS cadence.`
        );
      } else {
        failures.push('stub brain was never called — mull() never fired (idle-tick condition or cadence not met)');
      }
      pass = false;
    } else if (stub.state.lastMessages) {
      const promptText = stub.state.lastMessages.map((m) => m.content).join('\n');
      if (promptText.indexOf('GOALS the operator might want to add') === -1) {
        failures.push('the request the stub received does not look like mull()\'s prompt (missing "GOALS the operator might want to add") — some other simple-lane caller may have hit the stub instead');
        pass = false;
      } else {
        log('✅', 'confirmed the stub was hit by mull()\'s actual prompt text');
      }
    }

    if (sawProposalOne) {
      const rec = allProposals.find((p) => p.text === PROPOSAL_ONE_TEXT);
      log('✅', `GET /api/goals/proposals contains proposal #1: id=${rec.id} category=${rec.category} reason=${rec.reason} drive=${rec.drive}`);
      if (rec.category !== PROPOSAL_ONE_CATEGORY) {
        failures.push(`proposal #1 category mismatch: expected "${PROPOSAL_ONE_CATEGORY}", got "${rec.category}"`);
        pass = false;
      }
      if (rec.reason !== PROPOSAL_ONE_REASON) {
        failures.push(`proposal #1 reason mismatch: expected "${PROPOSAL_ONE_REASON}", got "${rec.reason}"`);
        pass = false;
      }
      if (rec.drive !== 'curiosity') {
        failures.push(`proposal #1 drive mismatch: expected "curiosity", got "${rec.drive}"`);
        pass = false;
      }
    } else {
      failures.push('GET /api/goals/proposals never showed proposal #1 within 20s — propose_goal routing did not fire');
      pass = false;
    }

    const sawProposalThree = allProposals.some((p) => p.text === PROPOSAL_THREE_TEXT);
    if (sawProposalThree) {
      failures.push('proposal #3 (beyond the .slice(0,2) cap) reached the goal queue — the per-pass cap is broken');
      pass = false;
    } else if (stub.state.requestCount > 0) {
      log('✅', 'proposal #3 never reached the queue — the .slice(0,2) per-pass cap held');
    }

    const emptyTextLeak = allProposals.some((p) => !p.text || !p.text.trim());
    if (emptyTextLeak) {
      failures.push('a proposal with empty/blank text reached the goal queue — the "skip invalid proposal" guard is broken');
      pass = false;
    } else if (stub.state.requestCount > 0) {
      log('✅', 'the empty-text proposal (index 1) was correctly skipped, never created a goal');
    }
  } finally {
    if (!pass && process.env.VERIFY_DEBUG === '1') {
      log('🔎', 'DEBUG stdout tail:\n' + boot.getStdout().slice(-4000));
      log('🔎', 'DEBUG stderr tail:\n' + boot.getStderr().slice(-4000));
    }
    await killTree(boot.child);
    stub.server.close();
    try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
  }

  if (pass) {
    log('🎉', 'Phase4/V8c mull()->propose_goal: PASS');
    process.exit(0);
  } else {
    log('💀', 'Phase4/V8c mull()->propose_goal: FAIL');
    for (const f of failures) log('  ↳', f);
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
