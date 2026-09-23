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

// Boot MYTHOS as an owned child. Resolves { child, port } once /health
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
      detached: process.platform !== 'win32',
      windowsHide: true
    });

    let stdout = '', stderr = '';
    let settled = false, pollTimer = null, request = null;
    const timeoutMs = Number(opts.bootTimeoutMs) > 0 ? Number(opts.bootTimeoutMs) : BOOT_TIMEOUT_MS;
    const clean = () => {
      clearTimeout(pollTimer); clearTimeout(deadlineTimer);
      if (request) { const req = request; request = null; req.destroy(); }
    };
    const fail = async (err) => {
      if (settled) return;
      settled = true; clean();
      // The caller cannot clean up a boot handle it never received.
      await killTree(child);
      reject(err);
    };
    const deadlineTimer = setTimeout(() => fail(new Error(`boot timed out after ${timeoutMs}ms. stdout tail:\n${stdout.slice(-2000)}`)), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => fail(new Error(`spawn error: ${err.message}`)));
    child.on('close', (code) => fail(new Error(`MYTHOS exited before /health responded (code=${code}). stderr:\n${stderr.slice(-2000)}`)));

    const pollHealth = () => {
      if (settled) return;
      let finished = false;
      const retry = () => {
        if (finished || settled) return;
        finished = true;
        if (request) { const req = request; request = null; req.destroy(); }
        pollTimer = setTimeout(pollHealth, HEALTH_POLL_MS);
      };
      try {
        request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
          res.resume();
          res.once('error', retry);
          res.once('aborted', retry);
          res.once('end', () => {
            if (finished || settled) return;
            if (res.statusCode !== 200) return retry();
            finished = true; settled = true; clean();
            log('✅', `MYTHOS booted on port ${port}`);
            resolve({ child, port, getStdout: () => stdout, getStderr: () => stderr });
          });
        });
        request.once('error', retry);
        request.once('timeout', retry);
      } catch (err) { fail(err); }
    };
    pollTimer = setTimeout(pollHealth, Math.min(800, timeoutMs / 4));
  });
}
// ── ATTACH MODE ───────────────────────────────────────────────────────────────
//
// bootMythos() above spawns a fresh DEV-TREE process: spawn(process.execPath,
// [MAIN_PATH]). Every one of the 34 scripts/verify-*.js harnesses goes through
// it, which means not one of them has ever exercised the PACKAGED application —
// the only thing the operator now runs. BUG-360 is what that gap costs: an
// installer shipped with all 14 phone_* tools missing and every check passing.
//
// attachMythos() is bootMythos's other half. It connects to a MYTHOS that is
// ALREADY RUNNING and returns the same handle shape, so a harness can take
// either without knowing which. That is the point: a harness rewritten for the
// packaged app would drift from the dev-run one and the two would stop being
// comparable, which is the whole value of running both.
//
// It deliberately does NOT start anything. The question being asked is what THIS
// install resolved at boot — its config, its models, its adapters — and a fresh
// in-process boot would answer with the harness's own environment instead.
// scripts/parity-check.js attaches for exactly the same reason and says so.
function attachMythos(opts) {
  opts = opts || {};
  const port = opts.port || Number(process.env.MYTHOS_PORT) || DEFAULT_PORT;
  // BUG-413 (2026-09-09): an EXPLICIT token — including '' meaning "none" — must
  // win over the environment. `opts.token || process.env.X` read '' as absent and
  // fell through to the machine's User-scope MYTHOS_AUTH_TOKEN (set for the phone
  // node), so "fails loudly when the server wants a token and none was given"
  // attached successfully on any machine with that variable and reddened the
  // pre-commit hook on every commit. Only an OMITTED token consults the env.
  const token = opts.token !== undefined ? String(opts.token) : (process.env.MYTHOS_AUTH_TOKEN || '');
  const timeoutMs = opts.timeoutMs || 8000;

  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`attach failed: GET /health -> ${res.statusCode}. Is MYTHOS running on port ${port}?`));
          return;
        }
        let health = null;
        try { health = JSON.parse(body); } catch (_) { /* /health is JSON today; tolerate a change */ }
        // A missing token when the server wants one fails LOUDLY here rather
        // than as a puzzling WS 401 fifty lines into a harness.
        if (health && health.authRequired && !token) {
          reject(new Error('attach failed: this MYTHOS requires MYTHOS_AUTH_TOKEN. Pass --token <value> or set it in the environment.'));
          return;
        }
        log('🔌', `attached to MYTHOS on port ${port}` + (token ? ' (token supplied)' : ''));
        resolve({
          // child stays null on purpose. killTree(null) already resolves
          // immediately, so a harness's existing cleanup is correct with no
          // change — and, more importantly, a harness must never kill a server
          // it did not start. The operator is using that window.
          child: null,
          attached: true,
          port,
          token,
          health,
          getStdout: () => '[attached: this process did not spawn MYTHOS, so it holds no stdout]',
          getStderr: () => '[attached: this process did not spawn MYTHOS, so it holds no stderr]',
        });
      });
    });
    // BUG-367 (2026-08-27): this used to stop at "on port N", while the error
    // path below ended with the "Is MYTHOS running on port N?" hint. Two
    // rejection paths, two different contracts — and a caller that asserted the
    // hint passed or failed depending on which one won the race. Under
    // full-suite load a connect to an unbound port reaches this deadline before
    // ECONNREFUSED arrives, so verify-lib-attach.test.js blocked a commit in two
    // independent sessions, hours apart, and passed every time it was run alone.
    // Both paths now say the same thing; the hint is as true of a hang as of a
    // refusal, and it is the sentence that tells a harness user what to do.
    req.on('timeout', () => { req.destroy(); reject(new Error(`attach failed: /health timed out after ${timeoutMs}ms on port ${port}. Is MYTHOS running on port ${port}?`)); });
    req.on('error', (err) => reject(new Error(`attach failed: ${err.message}. Is MYTHOS running on port ${port}?`)));
  });
}

// One argv convention for every harness, so "run this against the .exe" is the
// same two flags everywhere instead of each script inventing its own.
//   --attach [port]     attach instead of booting (default port if omitted)
//   --token <value>     falls back to MYTHOS_AUTH_TOKEN
function parseHarnessTarget(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  const e = env || process.env;
  const out = { attach: false, port: Number(e.MYTHOS_PORT) || DEFAULT_PORT, token: e.MYTHOS_AUTH_TOKEN || '' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--attach') {
      out.attach = true;
      // The port is optional, so only consume the next argv when it really is
      // one — otherwise `--attach --token X` would swallow `--token` and then
      // fail with an unrelated complaint about a missing token.
      const next = args[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) { out.port = Number(next); i += 1; }
    } else if (args[i] === '--port') {
      const next = args[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) { out.port = Number(next); i += 1; }
    } else if (args[i] === '--token') {
      if (args[i + 1] !== undefined) { out.token = String(args[i + 1]); i += 1; }
    }
  }
  return out;
}

// Boot or attach according to the parsed target. The line every harness should
// use, so neither mode is the awkward one.
function openMythos(target, bootOpts) {
  return target && target.attach
    ? attachMythos({ port: target.port, token: target.token })
    : bootMythos(Object.assign({ port: target ? target.port : undefined }, bootOpts || {}));
}

// Invoke ONE NAMED TOOL and wait for its result — the deterministic sibling of
// sendUtterance(), which goes through the brain and therefore lets the MODEL
// choose the tool (so the same request can take different paths on different
// runs; see one-sample-hides-model-flakiness).
//
// Requires MYTHOS_TEST_HATCH=1 on the SERVER. Against a server without it, the
// reply is the old `command` echo — no tool, no result — so this reports that
// plainly rather than presenting an echo as a successful call.
// A REUSABLE socket for a run of dispatches. This is not an optimisation.
//
// dispatchTool() below opens one socket per call, and the /ws upgrade is rate
// limited by a token bucket (server/index.js) — a sweep firing tool after tool
// gets `Unexpected server response: 429` after roughly the fourth, which reads
// like the server rejecting the TOOL rather than the connection rate. A harness
// whose own transport intermittently fails is worse than no harness: it teaches
// the reader to re-run reds until they go green.
//
// One socket, many reqIds, replies matched by reqId — which is what the protocol
// was built for; sendUtterance already correlates the same way.
function openToolSession(port, opts) {
  opts = opts || {};
  let url = `ws://127.0.0.1:${port}/ws`;
  if (opts.token) url += `?token=${encodeURIComponent(opts.token)}`;
  const ws = new WebSocket(url);
  const pending = new Map(); // reqId -> {resolve, timer}
  let seq = 0;
  let fatal = null;

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', (err) => { fatal = err; reject(new Error(`WS session failed: ${err.message}`)); });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const entry = msg && msg.reqId ? pending.get(msg.reqId) : null;
    if (!entry || msg.type !== 'done') return;
    pending.delete(msg.reqId);
    clearTimeout(entry.timer);
    entry.resolve(interpretDoneFrame(msg));
  });
  // A socket that dies mid-sweep must fail every OUTSTANDING call rather than
  // leave them hanging until each individual timeout — 30 probes x 30s is a
  // harness that looks wedged.
  ws.on('close', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: 'the WS session closed before this tool replied' });
    }
    pending.clear();
  });

  return {
    ready,
    call(tool, args, callOpts) {
      const timeoutMs = (callOpts && callOpts.timeoutMs) || opts.timeoutMs || 30000;
      if (fatal) return Promise.resolve({ ok: false, error: `WS session failed: ${fatal.message}` });
      seq += 1;
      const reqId = `verify-tool-${seq}-${Date.now()}`;
      return ready.then(() => new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          resolve({ ok: false, timedOut: true, error: `no reply to ${tool} within ${timeoutMs}ms` });
        }, timeoutMs);
        pending.set(reqId, { resolve, timer });
        ws.send(JSON.stringify({ type: 'command', reqId, tool, args: args || {} }));
      }));
    },
    close() { try { ws.close(); } catch (_) {} },
  };
}

// Shared by openToolSession and dispatchTool so a single-shot call and a swept
// one can never disagree about what a reply means.
function interpretDoneFrame(msg) {
  // The echo shape means the hatch is disabled. Saying so is the difference
  // between "this tool is broken" and "you did not arm the hatch" — and a
  // harness that silently read the echo as a pass would report a green sweep
  // against a server that ran nothing at all.
  if (msg.tool === undefined && msg.refused === undefined && msg.result === undefined) {
    return { ok: false, hatchDisabled: true, frame: msg,
      error: 'the server replied with the legacy command echo — start it with MYTHOS_TEST_HATCH=1' };
  }
  if (msg.refused !== undefined || msg.error) {
    return { ok: false, refused: msg.refused, requireConfirm: Boolean(msg.requireConfirm), tier: msg.tier, frame: msg,
      error: msg.refused || msg.say || 'refused' };
  }

  // TWO LAYERS OF `ok`, and reading only the outer one is a false green.
  // The frame arriving without `error` means the DISPATCH succeeded — the tool
  // was found, allowed and called. The effector's own verdict lives inside
  // msg.result.ok, and an effector that rejects its arguments returns
  // {ok:false, result:'A path is required.'} through a perfectly successful
  // dispatch. The first version of this reported that as ok:true and the sweep
  // printed `[PASS] search_files  A path is required.` — a green row whose own
  // payload said it had failed. Same shape as the {ok:false,error} that once
  // surfaced in the HUD as a bare "Failed".
  const payload = msg.result;
  if (payload && typeof payload === 'object' && payload.ok === false) {
    const reason = typeof payload.result === 'string' ? payload.result
      : (payload.error || payload.reason || 'the effector reported ok:false');
    return { ok: false, tool: msg.tool, tier: msg.tier, result: payload, frame: msg, effectorFailed: true, error: reason };
  }
  return { ok: true, tool: msg.tool, tier: msg.tier, result: msg.result, frame: msg };
}

function dispatchTool(port, tool, args, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    let url = `ws://127.0.0.1:${port}/ws`;
    if (opts.token) url += `?token=${encodeURIComponent(opts.token)}`;
    const ws = new WebSocket(url);
    const reqId = 'verify-tool-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve({ ok: false, timedOut: true, error: `no reply to ${tool} within ${timeoutMs}ms` });
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'command', reqId, tool, args: args || {} }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.reqId !== reqId || msg.type !== 'done') return;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      resolve(interpretDoneFrame(msg));
      return;
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WS dispatch failed: ${err.message}`));
    });
  });
}


// Kill a child process tree. win32 needs taskkill /T.
// Called with the handle's `child`, which attachMythos sets to null — the early
// return below is what makes "never kill a server you did not start" automatic
// rather than something each harness has to remember.
function killTree(child) {
  if (!child || !child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    // bootMythos owns a detached process group. Parent exit does not imply
    // descendant exit, so observe and escalate the group, never just the PID.
    return new Promise((resolve) => {
      let poll;
      const finish = () => { clearTimeout(deadline); clearTimeout(poll); resolve(); };
      const deadline = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        finish();
      }, 5000);
      const check = () => {
        try { process.kill(-child.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return finish(); }
        poll = setTimeout(check, 100);
      };
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code === 'ESRCH') return finish(); }
      check();
    });
  }
  // Windows taskkill cannot discover descendants once their parent has exited;
  // this harness has no Job Object ownership oracle for that case.
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const pid = child.pid;
    if (!pid) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    child.once('close', finish);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish();
    }, 5000);
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.once('error', () => { try { child.kill('SIGTERM'); } catch (_) {} });
    } catch (_) { try { child.kill('SIGTERM'); } catch (__) {} }
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
  log, bootMythos, attachMythos, openMythos, parseHarnessTarget, dispatchTool, openToolSession, interpretDoneFrame, killTree, captureEvents, sendUtterance, vaultPath,
  MYTHOS_DIR, DEFAULT_PORT
};
