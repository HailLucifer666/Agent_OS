#!/usr/bin/env node
'use strict';

// BUG-021: verifies legacy WS text-turn completion and tool opt-in behavior.
// This does not exercise acoustic Gemini Live, or certify the reply's empathy,
// diagnosis quality, or absence of spoken internal notes. Inspect prose manually.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { log, bootMythos, killTree } = require('./verify-lib');
const { pickPorts } = require('./pick-free-ports');

const CASES = [
  { id: 'general-venting', text: 'My day has been awful. Traffic was terrible and nothing went right.', tools: [] },
  { id: 'mythos-frustration', text: 'MYTHOS, this is frustrating. Nothing you did worked. Let me finish explaining.', tools: [] },
  { id: 'requested-diagnosis', text: 'MYTHOS, please check your current status and list my goals to investigate what failed.', tools: ['read_status', 'list_goals'] },
];

function verdict(scenario, turn) {
  if (turn.timedOut) return { ok: false, reason: 'turn-timeout' };
  const done = turn.events.find((e) => e.type === 'done');
  if (!done) return { ok: false, reason: 'missing-done' };
  if (done.offline) return { ok: false, unavailable: true, reason: 'provider-unavailable' };
  if (done.error || done.ok === false) return { ok: false, reason: 'turn-error' };
  if (typeof done.say !== 'string' || !done.say.trim()) return { ok: false, reason: 'empty-reply' };
  const actions = turn.actions || [];
  if (!scenario.tools.length && actions.length) return { ok: false, reason: 'unsolicited-action' };
  const failed = scenario.tools.filter((tool) => !actions.some((e) => e.payload && e.payload.tool === tool && e.payload.ok === true && !e.payload.unverified && !(e.payload.result && e.payload.result.unverified)));
  return failed.length ? { ok: false, reason: 'requested-tools-not-verified', failed } : { ok: true, reason: 'transport-and-tool-behavior-verified' };
}

// Subscribe and send on ONE socket: listener installation precedes the request,
// unlike two racing sockets whose missed events could falsely prove no probes.
function captureTurn(port, text, timeoutMs = 32000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const reqId = 'frustration-' + crypto.randomUUID();
    const events = [], actions = [];
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true; clearTimeout(timer); ws.close();
      resolve({ events, actions, timedOut });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === 'action') actions.push(msg);
      if (msg.reqId !== reqId) return;
      events.push(msg);
      if (msg.type === 'done') finish(false);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', types: ['action'] }));
      ws.send(JSON.stringify({ type: 'utterance', reqId, text }));
    });
    ws.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); ws.close(); reject(err);
    });
    ws.on('close', () => finish(false));
  });
}

async function main() {
  try { process.loadEnvFile(path.resolve(__dirname, '../.env')); } catch (_) { /* explicit env works too */ }
  // Provider eligibility belongs to the real brain; its offline done frame reports UNAVAILABLE.
  const cache = path.resolve(__dirname, '../../.cache/frustration-verifier');
  fs.mkdirSync(cache, { recursive: true });
  const run = fs.realpathSync.native(fs.mkdtempSync(path.join(cache, 'run-')));
  const ports = await pickPorts();
  let boot;
  try {
    boot = await bootMythos({ port: ports.mythosPort, env: {
      TEMP: run, TMP: run, MYTHOS_VAULT_ROOT: path.join(run, 'vault'), MYTHOS_SETTINGS_PATH: path.join(run, 'settings.json'),
      MYTHOS_AUTH_TOKEN: '', EDGE_TTS_PORT: String(ports.edgeTtsPort), EDGE_TTS_URL: `http://127.0.0.1:${ports.edgeTtsPort}`,
      BROWSER_AUTOMATION: 'false', BOOT_GREETING: 'false', IMMUNE_EXPLAIN: 'false', PLANNER_ENABLED: 'false',
      SCREEN_AWARENESS_ENABLED: 'false', WINDOW_AWARENESS_ENABLED: 'false', EDGE_TTS_AUTOSTART: 'false', PIPER_AUTOSTART: 'false',
    } });
    let failed = false, unavailable = false;
    for (const scenario of CASES) {
      const turn = await captureTurn(ports.mythosPort, scenario.text);
      const result = verdict(scenario, turn);
      fs.writeFileSync(path.join(run, scenario.id + '.json'), JSON.stringify({ scenario, result, turn }, null, 2));
      log(result.ok ? 'PASS' : result.unavailable ? 'UNAVAILABLE' : 'FAIL', `${scenario.id}: ${result.reason}`);
      failed ||= !result.ok; unavailable ||= Boolean(result.unavailable);
      // A timeout leaves turn ownership uncertain; do not overlap another turn.
      if (turn.timedOut || unavailable) break;
    }
    log('SCOPE', `Legacy WS text/tool evidence only; manual language/acoustic review remains. Evidence: ${run}`);
    return unavailable ? 2 : failed ? 1 : 0;
  } finally { if (boot) await killTree(boot.child); }
}

module.exports = { CASES, verdict, captureTurn };
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((err) => { log('FAIL', err.message); process.exitCode = 2; });