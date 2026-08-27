'use strict';

// util/port-holder.js — "what is holding this port?", answered honestly.
//
// BUG-379 (2026-08-27). WHY THIS EXISTS
//
// Between 2026-08-08 and 2026-08-09 the operator's vault recorded 65 separate
// `aether-proxy-bind-failed` anomalies for 127.0.0.1:4480. Each one said
// "address already in use" three times over and named the holder zero times.
// The information needed to end the whole episode in one line — which process
// had the port — was never collected, so the failure recurred across 65
// processes with nothing to act on. A bind failure is the one error where the
// interesting fact is about a DIFFERENT process than the one reporting it.
//
// SHAPE COPIED FROM AN EXISTING PRECEDENT, not invented: `getListenerPid()` in
// scripts/verify-propose-goal.js (and a near-duplicate in
// verify-propose-goal-ui-click.js) already solved this for the verification
// scripts — Windows via `netstat -ano -p TCP`, LISTENING rows only, best-effort
// with an honest null. This is that shape, moved to src/ so the runtime can use
// it too, made async so it cannot block boot, and given a reason string so a
// failed lookup explains itself instead of returning a bare null.
//
// DELIBERATELY NOT DONE: the two scripts are left alone. Collapsing three copies
// into one is a refactor, and a refactor riding inside a fix is how a small
// change acquires a blast radius it did not need. Recorded here as owed rather
// than done, because a comment nobody reads is not a plan: the next person to
// touch either script should reach for this module.
//
// WINDOWS-ONLY, AND IT SAYS SO. `netstat -ano` output is parsed positionally and
// the format differs on other platforms (`ss -ltnp`, `lsof -i`). Rather than
// guess at a parse it cannot verify, this reports the platform as the reason it
// could not look. An honest "I could not determine this" is the point of the
// module; a plausible wrong pid would send the reader after an innocent process,
// which is worse than silence.

const child_process = require('node:child_process');
const util = require('node:util');

// A boot-path diagnostic that hangs is worse than no diagnostic. netstat on a
// busy host is tens of milliseconds; this is a ceiling, not a budget.
const LOOKUP_TIMEOUT_MS = 1500;

// Parse `netstat -ano -p TCP` output for the pid LISTENING on exactly `port`.
//
// Two things this gets right that a looser parse would not, both of them
// failure modes that name an INNOCENT process:
//   - exact port equality, never substring. '44801' contains '4480'; a substring
//     match reports the wrong pid with full confidence.
//   - LISTENING rows only. An ESTABLISHED connection on a port is not what
//     refuses a bind, and reporting its pid points at the client.
function parseNetstatForPort(text, port) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted)) return null;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // Proto, Local, Foreign, State, PID
    if (parts.length < 5) continue;
    if (parts[3] !== 'LISTENING') continue;
    // '127.0.0.1:4480' -> '4480'; '[::]:445' -> '445'. Taking the LAST
    // colon-separated field is what makes IPv6 bracket notation work without a
    // second code path.
    const portField = parts[1].split(':').pop();
    if (Number(portField) !== wanted) continue;
    const pid = Number(parts[4]);
    return Number.isInteger(pid) ? pid : null;
  }
  return null;
}

// Resolve a pid to an image name via tasklist's CSV output:
//   "node.exe","15616","Console","1","120,000 K"
// Best-effort by design. The pid is the load-bearing half of the answer, so a
// tasklist failure must not discard it — every caller here keeps the pid and
// drops only the name.
async function resolveProcessName(pid, execFile, timeoutMs) {
  try {
    const res = await execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
    });
    const out = String((res && res.stdout) || res || '');
    // THE QUOTE IS THE GUARD, and it is the only one needed.
    //
    // tasklist prints an INFO line rather than an error when its filter matches
    // nothing, AND EXITS 0 — so a caller that trusts the exit code puts "INFO: No
    // tasks are running which match the specified criteria." into a spoken
    // sentence. Verified on this machine rather than assumed:
    //
    //   > tasklist /FI "PID eq 999999" /FO CSV /NH
    //   INFO: No tasks are running which match the specified criteria.<CR>
    //   (exit 0)
    //
    // It is UNQUOTED, while every real CSV row starts with a quoted image name.
    // So requiring the leading quote already rejects it, on any Windows locale,
    // because the quoting is the invariant and the English word "INFO" is not.
    // An earlier draft also tested /^INFO:/i here; a mutation proved that check
    // could never fire, so it is gone rather than kept as reassurance.
    const m = out.match(/^\s*"([^"]+)"/);
    if (!m) return null;
    const name = m[1].trim();
    return name || null;
  } catch (_) {
    return null;
  }
}

// Returns { pid, name, reason }.
//   pid !== null  -> found it; `name` may still be null if tasklist failed.
//   pid === null  -> `reason` says WHY, and the three whys are different facts:
//                    the platform cannot be parsed, the lookup itself failed, or
//                    the lookup worked and found nothing. That last one is
//                    genuinely strange for a bind failure and must not be
//                    reported as if we simply could not look.
async function findPortHolder(port, deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  const timeoutMs = typeof d.timeoutMs === 'number' ? d.timeoutMs : LOOKUP_TIMEOUT_MS;
  const execFile = d.execFile || util.promisify(child_process.execFile);

  if (platform !== 'win32') {
    return {
      pid: null,
      name: null,
      reason: 'this platform (' + platform + ') is not one whose netstat output '
        + 'this build knows how to parse',
    };
  }

  let stdout;
  try {
    const res = await execFile('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
    });
    stdout = String((res && res.stdout) || res || '');
  } catch (err) {
    return {
      pid: null,
      name: null,
      reason: 'netstat could not be run (' + ((err && (err.code || err.message)) || 'unknown error') + ')',
    };
  }

  const pid = parseNetstatForPort(stdout, port);
  if (pid === null) {
    return {
      pid: null,
      name: null,
      reason: 'netstat ran but no process is LISTENING on that port',
    };
  }

  const name = await resolveProcessName(pid, execFile, timeoutMs);
  return { pid: pid, name: name, reason: null };
}

// The clause that gets appended to an operator-facing sentence. Always returns a
// non-empty string: "we did not look" and "we looked and could not tell" are
// both information, and going quiet is the defect this module was built to fix.
// Never emits the literal 'null'/'undefined'/'[object Object]' — the audit trail
// has been polluted by exactly those tokens before, more than once.
function describeHolder(holder) {
  const h = holder && typeof holder === 'object' ? holder : {};
  const pid = typeof h.pid === 'number' && Number.isInteger(h.pid) ? h.pid : null;
  if (pid !== null) {
    const name = typeof h.name === 'string' && h.name.trim() ? h.name.trim() : null;
    return name
      ? 'held by pid ' + pid + ' (' + name + ')'
      : 'held by pid ' + pid;
  }
  const reason = typeof h.reason === 'string' && h.reason.trim() ? h.reason.trim() : null;
  return reason
    ? 'could not determine what holds it: ' + reason
    : 'could not determine what holds it';
}

// Which port actually failed to bind, read out of the error text.
//
// The obvious source — scanner-proxy's own ports() — is not usable here:
// start()'s rejection handler calls closeAllServers() BEFORE the caller sees the
// error, so by the time the anomaly is built ports() is empty. That is exactly
// why the 2026-08-26 vault record says target "the Aether proxy port range"
// instead of a number. The message is the only place the failing port survives:
//
//   Aether scanner-proxy could not bind 127.0.0.1:4480 for node "phone":
//   listen EADDRINUSE: address already in use 127.0.0.1:4480
//
// Returns null rather than a guess when there is no port in the text, so a
// caller can fall back to the configured base and say which it used.
function portFromBindError(message) {
  const text = String(message == null ? '' : message);
  const m = /:(\d{2,5})(?!\d)/.exec(text);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

module.exports = {
  findPortHolder,
  describeHolder,
  parseNetstatForPort,
  portFromBindError,
  LOOKUP_TIMEOUT_MS,
};
