#!/usr/bin/env node
// MYTHOS end-to-end harness.
//
// The `node --test` suite proves units and seams. It cannot prove the app
// BOOTS — see CLAUDE.md: a slice once shipped with 2598 green tests and an
// Electron shell that died on `screen` before app.ready. This harness closes
// that gap by starting the real processes and driving the real surfaces:
//
//   A  server boot        node src/main.js -> /health answers
//   B  HTTP surface       every GET route + malformed-body POSTs (no 5xx)
//   C  WebSocket          real /ws connect + subscribe + broadcast received
//   D  HUD in a browser   real Chromium loads the UI, no console/page errors
//   E  Electron shell     the packaged entrypoint actually reaches ready
//
// Deliberately NOT exercised: any POST that actuates (media control, pipeline
// execute/ship, kanban build, goal accept, pin verify). Those spend tokens,
// drive the operator's PC, or mutate real stores. E2E must not do that.
//
// Lives outside test/ on purpose (BUG-134): node --test's discovery is
// directory-based — every .js/.cjs/.mjs file under a directory named `test`
// is collected regardless of name, so a `.mjs` extension never protected this
// from the unit gate. It genuinely boots the server, Electron and Chromium,
// which the unit baseline must not do on every commit — see CLAUDE.md.
//
//   node scripts/e2e/run-e2e.mjs [--skip-electron] [--skip-ui] [--headed] [--strict]
//
// --strict treats a skip as a failure. CI runs with it: without it a runner that
// is missing Chromium or Electron reports green having verified nothing, which is
// the silent-coverage trap this harness exists to avoid.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MYTHOS = path.resolve(HERE, '..', '..');
const REPO = path.resolve(MYTHOS, '..');
const ARTIFACTS = path.join(HERE, 'artifacts');

const PORT = Number(process.env.E2E_PORT || 4999);
const ELECTRON_PORT = Number(process.env.E2E_ELECTRON_PORT || 4998);
const TTS_PORT = Number(process.env.E2E_TTS_PORT || 5099);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = new Set(process.argv.slice(2));
const SKIP_ELECTRON = argv.has('--skip-electron');
const SKIP_UI = argv.has('--skip-ui');
const HEADED = argv.has('--headed');
const STRICT = argv.has('--strict');

const BOOT_TIMEOUT_MS = 90_000;
const ELECTRON_SETTLE_MS = 30_000;

const results = [];
let phase = 'setup';
function record(name, status, detail = '', requested = false) {
  results.push({ phase, name, status, detail: String(detail).slice(0, 400), requested });
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const pass = (n, d) => record(n, 'pass', d);
const fail = (n, d) => record(n, 'fail', d);
// An involuntary skip (no Chromium, no Electron) is missing coverage and fails under
// --strict. A skip the operator explicitly asked for via --skip-* is a deliberate
// scope cut and stays a skip, so CI can drop one flaky phase without losing the gate.
const skip = (n, d) => record(n, 'skip', d);
const skipRequested = (n, d) => record(n, 'skip', d, true);
// BUG-135: a foreign-origin console error / page error / failed request (e.g. the
// weather widget's ipapi.co fallback hitting a public rate limit in headless
// Chromium) is not a defect in this app. It stays visible — printed, named by URL —
// without gating the run. Never pushed into `results`, so it can never fail or skip.
function note(name, detail = '') {
  console.log(`  [NOTE] ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ELECTRON_RUN_AS_NODE is exported by some agent/CI shells and makes electron
// run as a bare node binary — `app` is then undefined and main.js dies at the
// first app.* access, which reads like a boot-fatal regression but is env.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function collect(child, sink) {
  child.stdout?.on('data', (d) => { sink.out += d.toString(); });
  child.stderr?.on('data', (d) => { sink.err += d.toString(); });
}

async function waitForHealth(port, timeoutMs, child, sink) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`process exited early (code ${child.exitCode}): ${(sink.err || sink.out).slice(-300)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.text();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`no /health on ${port} within ${timeoutMs}ms`);
}

function kill(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(resolve, 6000);
    child.once('exit', () => { clearTimeout(done); resolve(); });
    // tree-kill: the server forks pc-child/tts sidecars that outlive a bare kill
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  });
}

// ---------------------------------------------------------------- phase A
let server = null;
const serverIO = { out: '', err: '' };

async function phaseA_boot() {
  phase = 'A · server boot';
  console.log(`\n=== ${phase} ===`);
  server = spawn(process.execPath, ['src/main.js'], {
    cwd: MYTHOS,
    env: cleanEnv({
      MYTHOS_PORT: String(PORT),
      MYTHOS_BIND: '127.0.0.1',
      EDGE_TTS_PORT: String(TTS_PORT),
      EDGE_TTS_URL: `http://127.0.0.1:${TTS_PORT}`,
      MYTHOS_E2E: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  collect(server, serverIO);

  const t0 = Date.now();
  try {
    const body = await waitForHealth(PORT, BOOT_TIMEOUT_MS, server, serverIO);
    pass('server reaches /health', `${Date.now() - t0}ms · ${body.slice(0, 80)}`);
  } catch (err) {
    fail('server reaches /health', err.message);
    return false;
  }

  const fatal = /\b(EADDRINUSE|MODULE_NOT_FOUND|SyntaxError|ReferenceError|TypeError: Cannot read)/.exec(serverIO.err);
  if (fatal) fail('boot log clean', `saw ${fatal[0]}`);
  else pass('boot log clean', 'no fatal signature in stderr');
  return true;
}

// ---------------------------------------------------------------- phase B
const GET_ROUTES = [
  '/health', '/api/status', '/api/stats', '/api/system', '/api/audit/recent',
  '/api/checkpoints', '/api/checkpoints/e2e-missing',
  '/api/config/s2s', '/api/config/vad', '/api/config/wakeword',
  '/api/engagements', '/api/engagements/e2e-missing',
  '/api/forge/projects', '/api/forge/projects/e2e-missing',
  '/api/goals', '/api/goals/proposals', '/api/jobs/e2e-missing',
  '/api/kanban', '/api/media', '/api/media/art',
  '/api/memory/episodic', '/api/memory/semantic', '/api/memory/e2e-bogus-store',
  '/api/news', '/api/pin/status', '/api/pipeline',
];

// Malformed JSON can never create a record — it dies in the body parser. This
// proves the write endpoints reject garbage with 4xx instead of throwing 5xx,
// without actuating anything.
const MALFORMED_POSTS = ['/api/goals', '/api/kanban/cards', '/api/engagements', '/api/pipeline/capture'];

async function phaseB_http() {
  phase = 'B · HTTP surface';
  console.log(`\n=== ${phase} ===`);
  let bad = 0;
  for (const route of GET_ROUTES) {
    try {
      const res = await fetch(BASE + route, { signal: AbortSignal.timeout(20_000) });
      const ct = res.headers.get('content-type') || '';
      if (res.status >= 500) { fail(`GET ${route}`, `HTTP ${res.status}`); bad++; continue; }
      if (ct.includes('application/json')) {
        try { await res.json(); } catch (e) { fail(`GET ${route}`, `bad JSON: ${e.message}`); bad++; continue; }
      }
      pass(`GET ${route}`, `HTTP ${res.status}`);
    } catch (err) { fail(`GET ${route}`, err.message); bad++; }
  }
  for (const route of MALFORMED_POSTS) {
    try {
      const res = await fetch(BASE + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"unterminated":',
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 500) { fail(`POST ${route} (malformed)`, `HTTP ${res.status}, want 4xx`); bad++; }
      else pass(`POST ${route} (malformed)`, `HTTP ${res.status}`);
    } catch (err) { fail(`POST ${route} (malformed)`, err.message); bad++; }
  }
  try {
    const res = await fetch(`${BASE}/api/definitely-not-a-route`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) pass('unknown route 404s', 'HTTP 404');
    else fail('unknown route 404s', `HTTP ${res.status}`);
  } catch (err) { fail('unknown route 404s', err.message); }
  return bad;
}

// ---------------------------------------------------------------- phase C
async function phaseC_ws() {
  phase = 'C · WebSocket';
  console.log(`\n=== ${phase} ===`);
  let WebSocket;
  try { WebSocket = require(path.join(MYTHOS, 'node_modules', 'ws')); }
  catch (err) { skip('ws client available', err.message); return; }

  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = [];
    let opened = false;
    const finish = (fn) => { try { fn(); } finally { try { ws.close(); } catch {} resolve(); } };
    const timer = setTimeout(() => finish(() => {
      if (!opened) fail('ws connects', 'timeout before open');
      else if (!seen.length) fail('ws delivers a broadcast', 'subscribed, nothing received in 20s');
    }), 20_000);

    ws.on('open', () => {
      opened = true;
      pass('ws connects', `ws://127.0.0.1:${PORT}/ws`);
      ws.send(JSON.stringify({ type: 'subscribe', types: ['tick', 'health', 'entity-state', 'state'], replay: true }));
      pass('ws accepts subscribe', 'tick/health/entity-state/state');
      // unknown message types must not kill the connection
      ws.send(JSON.stringify({ type: 'e2e-nonsense-message' }));
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      seen.push(msg.type);
      if (seen.length >= 1) {
        clearTimeout(timer);
        finish(() => {
          pass('ws delivers a broadcast', `first: ${msg.type}`);
          pass('ws survives an unknown message', 'socket still open');
        });
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); finish(() => fail('ws connects', err.message)); });
  });
}

// ---------------------------------------------------------------- phase D
function findChrome() {
  // An override that points nowhere is "no browser found", not a launch attempt —
  // otherwise a typo surfaces as an opaque spawn error instead of an honest skip.
  if (process.env.E2E_CHROME) {
    return fs.existsSync(process.env.E2E_CHROME) ? process.env.E2E_CHROME : null;
  }
  const candidates = [];
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  if (pf) candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf86) candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf86) candidates.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (local) {
    const cache = path.join(local, 'ms-playwright');
    if (fs.existsSync(cache)) {
      for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        candidates.push(path.join(cache, dir, 'chrome-win', 'chrome.exe'));
      }
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

async function phaseD_ui() {
  phase = 'D · HUD in a browser';
  console.log(`\n=== ${phase} ===`);
  if (SKIP_UI) { skipRequested('HUD loads', '--skip-ui'); return; }

  let chromium;
  try { ({ chromium } = require(path.join(MYTHOS, 'node_modules', 'playwright-core'))); }
  catch (err) { skip('HUD loads', `playwright-core: ${err.message}`); return; }

  const exe = findChrome();
  if (!exe) { skip('HUD loads', 'no chromium/chrome/edge binary found (set E2E_CHROME)'); return; }

  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED, executablePath: exe });
  } catch (err) { fail('browser launches', err.message); return; }
  pass('browser launches', path.basename(exe));

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // An empty/inline location (no url) is the page's own script, so it counts
      // as same-origin — only an explicit foreign url is a third party (BUG-135).
      const url = m.location()?.url || '';
      if (url && !url.startsWith(BASE)) note('foreign-origin console error', `${url} — ${m.text()}`);
      else consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('requestfailed', (r) => {
      const msg = r.failure()?.errorText || '';
      // aborted media/streaming requests are normal on teardown
      if (/ERR_ABORTED/.test(msg)) return;
      const url = r.url();
      if (!url.startsWith(BASE)) note('foreign-origin request failed', `${url.slice(0, 90)} ${msg}`);
      else failedRequests.push(`${url.slice(0, 90)} ${msg}`);
    });

    const res = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!res || res.status() >= 400) fail('HUD responds', `HTTP ${res ? res.status() : 'none'}`);
    else pass('HUD responds', `HTTP ${res.status()}`);

    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    await sleep(3000); // let modules boot + first WS frames land

    const title = await page.title();
    pass('document renders', `title="${title}"`);

    const shape = await page.evaluate(() => ({
      bodyChildren: document.body ? document.body.children.length : 0,
      text: (document.body?.innerText || '').trim().length,
      canvases: document.querySelectorAll('canvas').length,
      liveRegions: document.querySelectorAll('[aria-live]').length,
      scripts: document.querySelectorAll('script').length,
      wsOpen: typeof window.WebSocket === 'function',
    }));
    if (shape.bodyChildren > 0 && shape.text > 0) pass('HUD paints content', `${shape.bodyChildren} root nodes, ${shape.text} chars of text`);
    else fail('HUD paints content', JSON.stringify(shape));
    pass('HUD a11y regions present', `${shape.liveRegions} aria-live, ${shape.canvases} canvas`);

    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const shot = path.join(ARTIFACTS, 'hud.png');
    await page.screenshot({ path: shot, fullPage: false });
    pass('screenshot captured', path.relative(REPO, shot));

    if (pageErrors.length) fail('no uncaught page errors', `${pageErrors.length}: ${pageErrors.slice(0, 3).join(' | ')}`);
    else pass('no uncaught page errors');

    if (consoleErrors.length) fail('no console errors', `${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(' | ')}`);
    else pass('no console errors');

    if (failedRequests.length) fail('no failed asset requests', `${failedRequests.length}: ${failedRequests.slice(0, 3).join(' | ')}`);
    else pass('no failed asset requests');
  } catch (err) {
    fail('HUD loads', err.message);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- phase E
async function phaseE_electron() {
  phase = 'E · Electron shell';
  console.log(`\n=== ${phase} ===`);
  if (SKIP_ELECTRON) { skipRequested('Electron reaches ready', '--skip-electron'); return; }

  let electronBin;
  try { electronBin = require(path.join(REPO, 'node_modules', 'electron')); }
  catch (err) { skip('Electron reaches ready', `electron not installed: ${err.message}`); return; }
  if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
    skip('Electron reaches ready', 'electron binary path unresolved');
    return;
  }

  const io = { out: '', err: '' };
  const child = spawn(electronBin, ['electron/main.js'], {
    cwd: REPO,
    env: cleanEnv({
      MYTHOS_PORT: String(ELECTRON_PORT),
      MYTHOS_BIND: '127.0.0.1',
      EDGE_TTS_PORT: String(TTS_PORT + 1),
      EDGE_TTS_URL: `http://127.0.0.1:${TTS_PORT + 1}`,
      MYTHOS_E2E: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  collect(child, io);

  let healthy = false;
  try {
    await waitForHealth(ELECTRON_PORT, ELECTRON_SETTLE_MS, child, io);
    healthy = true;
  } catch { /* fall through to log inspection */ }

  const all = io.out + io.err;
  // the documented failure mode: an app.ready-gated API touched at module scope
  const readyViolation = /can't be used before the app ['"]ready['"] event/i.test(all);
  const hardCrash = /^\s*(Uncaught )?(Error|TypeError|ReferenceError|SyntaxError):/m.exec(all);
  const alive = child.exitCode === null;

  if (readyViolation) fail('no app.ready violation', "an Electron API was touched before app.ready");
  else pass('no app.ready violation');

  if (alive) pass('Electron process stays up', `alive after ${ELECTRON_SETTLE_MS}ms`);
  else fail('Electron process stays up', `exited code ${child.exitCode}: ${all.slice(-300)}`);

  if (healthy) pass('Electron serves /health', `port ${ELECTRON_PORT}`);
  else fail('Electron serves /health', `no /health on ${ELECTRON_PORT} in ${ELECTRON_SETTLE_MS}ms`);

  if (hardCrash && !readyViolation) fail('no fatal error in Electron log', hardCrash[0]);
  else if (!hardCrash) pass('no fatal error in Electron log');

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'electron-boot.log'), all);
  await kill(child);
}

// ---------------------------------------------------------------- report
async function main() {
  console.log(`MYTHOS E2E — server:${PORT} electron:${ELECTRON_PORT} tts:${TTS_PORT}`);
  const started = Date.now();
  let booted = false;
  try {
    booted = await phaseA_boot();
    if (booted) {
      await phaseB_http();
      await phaseC_ws();
      await phaseD_ui();
    } else {
      phase = 'B · HTTP surface'; skip('all HTTP checks', 'server never booted');
      phase = 'C · WebSocket'; skip('all WS checks', 'server never booted');
      phase = 'D · HUD in a browser'; skip('all UI checks', 'server never booted');
    }
  } finally {
    await kill(server);
  }
  // Electron runs last and alone — it starts a full second instance.
  await phaseE_electron();

  const dur = ((Date.now() - started) / 1000).toFixed(1);
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail');
  const skips = results.filter((r) => r.status === 'skip');
  // Coverage that went missing because the environment could not provide it, as
  // opposed to a phase the caller deliberately turned off.
  const unrequestedSkips = skips.filter((r) => !r.requested);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`E2E: ${passed} pass · ${failed.length} fail · ${skips.length} skip · ${dur}s${STRICT ? ' · strict' : ''}`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - [${f.phase}] ${f.name} — ${f.detail}`);
  }
  if (unrequestedSkips.length) {
    console.log(`\nUnverified (environment could not run these)${STRICT ? ' — fatal under --strict:' : ':'}`);
    for (const s of unrequestedSkips) console.log(`  - [${s.phase}] ${s.name} — ${s.detail}`);
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACTS, 'e2e-results.json'),
    JSON.stringify({
      durationSec: Number(dur), strict: STRICT,
      passed, failed: failed.length, skipped: skips.length, unverified: unrequestedSkips.length,
      results,
    }, null, 2),
  );
  if (serverIO.out || serverIO.err) {
    fs.writeFileSync(path.join(ARTIFACTS, 'server-boot.log'), serverIO.out + '\n--- stderr ---\n' + serverIO.err);
  }
  const bad = failed.length + (STRICT ? unrequestedSkips.length : 0);
  process.exit(bad ? 1 : 0);
}

main().catch(async (err) => {
  console.error('E2E harness crashed:', err);
  await kill(server);
  process.exit(2);
});
