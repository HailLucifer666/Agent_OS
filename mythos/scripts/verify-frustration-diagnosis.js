#!/usr/bin/env node
'use strict';

// verify-frustration-diagnosis.js — live verification harness for BUG-021.
//
// BUG-021: when a user expressed frustration ("not working", "broken"), the
// voice agent repeated templated empathy instead of diagnosing anything.
// The fix adds a FRUSTRATION RULE to the always-included voice-agent system
// prompt (src/core/voice/voice-agent.js RULES constant, ~line 239) instructing
// the model to call read_status and list_goals (both tier-0/danger:false/no
// confirm) FIRST with needs_result:true, then give a concrete diagnosis
// instead of canned empathy.
//
// Being a prompt-only change, this cannot be unit-tested — there's no static
// way to verify an LLM's future decision from a prompt string. This script
// drives the REAL running system as the human would: it boots MYTHOS with a
// real brain key, sends a frustration utterance over the actual WS protocol,
// and inspects two independent live oracles:
//
//   1. The 'action' WS broadcast stream — dispatch-action.js emits
//      bus.emit('action.completed', {tool, ok}) for EVERY real tool dispatch,
//      and server/index.js relays it to all WS clients as
//      {type:'action', payload:{tool, ok, ...}}. If the model actually calls
//      read_status/list_goals (not just claims to), these broadcasts appear
//      DURING the turn, independent of and before the final spoken reply.
//   2. The final 'say' text on the 'done' message — logged as evidence for
//      human inspection (regex checks on natural language are unreliable,
//      so this is evidence, not the pass/fail oracle).
//
// Usage:
//   node scripts/verify-frustration-diagnosis.js

const net = require('net');
const { log, bootMythos, killTree, captureEvents, sendUtterance } = require('./verify-lib');

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  // Stay well away from the project default (4478) — other agents may be
  // live-verifying concurrently against their own instances.
  const candidates = [4611, 4623, 4657, 4701, 4733, 4771, 4809, 4853, 4887];
  for (const p of candidates) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port found in the 4500-4900 candidate list');
}

const FRUSTRATION_UTTERANCE = "this isn't working, it's broken, nothing is working right now";

async function main() {
  log('🧪', 'BUG-021 frustration-diagnosis verification starting');

  const port = await pickFreePort();
  log('ℹ️', `using port ${port} (avoiding default 4478 — other agents may be live-verifying concurrently)`);

  let boot;
  try {
    boot = await bootMythos({ port, env: { BROWSER_AUTOMATION: 'false' } });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let pass = false;
  let sayText = '';
  let actionEvents = [];
  try {
    log('🗣️', `sending frustration utterance: "${FRUSTRATION_UTTERANCE}"`);

    // Listen for 'action' broadcasts (tool-dispatch completions) concurrently
    // with the utterance turn — these do NOT carry reqId (see
    // server/index.js's bus.subscribe('action.*', ...)), so they must be
    // captured on a separate subscription, not filtered out of sendUtterance.
    const actionsPromise = captureEvents(port, ['action'], 35000);
    const utterancePromise = sendUtterance(port, FRUSTRATION_UTTERANCE, { timeoutMs: 32000 });

    const [actions, utteranceResult] = await Promise.all([actionsPromise, utterancePromise]);
    actionEvents = actions;

    if (utteranceResult.timedOut) {
      log('❌', 'utterance timed out with no "done" reply — cannot verify (brain/tool loop hung)');
    } else {
      const doneMsg = utteranceResult.events.find((m) => m.type === 'done');
      sayText = (doneMsg && doneMsg.say) || '';
      log('💬', `final "say": ${JSON.stringify(sayText)}`);
    }

    const calledTools = new Set(actionEvents.map((e) => e.payload && e.payload.tool));
    const readStatusEvt = actionEvents.find((e) => e.payload && e.payload.tool === 'read_status');
    const listGoalsEvt = actionEvents.find((e) => e.payload && e.payload.tool === 'list_goals');

    log('ℹ️', `tools dispatched during turn: [${Array.from(calledTools).join(', ') || 'none'}]`);

    if (readStatusEvt && listGoalsEvt) {
      log('✅', `read_status dispatched (ok=${readStatusEvt.payload.ok}), list_goals dispatched (ok=${listGoalsEvt.payload.ok}) — FRUSTRATION RULE followed live`);
      pass = true;
    } else {
      const missing = [];
      if (!readStatusEvt) missing.push('read_status');
      if (!listGoalsEvt) missing.push('list_goals');
      log('❌', `FRUSTRATION RULE NOT followed — missing tool dispatch(es): ${missing.join(', ')}`);
    }
  } finally {
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', 'BUG-021 frustration-diagnosis: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-021 frustration-diagnosis: FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
