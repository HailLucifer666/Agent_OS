#!/usr/bin/env node
'use strict';

// verify-news-route.js — live verification harness for BUG-028.
//
// BUG-028: asking MYTHOS for "the news" used to make it either (a) hallucinate
// navigate({route:'health'}) while narrating as if news opened, or (b)
// correctly call navigate({route:'news'}) and get a clean rejection since no
// such route exists (mythos/src/core/effectors/routes.js ALL_ROUTES has no
// 'news' entry). The fix adds a clarifying note to the navigate tool
// description in CATALOG_RAW (mythos/src/core/voice/voice-agent.js line 43)
// telling the model up front that there is no "news" route.
//
// This is a prompt-only change with no automated unit test — it can only be
// checked by actually driving a live conversation and observing what the
// voice agent does. This script drives that conversation over the same raw
// WS 'utterance' protocol the real compose bar uses
// (mythos/ui/public/js/compose-bar.js), and inspects the server's own
// broadcast telemetry instead of guessing from text alone:
//
//   - server/index.js subscribes to bus 'action.*' and broadcasts every
//     action.completed/denied/blocked as {type:'action', payload:{tool, ok,
//     goalId, reason}} to ALL connected clients (broadcastAll — not gated by
//     subscription).
//   - dispatch-action.js only emits 'ui.navigate' (broadcast as
//     {type:'navigate', route}) when the navigate call actually SUCCEEDED
//     (result.ok === true).
//
// So: if the model calls navigate({route:'news'}) it will show up as an
// {type:'action', payload:{tool:'navigate', ok:false, reason:...}} event with
// NO matching 'navigate' broadcast (clean rejection — acceptable, though the
// fix is meant to stop the model from even trying). If the model instead
// hallucinates a working route (e.g. 'health') while claiming it opened the
// news, that shows up as {type:'action', payload:{tool:'navigate', ok:true}}
// PLUS a {type:'navigate', route:'health'} broadcast — the exact bug. That
// combination is the FAIL signal this script checks for, cross-referenced
// against the model's own reply text for a false "opened" claim.
//
// Requirements:
//   - At least one brain provider key set (GROQ_API_KEY, MISTRAL_API_KEY,
//     etc.) — without one the voice agent never reasons about tool calls at
//     all (utterance just returns "brain is offline").
//
// Usage:
//   node scripts/verify-news-route.js

const path = require('path');
const WebSocket = require('ws');
const { log, bootMythos, killTree, MYTHOS_DIR } = require('./verify-lib');

const PORT = 4650; // well clear of the 4478 default; verified free before use

// This script's own process doesn't inherit mythos/.env automatically — only
// the spawned MYTHOS child loads it (main.js calls process.loadEnvFile()).
// Load it here too, the same way, purely so the brain-key precondition check
// below can see it (bootMythos already forwards process.env to the child).
try { process.loadEnvFile(path.join(MYTHOS_DIR, '.env')); } catch (_) {}

function driveUtterance(port, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const reqId = 'verify-news-' + Date.now();
    const actions = [];
    const navigates = [];
    const openWebs = [];
    let doneMsg = null;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve({ actions, navigates, openWebs, doneMsg, timedOut: true });
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'utterance', reqId: reqId, text: text }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === 'action') actions.push(msg.payload);
      if (msg.type === 'navigate') navigates.push(msg);
      if (msg.type === 'open-web') openWebs.push(msg.payload);
      if (msg.type === 'done' && msg.reqId === reqId) {
        doneMsg = msg;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        resolve({ actions, navigates, openWebs, doneMsg, timedOut: false });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WS error: ${err.message}`));
    });
  });
}

async function main() {
  log('🧪', 'BUG-028 news-route verification starting');

  const hasBrainKey = !!(
    process.env.GROQ_API_KEY || process.env.MISTRAL_API_KEY ||
    process.env.NIM_API_KEY || process.env.OPENROUTER_API_KEY ||
    process.env.CEREBRAS_API_KEY || process.env.ZCODE_API_KEY
  );
  if (!hasBrainKey) {
    log('⏭️', 'SKIP: no brain provider key set (GROQ_API_KEY/MISTRAL_API_KEY/etc in mythos/.env) — voice agent cannot reason about tool calls without one');
    process.exit(3);
  }

  let boot;
  try {
    boot = await bootMythos({ port: PORT, env: { BROWSER_AUTOMATION: 'false' } });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let pass = true;
  let evidence = '';
  try {
    const prompt = "what's the news for today?";
    log('💬', `sending utterance: "${prompt}"`);
    const { actions, navigates, openWebs, doneMsg, timedOut } = await driveUtterance(PORT, prompt, 30000);

    if (timedOut) {
      log('❌', 'utterance timed out with no done message — treating as inconclusive/FAIL');
      pass = false;
    }

    log('ℹ️', `captured ${actions.length} action event(s): ${JSON.stringify(actions)}`);
    log('ℹ️', `captured ${navigates.length} navigate broadcast(s): ${JSON.stringify(navigates)}`);
    log('ℹ️', `captured ${openWebs.length} open-web broadcast(s): ${JSON.stringify(openWebs)}`);
    const sayText = (doneMsg && (doneMsg.say || doneMsg.speak)) || '';
    log('ℹ️', `final reply say/speak: ${JSON.stringify(sayText)}`);

    const navigateActions = actions.filter((a) => a && a.tool === 'navigate');
    const succeededNavigate = navigateActions.find((a) => a.ok === true);
    const rejectedNavigate = navigateActions.filter((a) => a.ok === false);
    // BUG-028's bug is specifically about the 'navigate' tool having no 'news'
    // route (ALL_ROUTES in routes.js). open_web/web_search succeeding is a
    // DIFFERENT tool with its own route to real content (a spawned widget/tab)
    // — that's the documented acceptable outcome in the bug's own verification
    // note ("responds with a search/open_web result instead of a navigate
    // call"), not a fabrication. Any successfully-completed action (ok:true,
    // any tool) is grounding that justifies an "opening" claim in the reply.
    const anySucceeded = actions.some((a) => a && a.ok === true);

    if (succeededNavigate) {
      log('❌', `navigate call SUCCEEDED while answering a news question (route hallucinated) — action=${JSON.stringify(succeededNavigate)} navigateBroadcasts=${JSON.stringify(navigates)}`);
      pass = false;
    } else {
      log('✅', 'no navigate call succeeded — model did not open/claim a dashboard panel via navigate for "news" (there is none)');
    }

    rejectedNavigate.forEach((a) => {
      log('ℹ️', `model called navigate and got a clean rejection (ok:false, reason: ${a.reason}) — not the fabrication bug, though the ideal fix avoids even attempting this`);
    });

    const claimsOpenedNews = /\b(opened?|opening)\b[^.]{0,40}\bnews\b|\bnews\b[^.]{0,20}\b(is|now)\b[^.]{0,20}\bopen(ed)?\b/i.test(sayText);
    if (claimsOpenedNews && !anySucceeded) {
      log('❌', `reply text claims something news-related was opened ("${sayText}") but NO action actually succeeded — fully fabricated success`);
      pass = false;
    } else if (claimsOpenedNews && succeededNavigate) {
      log('❌', `reply claims news opened AND a navigate call succeeded to a non-news route — this is the exact BUG-028 fabrication pattern`);
      pass = false;
    } else if (claimsOpenedNews && anySucceeded) {
      log('✅', `reply's "opening news" claim is grounded — a real action succeeded (${JSON.stringify(actions.filter((a) => a.ok === true))}), matching the bug's documented acceptable outcome (open_web/web_search instead of navigate)`);
    } else {
      log('✅', 'reply text does not falsely claim a news panel was opened');
    }

    evidence = `prompt="${prompt}" | actions=${JSON.stringify(actions)} | navigateBroadcasts=${JSON.stringify(navigates)} | openWebBroadcasts=${JSON.stringify(openWebs)} | say=${JSON.stringify(sayText)}`;
    log('📋', evidence);
  } finally {
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', 'BUG-028 news-route: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-028 news-route: FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
