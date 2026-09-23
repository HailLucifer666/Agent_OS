'use strict';

// BUG-422 (2026-09-10): evidence only. IPC disconnect is not proof of death;
// exit owns restarting. A watchdog here would hide the unexplained outage.
const fs = require('node:fs');
const logFailureCounter = { count: 0, sidecarFailures: 0 };

function formatLogLine(args, stringify = JSON.stringify) {
  return new Date().toISOString() + ' ' + args.map((arg) =>
    typeof arg === 'string' ? arg : stringify(arg)).join(' ') + '\n';
}

function describeChildEvent(kind, code, signal, streamState) {
  return 'mythos child ' + kind + ': ' + JSON.stringify({
    code: code ?? null, signal: signal ?? null, stream: streamState,
  });
}

function livenessProbe(child) {
  const unreachable = Boolean(child && child.connected === false
    && child.exitCode === null && child.signalCode === null);
  return { unreachable, reason: unreachable ? 'child unreachable, no exit event seen' : null };
}

function recordLogFailure(file, error) {
  logFailureCounter.count++;
  const line = formatLogLine(['main.log write failed', {
    count: logFailureCounter.count, code: error && error.code || 'UNKNOWN',
  }]);
  try { fs.appendFileSync(file() + '.write-failures', line); }
  catch {
    logFailureCounter.sidecarFailures++;
    // ponytail: no recursive logger call when both destinations are unwritable.
    try { fs.writeSync(2, line); } catch { /* counters retain both failed writes */ }
  }
}

function observeChildLifecycle(child, stream, log, timers = { setInterval, clearInterval }) {
  const state = () => stream ? { destroyed: stream.destroyed, writableEnded: stream.writableEnded } : null;
  if (stream) stream.on('error', (err) => log('child log stream error: ' + (err.code || err.message)));
  child.on('close', (code, signal) => log(describeChildEvent('close', code, signal, state())));
  child.on('disconnect', () => log(describeChildEvent('disconnect', child.exitCode, child.signalCode, state())));
  const timer = timers.setInterval(() => {
    const probe = livenessProbe(child);
    if (probe.unreachable) log(probe.reason);
  }, 30000);
  timer.unref();
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; timers.clearInterval(timer); } };
  child.once('exit', stop);
  child.once('close', stop);
}

module.exports = { formatLogLine, describeChildEvent, livenessProbe, logFailureCounter, recordLogFailure, observeChildLifecycle };
