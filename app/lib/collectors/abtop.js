// abtop.js — Agent Monitor collector. Shells out to the `abtop` CLI (https://github.com/graykode/abtop)
// for live Claude Code / Codex / OpenCode session data. Honest-inert: never lets an error escape
// the poll loop or the exported functions into an unhandled rejection / uncaught exception.
const { spawn, execFile } = require('child_process');

const RUN_TIMEOUT_MS = 12000;
const AGENT_FAMILIES = ['claude', 'codex', 'opencode'];

let state = {
  available: false,
  snapshot: null,
  lastError: null,
  lastPolledAt: null,
};
let pollMs = 5000;
let started = false;
let intervalHandle = null;

function runOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn('abtop', ['--json'], { shell: true, windowsHide: true });

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          execFile('taskkill', ['/PID', String(child.pid), '/F']);
        } catch {
          // best-effort
        }
      }
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wrapped = new Error(`abtop failed to start: ${err.message}`);
      wrapped.code = err.code === 'ENOENT' ? 'NOT_FOUND' : err.code;
      reject(wrapped);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`abtop timed out after ${RUN_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-800) || `exit code ${code}`;
        reject(new Error(`abtop exited with error: ${tail}`));
        return;
      }
      try {
        const snapshot = JSON.parse(stdoutBuf);
        resolve({ snapshot, warning: stderrBuf.trim() || null });
      } catch (err) {
        reject(new Error(`abtop returned invalid JSON: ${err.message}`));
      }
    });
  });
}

// abtop's own token_rate is always 0 for us: every poll spawns a fresh abtop process, and
// abtop only reports a delta vs its own previous in-process tick (first tick = 0 by design).
// Compute the rate here instead by diffing each session's active tokens between our polls
// (active = input + output + cache_create; cache_read excluded — abtop's own definition).
let prevActiveTokens = new Map(); // `${pid}:${session_id}` -> active tokens at last poll
let prevActiveAt = null;

function computeTokenRate(snapshot) {
  const now = Date.now();
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const next = new Map();
  let delta = 0;
  for (const s of sessions) {
    const key = `${s.pid}:${s.session_id}`;
    const active = (s.input_tokens || 0) + (s.output_tokens || 0) + (s.cache_create_tokens || 0);
    next.set(key, active);
    const prev = prevActiveTokens.get(key);
    // Sessions with no prior sample (first poll / newly appeared) contribute 0 this tick —
    // their lifetime totals would otherwise register as a huge fake spike.
    if (prev !== undefined && active > prev) delta += active - prev;
  }
  const elapsed = prevActiveAt ? now - prevActiveAt : null;
  prevActiveTokens = next;
  prevActiveAt = now;
  if (!elapsed || elapsed <= 0) return;
  // Token output is bursty at poll granularity (whole assistant turns flush at once), so a
  // single-tick delta whipsaws between 0 and huge. Report a rolling ~60s window instead:
  // stable, still honest.
  rateWindow.push({ t: now, delta });
  while (rateWindow.length && now - rateWindow[0].t > RATE_WINDOW_MS) rateWindow.shift();
  const windowSpan = Math.max(now - rateWindow[0].t, elapsed);
  snapshot.token_rate = rateWindow.reduce((sum, r) => sum + r.delta, 0);
  snapshot.interval_ms = windowSpan; // frontend normalizes to /min by this
}
const RATE_WINDOW_MS = 60000;
const rateWindow = []; // {t, delta} samples inside the rolling window

async function pollTick() {
  try {
    const { snapshot, warning } = await runOnce();
    computeTokenRate(snapshot);
    state = { available: true, snapshot, lastError: warning, lastPolledAt: Date.now() };
  } catch (err) {
    state = {
      available: false,
      snapshot: state.snapshot,
      lastError: err && err.message ? err.message : String(err),
      lastPolledAt: Date.now(),
    };
  }
}

function start() {
  if (started) return;
  if (process.env.AGENT_MONITOR_ENABLED === 'false') return;
  started = true;
  pollMs = Number(process.env.AGENT_MONITOR_POLL_MS) || 5000;
  pollTick();
  // unref() so this interval never keeps a process (e.g. a `node --test` subprocess that
  // requires server.js, which calls start() unconditionally at module load) alive on its own.
  intervalHandle = setInterval(pollTick, pollMs).unref();
}

function getState() {
  return { ...state, enabled: started, pollMs };
}

const EXEC_TIMEOUT_MS = 8000;

// Runs `tasklist /FI "PID eq <pid>" /FO CSV /NH` and returns the image name (lowercased) for
// that PID, or null if the PID isn't running / has no rows.
function verifyPidCommand(pid) {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        reject(new Error(`tasklist check failed: ${err.message}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find((l) => l.trim());
      if (!line || /no tasks/i.test(line)) {
        resolve(null);
        return;
      }
      const firstField = line.split(',')[0] || '';
      const imageName = firstField.replace(/^"|"$/g, '').toLowerCase();
      resolve(imageName || null);
    });
  });
}

// Runs `netstat -ano` and returns true if `pid` currently owns a listening/connected socket on `port`.
function verifyPidOwnsPort(pid, port) {
  return new Promise((resolve, reject) => {
    execFile('netstat', ['-ano'], { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        reject(new Error(`netstat check failed: ${err.message}`));
        return;
      }
      const pidStr = String(pid);
      const portSuffix = `:${port}`;
      const owns = stdout.split(/\r?\n/).some((line) => {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) return false;
        const localAddr = cols[1] || '';
        const linePid = cols[cols.length - 1];
        return linePid === pidStr && localAddr.endsWith(portSuffix);
      });
      resolve(owns);
    });
  });
}

function taskkillPid(pid) {
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve();
    });
  });
}

async function killSession({ pid, agentCli }) {
  const snapshotSessions = Array.isArray(state.snapshot?.sessions) ? state.snapshot.sessions : [];
  const knownSession = snapshotSessions.find((s) => Number(s.pid) === Number(pid));
  if (!knownSession) {
    throw new Error(`PID ${pid} does not match any session in the last polled snapshot`);
  }

  const imageName = await verifyPidCommand(pid);
  if (!imageName) {
    throw new Error(`PID ${pid} is not running — nothing to kill`);
  }
  const family = String(agentCli || '').toLowerCase();
  const matches = AGENT_FAMILIES.some((f) => family.includes(f) && imageName.includes(f));
  if (!matches) {
    throw new Error(`refusing to kill PID ${pid}: process does not look like a ${agentCli} session`);
  }
  await taskkillPid(pid);
}

async function killPort({ pid, port }) {
  const snapshotOrphans = Array.isArray(state.snapshot?.orphan_ports) ? state.snapshot.orphan_ports : [];
  const knownOrphan = snapshotOrphans.find((o) => Number(o.pid) === Number(pid) && Number(o.port) === Number(port));
  if (!knownOrphan) {
    throw new Error(`PID ${pid} / port ${port} does not match any orphan port in the last polled snapshot`);
  }

  const imageName = await verifyPidCommand(pid);
  if (!imageName) {
    throw new Error(`PID ${pid} is not running — nothing to kill`);
  }
  const ownsPort = await verifyPidOwnsPort(pid, port);
  if (!ownsPort) {
    throw new Error(`refusing to kill PID ${pid}: it does not currently hold port ${port}`);
  }
  await taskkillPid(pid);
}

module.exports = { start, getState, killSession, killPort };
