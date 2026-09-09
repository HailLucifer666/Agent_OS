'use strict';
// BUG-431: convenience refusal for the two measured close_window mistakes.
// A UI/CUA click on X bypasses this; offline announcement and setup capability
// facts close that class. Tier 3 and operator-present trust are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { remedy } = require('./evidence');
const cache = new WeakMap();
function readBrowserPid() {
  try { return fs.readFileSync(path.join(__dirname, '../../../.browser-agent.pid'), 'utf8').trim(); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function attachedBrowserRefusal(pid, agent, { readPid = readBrowserPid, now = Date.now } = {}) {
  const status = agent.getStatus();
  if (status.state !== 'ONLINE') return null;
  let attached = Number(readPid());
  if (!attached && status.cdpUrl) {
    let row = cache.get(agent);
    if (!row || row.url !== status.cdpUrl || now() >= row.until) {
      const url = new URL(status.cdpUrl);
      const found = agent.processOnPort(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
      row = { pid: found?.pid, url: status.cdpUrl, until: now() + 10000 }; cache.set(agent, row);
    }
    attached = row.pid;
  }
  if (!attached || Number(pid) !== Number(attached)) return null;
  return { ok: false, result: 'That window is the attached automation browser. Closing it would remove browser control. Use browser_switch to change browsers.',
    remedy: remedy('browser_switch', {}, 'Ask which browser the operator wants before calling this remedy.', ['browser']) };
}
function makeCloseWindow({ delegate, fail, implicitTarget, agent, readPid, now }) {
return async function close_window({ pid }) {
  if (!pid) return fail('PID is required.');
  const refusal = attachedBrowserRefusal(pid, agent || require('../../../adapters/browser-agent'), { readPid, now }); // Only close needs the browser adapter.
  if (refusal) return refusal;
  var res = await delegate({ cmd: 'close_window', pid });

  // BUG-103: the PowerShell handler used to return `@{closed=$false; note=…}` on
  // a graceful-close timeout — a hashtable, so the dispatcher recorded ok:true
  // for a window that was still open (the 2026-08-05 Brave incident). The
  // handler is honest now; this is the Node-side backstop, because a plain
  // `ok:true` on a world-changing action is exactly what the evidence contract
  // forbids (src/core/CLAUDE.md).
  if (res.ok && res.result && res.result.closed === false) {
    return fail(String(res.result.note || 'The window did not close and is still open.')
      + ' Nothing was closed — the window is still open.');
  }

  // A vanished pid is the other half of the same incident (Chrome had already
  // exited, or the pid was a non-windowed child of a multi-process browser).
  // Say what to do next instead of returning a bare PowerShell error.
  if (!res.ok && /cannot find/i.test(String(res.result || ''))) {
    return fail('That pid no longer exists, so nothing was closed. ' + String(res.result));
  }

  // AUDIT FIX: a closed pid must not linger as the ui_type/ui_click default —
  // Windows recycles PIDs, so a stale value could target an unrelated process.
  // Only on a REAL close: a failed close leaves the window (and the pid) valid.
  if (res.ok) implicitTarget.forgetIf(pid);
  return res;
}

}
module.exports = { attachedBrowserRefusal, makeCloseWindow };
