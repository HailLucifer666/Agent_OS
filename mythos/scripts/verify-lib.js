'use strict';

// verify-lib.js — shared helpers for scripts/verify-*.js harnesses.
//
// Common concerns: booting MYTHOS in the background, waiting for /health,
// opening a WS connection, capturing broadcast events, clean shutdown.
// All verify-*.js scripts import from here so the boot/WS plumbing is
// written exactly once.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const MYTHOS_DIR = path.join(__dirname, '..');
const MAIN_PATH = path.join(MYTHOS_DIR, 'src', 'main.js');

const DEFAULT_PORT = 4478;
const BOOT_TIMEOUT_MS = 30000;
const HEALTH_POLL_MS = 500;

// Print a colored status line. keep it simple — no chalk, no deps.
function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// Boot MYTHOS as a detached child. Resolves { child, port } once /health
// returns 200. Kills the child + rejects on boot failure or timeout.
function bootMythos(opts) {
  opts = opts || {};
  const port = opts.port || DEFAULT_PORT;
  const env = Object.assign({}, process.env, opts.env || {}, {
    MYTHOS_PORT: String(port),
    MYTHOS_BIND: '127.0.0.1',
    // Disable noisy peripherals that would just log connection-refused
    BOOT_GREETING: 'false',
    BROWSER_AUTOMATION: opts.env && opts.env.BROWSER_AUTOMATION !== undefined ? opts.env.BROWSER_AUTOMATION : 'false',
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_PATH], {
      cwd: MYTHOS_DIR,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let booted = false;
    const timers = [];

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (!booted) reject(new Error(`spawn error: ${err.message}`));
    });
    child.on('close', (code) => {
      if (!booted) {
        reject(new Error(`MYTHOS exited before /health responded (code=${code}). stderr:\n${stderr.slice(-2000)}`));
      }
    });

    // Poll /health until it returns 200 or timeout
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    const pollHealth = () => {
      if (Date.now() > deadline) {
        reject(new Error(`boot timed out after ${BOOT_TIMEOUT_MS}ms. stdout tail:\n${stdout.slice(-2000)}`));
        return;
      }
      const req = http.get({
        host: '127.0.0.1', port: port, path: '/health', timeout: 2000
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            booted = true;
            log('✅', `MYTHOS booted on port ${port}`);
            resolve({ child, port, getStdout: () => stdout, getStderr: () => stderr });
          } else {
            timers.push(setTimeout(pollHealth, HEALTH_POLL_MS));
          }
        });
      });
      req.on('error', () => { timers.push(setTimeout(pollHealth, HEALTH_POLL_MS)); });
      req.on('timeout', () => { req.destroy(); timers.push(setTimeout(pollHealth, HEALTH_POLL_MS)); });
    };
    timers.push(setTimeout(pollHealth, 800));   // give node a moment to start
  });
}

// Kill a child process tree. win32 needs taskkill /T.
function killTree(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const pid = child.pid;
    if (!pid) return resolve();
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-pid, 'SIGTERM');
      }
    } catch (_) { try { child.kill('SIGTERM'); } catch (__) {} }
    child.on('close', () => resolve());
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 5000);
  });
}

// Open a WS subscription, collect broadcast events of the given types for
// `durationMs`. Resolves with the captured event list. Always closes the
// socket before resolving.
function captureEvents(port, types, durationMs, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const events = [];
    let url = `ws://127.0.0.1:${port}/ws`;
    if (opts.token) url += `?token=${encodeURIComponent(opts.token)}`;
    const ws = new WebSocket(url);
    let opened = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(events);
    }, durationMs);

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'subscribe', types: types }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Server sends { type, payload } for broadcasts. Capture by type.
        if (types.includes(msg.type) || types.includes('*')) {
          events.push(msg);
        }
      } catch (_) {}
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      if (!opened) reject(new Error(`WS connect failed: ${err.message}`));
      else resolve(events);   // already captured something, just return
    });
    ws.on('close', () => { clearTimeout(timer); resolve(events); });
  });
}

// Send a single utterance and capture the reply chain. Returns the full
// list of messages received until 'done' or timeout.
function sendUtterance(port, text, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const events = [];
    let url = `ws://127.0.0.1:${port}/ws`;
    if (opts.token) url += `?token=${encodeURIComponent(opts.token)}`;
    const ws = new WebSocket(url);
    const reqId = 'verify-' + Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve({ events, timedOut: true });
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'utterance', reqId: reqId, text: text }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.reqId === reqId) events.push(msg);
        if (msg.type === 'done' && msg.reqId === reqId) {
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          resolve({ events, timedOut: false });
        }
      } catch (_) {}
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WS utterance failed: ${err.message}`));
    });
  });
}

// Read the vault directory under MYTHOS_DIR. Returns { dir, Semantic, Plans,
// Episodic } helper for inspecting state post-verification.
function vaultPath() {
  const root = process.env.MYTHOS_VAULT_ROOT || './vault';
  return path.isAbsolute(root) ? root : path.join(MYTHOS_DIR, root);
}

module.exports = {
  log, bootMythos, killTree, captureEvents, sendUtterance, vaultPath,
  MYTHOS_DIR, DEFAULT_PORT
};
