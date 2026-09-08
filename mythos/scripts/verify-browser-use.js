#!/usr/bin/env node
'use strict';
// verify-browser-use.js — LIVE proof for browser_task. Runs the real effector against the
// real runner, the real debug browser and the real model key. Not a unit test; the unit
// tests are test/browser-task.test.js.
//
//   node mythos/scripts/verify-browser-use.js            both tasks
//   node mythos/scripts/verify-browser-use.js --video    "play the second video" only
//   node mythos/scripts/verify-browser-use.js --form     httpbin form only
//
// Verdicts, one line each, doctrine as verify-desktop-automation.js:
//   PASS         the oracle held: video -> final URL matches /watch?v= ; form -> final URL is
//                the httpbin /post response page (it echoes the submitted values)
//   FAIL         the runner finished but the oracle did not hold
//   PREREQ-MISSING  runner not installed / no key / provider quota — not a product failure
// Exit 0 on all PASS, 2 on any PREREQ-MISSING, 1 otherwise. Loads mythos/.env first.

const path = require('node:path');
const fs = require('node:fs');

const MYTHOS_DIR = path.resolve(__dirname, '..');
const envFile = path.join(MYTHOS_DIR, '.env');
if (fs.existsSync(envFile)) { try { process.loadEnvFile(envFile); } catch { /* reported by the tool */ } }

const { loadConfig } = require('../src/core/config');
const { buildTools } = require('../src/core/effectors/from-browser-use');
const { browser_launch_debug } = require('../src/core/effectors/from-browser');
const browserAgent = require('../adapters/browser-agent');

const TASKS = {
  video: { task: 'Open youtube.com, search for lofi hip hop radio, and play the second video in the results. Stop once the video page is open and playing.', oracle: (r) => /youtube\.com\/watch\?v=/.test(r.final_url || '') },
  form: { task: 'Go to https://httpbin.org/forms/post . Fill customer name "Test User", telephone "123", email "test@example.com", choose size Medium, pick the topping Bacon, and submit the form. Stop when the response page shows the submitted values.', oracle: (r) => /httpbin\.org\/post/.test(r.final_url || '') },
};

async function main() {
  const which = process.argv.includes('--video') ? ['video'] : process.argv.includes('--form') ? ['form'] : ['video', 'form'];
  const config = loadConfig().config;
  const tool = buildTools({ config, browserAgent, launchDebug: browser_launch_debug })[0];
  let worst = 0;
  for (const name of which) {
    const t0 = Date.now();
    const r = await tool.fn({ task: TASKS[name].task }, { connectionId: 'verify-browser-use' });
    const secs = Math.round((Date.now() - t0) / 1000);
    let verdict;
    if (r.ok !== true && r.notExecuted) verdict = 'PREREQ-MISSING';
    else if (r.ok !== true && /model error|quota|key/i.test(String(r.result))) verdict = 'PREREQ-MISSING';
    else if (r.ok === true && !r.unverified && TASKS[name].oracle(r.result)) verdict = 'PASS';
    else verdict = 'FAIL';
    const detail = r.ok === true ? `steps=${r.result.steps} model=${r.result.model} url=${r.result.final_url}${r.unverified ? ' UNVERIFIED: ' + r.reason : ''}` : String(r.result);
    console.log(`${new Date().toISOString()} ${verdict} browser_task:${name} ${secs}s ${detail}`);
    worst = Math.max(worst, verdict === 'PASS' ? 0 : verdict === 'PREREQ-MISSING' ? 2 : 1);
  }
  // The browser adapter's CDP connection keeps the event loop alive; seen live 2026-09-08,
  // the script printed its verdict and then never returned. Disconnect and exit explicitly.
  try { if (typeof browserAgent.disconnect === 'function') await browserAgent.disconnect(); } catch { /* exiting anyway */ }
  process.exit(worst);
}

main().catch((e) => { console.error('verify-browser-use crashed: ' + (e && e.stack || e)); process.exit(1); });
