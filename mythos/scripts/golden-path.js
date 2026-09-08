#!/usr/bin/env node
'use strict';

// golden-path.js — the one daily measurement (Plans/RESUME.md, 2026-09-07).
//
// WHAT IT MEASURES. The single workflow the product is judged on until it is
// boring: open YouTube, play the third video, pause, resume, next — driven the way
// the operator drives it, as turns over the HUD's WebSocket, against the MYTHOS
// that is ALREADY RUNNING. It appends exactly one line per run to
// .cache/windows-operator/golden-path.log and prints the consecutive-PASS streak.
// That streak is the number the subtraction plan is measured by.
//
// WHAT IT REFUSES TO DO. It never grades a turn on the reply text. A turn PASSES
// only when an action event for one of the tools that could have done the work
// came back ok and not `unverified`, and (for the opening step) the media oracle
// the OS supplies — GET /api/media — reports something playing. A turn that spoke
// and proved nothing is UNVERIFIED, which is distinct from PASS and from FAIL.
// Collapsing those is the defect verify-desktop-automation.js already documents.
//
// PREREQ-MISSING is a fourth outcome and is kept out of the streak in both
// directions: a provider that is offline, a server that is not up, or a browser
// adapter that is not connected says nothing about whether the workflow works.
// It is still printed and logged, because "could not run" hidden inside "did not
// pass" is how a gate lies in the other direction.
//
// SIDE EFFECTS, STATED PLAINLY. This drives the operator's real browser and plays
// real video. It attaches by default and never kills the server it attached to.
// Pass --boot to spawn a throwaway dev-tree instance instead (no browser session
// there, so expect PREREQ-MISSING or UNVERIFIED — useful only for plumbing).
//
// Usage (MYTHOS running):
//   cd mythos && node scripts/golden-path.js
//   cd mythos && node scripts/golden-path.js --port 4478 --token <value>
//   cd mythos && node scripts/golden-path.js --boot
//   cd mythos && node scripts/golden-path.js --json
//
// Exit codes: 0 PASS, 1 FAIL or UNVERIFIED, 2 PREREQ-MISSING.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { log, openMythos, parseHarnessTarget, killTree } = require('./verify-lib');

const REPO = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(REPO, '.cache', 'windows-operator');
const LOG_FILE = path.join(LOG_DIR, 'golden-path.log');
const TURN_TIMEOUT_MS = 45000;

const VERDICT = { PASS: 'PASS', FAIL: 'FAIL', UNVERIFIED: 'UNVERIFIED', PREREQ: 'PREREQ-MISSING' };

// The four turns. `anyOf` is the set of tools that could legitimately have done
// the work; the model chooses among them, so the judge must accept any. A step
// with `oracle: 'media'` additionally requires the OS media session to report
// playback afterwards — the tool's own ok is not enough for the step that
// actually starts the video.
const STEPS = [
  { id: 'open', text: 'Open YouTube and play the third video in the results.',
    anyOf: ['browser_task', 'open_web', 'browser_navigate', 'browser_click', 'browser_press_key'], oracle: 'media' },
  { id: 'pause', text: 'Pause the video.',
    anyOf: ['media_key', 'browser_click', 'browser_press_key'] },
  { id: 'resume', text: 'Resume the video.',
    anyOf: ['media_key', 'browser_click', 'browser_press_key'] },
  { id: 'next', text: 'Next video.',
    anyOf: ['browser_task', 'media_key', 'browser_click', 'browser_press_key', 'browser_navigate'] },
];

// ---- pure judgement, exported for tests -------------------------------------

function actionProves(action, anyOf) {
  const p = action && action.payload;
  if (!p || typeof p !== 'object') return false;
  if (!anyOf.includes(p.tool)) return false;
  if (p.ok !== true || p.unverified) return false;
  if (p.result && typeof p.result === 'object' && (p.result.ok === false || p.result.unverified)) return false;
  return true;
}

// turn: { events, actions, timedOut, ackMs }. oracle: null | { ok, playing, title, error }.
function verdictForStep(step, turn, oracle) {
  if (!turn || turn.timedOut) return { id: step.id, verdict: VERDICT.FAIL, reason: 'turn-timeout' };
  const done = (turn.events || []).find((e) => e.type === 'done');
  if (!done) return { id: step.id, verdict: VERDICT.FAIL, reason: 'missing-done' };
  if (done.offline) return { id: step.id, verdict: VERDICT.PREREQ, reason: 'provider-offline' };
  if (done.error || done.ok === false) return { id: step.id, verdict: VERDICT.FAIL, reason: 'turn-error: ' + (done.error || done.say || '') };
  // Seen live 2026-09-07: with VOICE_S2S_ENABLED the server feeds a typed
  // utterance into the Gemini Live session (server log `live.text-injected`) and
  // releases this channel with an EMPTY done — no say, no other frame, no action
  // event. The reply, if any, left as live-audio on a socket this runner does not
  // hold. That is not "the brain proved nothing"; it is "this channel cannot see
  // the brain", which is a prerequisite and must not read as UNVERIFIED.
  const onlyEmptyDone = (turn.events || []).length === 1 && !(typeof done.say === 'string' && done.say.trim()) && !(turn.actions || []).length;
  if (onlyEmptyDone) return { id: step.id, verdict: VERDICT.PREREQ, reason: 'turn-routed-to-live-session: empty done, nothing observable on the legacy channel (VOICE_S2S_ENABLED?)' };
  const proof = (turn.actions || []).find((a) => actionProves(a, step.anyOf));
  if (!proof) {
    const refused = (turn.actions || []).find((a) => a.payload && step.anyOf.includes(a.payload.tool) && a.payload.refused);
    if (refused) return { id: step.id, verdict: VERDICT.PREREQ, reason: 'tool-refused: ' + refused.payload.refused };
    return { id: step.id, verdict: VERDICT.UNVERIFIED, reason: 'no ok action among ' + step.anyOf.join('|') };
  }
  if (step.oracle === 'media') {
    if (!oracle || !oracle.ok) return { id: step.id, verdict: VERDICT.UNVERIFIED, reason: 'media oracle unreadable: ' + ((oracle && oracle.error) || 'no response') };
    if (!oracle.playing) return { id: step.id, verdict: VERDICT.FAIL, reason: 'tool ok but media oracle reports nothing playing' };
  }
  return { id: step.id, verdict: VERDICT.PASS, reason: proof.payload.tool + (oracle && oracle.title ? ' / now playing: ' + oracle.title : '') };
}

// Worst-outcome-wins, in the order that keeps the streak honest: a missing
// prerequisite means the run did not happen; a FAIL beats an UNVERIFIED; and a
// run with zero steps is not a pass — it is a run that did not happen.
function overallVerdict(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return VERDICT.PREREQ;
  if (list.some((r) => r.verdict === VERDICT.PREREQ)) return VERDICT.PREREQ;
  if (list.some((r) => r.verdict === VERDICT.FAIL)) return VERDICT.FAIL;
  if (list.some((r) => r.verdict === VERDICT.UNVERIFIED)) return VERDICT.UNVERIFIED;
  return VERDICT.PASS;
}

function p95(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil(v.length * 0.95) - 1)];
}

function formatLogLine(at, overall, results, ackP95) {
  const passed = results.filter((r) => r.verdict === VERDICT.PASS).length;
  const notes = results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => r.id + '=' + r.verdict + '(' + r.reason.replace(/\s+/g, '_') + ')');
  return [at, overall, 'steps=' + passed + '/' + results.length, 'ackP95ms=' + (ackP95 === null ? 'n/a' : ackP95)].concat(notes).join(' ');
}

// Consecutive PASS lines counted from the end. PREREQ-MISSING lines are skipped,
// not reset: a day the server was down is not a day the workflow failed.
function streakOf(lines) {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const verdict = String(lines[i]).trim().split(/\s+/)[1];
    if (!verdict) continue;
    if (verdict === VERDICT.PREREQ) continue;
    if (verdict !== VERDICT.PASS) break;
    n += 1;
  }
  return n;
}

// ---- live plumbing -----------------------------------------------------------

// Subscribe and send on ONE socket so the action listener is installed before the
// utterance goes out. ackMs is the time to the FIRST frame carrying our reqId —
// the HUD's acknowledgement, which is what the 2 s p95 target names.
function captureTurn(port, token, text) {
  return new Promise((resolve, reject) => {
    let url = 'ws://127.0.0.1:' + port + '/ws';
    if (token) url += '?token=' + encodeURIComponent(token);
    const ws = new WebSocket(url);
    const reqId = 'golden-' + crypto.randomUUID();
    const events = [], actions = [];
    let settled = false, sentAt = 0, ackMs = null;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { ws.close(); } catch (_) { /* closing */ }
      resolve({ events, actions, timedOut, ackMs });
    };
    const timer = setTimeout(() => finish(true), TURN_TIMEOUT_MS);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.type === 'action') actions.push(msg);
      if (msg.reqId !== reqId) return;
      if (ackMs === null) ackMs = Date.now() - sentAt;
      events.push(msg);
      if (msg.type === 'done') finish(false);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', types: ['action'] }));
      sentAt = Date.now();
      ws.send(JSON.stringify({ type: 'utterance', reqId, text }));
    });
    ws.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(err);
    });
    ws.on('close', () => finish(false));
  });
}

function readMediaOracle(port, token) {
  return new Promise((resolve) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const req = http.get({ host: '127.0.0.1', port, path: '/api/media', headers, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: 'GET /api/media -> ' + res.statusCode });
        let m; try { m = JSON.parse(body); } catch (_) { return resolve({ ok: false, error: 'non-JSON media status' }); }
        const status = String(m.status || m.playbackStatus || m.state || '').toLowerCase();
        resolve({ ok: true, playing: status === 'playing' || m.playing === true, title: m.title || '' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '/api/media timed out' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

// The browser adapter's own reachability check, mirrored: GET <cdpUrl>/json/version.
// Seen live 2026-09-07: with nothing on 9222 the server withheld all 20 browser_*
// tools as UNAVAILABLE before the brain saw them, and four turns went out that
// could not have passed. Ask first; a prerequisite that is missing is reported
// as one, not discovered four turns later as UNVERIFIED.
function probeCdp(cdpUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/json/version', cdpUrl); } catch (err) { return resolve({ ok: false, error: 'bad BROWSER_CDP_URL: ' + err.message }); }
    const req = http.get({ host: u.hostname, port: u.port || 80, path: u.pathname, timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200 ? { ok: true } : { ok: false, error: 'CDP ' + u.href + ' -> ' + res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'CDP ' + u.href + ' timed out' }); });
    req.on('error', (err) => resolve({ ok: false, error: 'no debuggable browser at ' + u.origin + ' (' + err.code + ')' }));
  });
}

function appendLog(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  return { lines, streak: streakOf(lines) };
}

async function main() {
  const argv = process.argv.slice(2);
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) { /* explicit env works too */ }
  const target = parseHarnessTarget(argv, process.env);
  if (!argv.includes('--boot')) target.attach = true;

  let handle;
  try {
    handle = await openMythos(target, { env: { MYTHOS_TEST_HATCH: '1' } });
  } catch (err) {
    const results = [{ id: 'attach', verdict: VERDICT.PREREQ, reason: err.message }];
    const line = formatLogLine(new Date().toISOString(), VERDICT.PREREQ, results, null);
    const { streak } = appendLog(line);
    log('⛔', line);
    log('📈', 'consecutive PASS streak: ' + streak);
    return 2;
  }

  const cdp = await probeCdp(process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222');
  if (!cdp.ok) {
    if (handle.child) await killTree(handle.child);
    const results = [{ id: 'browser', verdict: VERDICT.PREREQ, reason: cdp.error + ' — the signed-in browser must be running with --remote-debugging-port' }];
    const line = formatLogLine(new Date().toISOString(), VERDICT.PREREQ, results, null);
    const { streak } = appendLog(line);
    log('⛔', line);
    log('📈', 'consecutive PASS streak: ' + streak);
    return 2;
  }

  const results = [], acks = [];
  try {
    for (const step of STEPS) {
      const turn = await captureTurn(handle.port, handle.token || '', step.text);
      if (Number.isFinite(turn.ackMs)) acks.push(turn.ackMs);
      const oracle = step.oracle === 'media' ? await readMediaOracle(handle.port, handle.token || '') : null;
      const r = verdictForStep(step, turn, oracle);
      r.ackMs = turn.ackMs;
      // Keep the payload that produced the verdict. A probe that reports a
      // verdict and drops the frames is the most expensive habit in this repo's
      // history (verify-desktop-automation.js, Q2). Printed only under --json.
      r.raw = { say: (turn.events.find((e) => e.type === 'done') || {}).say, events: turn.events, actions: turn.actions, oracle };
      results.push(r);
      log(r.verdict === VERDICT.PASS ? '✅' : r.verdict === VERDICT.PREREQ ? '⛔' : '❌', step.id + ' ' + r.verdict + ' — ' + r.reason + (turn.ackMs !== null ? ' (ack ' + turn.ackMs + 'ms)' : ''));
      // A timeout leaves turn ownership uncertain, and a missing prerequisite
      // will not become present three turns later. Do not overlap another turn.
      if (turn.timedOut || r.verdict === VERDICT.PREREQ) break;
    }
  } finally {
    if (handle && handle.child) await killTree(handle.child);
  }

  const overall = overallVerdict(results);
  const line = formatLogLine(new Date().toISOString(), overall, results, p95(acks));
  const { lines, streak } = appendLog(line);
  if (argv.includes('--json')) console.log(JSON.stringify({ overall, results, line, streak }, null, 2));
  console.log('');
  log('📝', line);
  log('📈', 'consecutive PASS streak: ' + streak + ' (target: 10 across two cold boots, held for a week)');
  log('📄', LOG_FILE + ' (' + lines.length + ' runs recorded)');
  return overall === VERDICT.PASS ? 0 : overall === VERDICT.PREREQ ? 2 : 1;
}

module.exports = { STEPS, VERDICT, actionProves, verdictForStep, overallVerdict, p95, formatLogLine, streakOf, probeCdp, LOG_FILE };

// Requiring this file must not drive the operator's browser.
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('golden-path failed: ' + (err && err.stack ? err.stack : err));
    process.exitCode = 2;
  });
}
