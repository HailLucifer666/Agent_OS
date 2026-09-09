'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPipeTransport } = require('./transport');
const HOST_NAME = 'com.mythos.browser_operator';
const OPERATIONS = new Set(['tabs', 'createTab', 'observe', 'videoList', 'playbackState', 'mediaState', 'selectTab', 'navigate', 'click', 'scroll', 'play', 'resume', 'pause', 'next', 'mediaControl']);
const READS = new Set(['tabs', 'observe', 'videoList', 'playbackState', 'mediaState']);
const fail = (code, error) => ({ ok: false, code, error });
const validId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);

// ---------------------------------------------------------------------------
// BUG-416 — the browser identity has to outlive the pipe (2026-09-09)
// ---------------------------------------------------------------------------
//
// TRACED THROUGH SOURCE, not reproduced live: the desktop operator is not set
// up on this checkout. Recorded that way so the next session does not read the
// refusal as a new defect.
//
// `hello` used to mint `randomUUID()` for every connection. The desktop
// controller persists its target -- `save(id, { target })` in
// src/core/desktop/controller.js -- and on resume calls `browser_video_list`
// with the browserId inside it. After a backend restart the bridge looks that
// id up among live clients, does not find it, and answers BROWSER_REQUIRED,
// "Choose an observed connected browser". `observe()` retries three times and
// blocks with that reason.
//
// So the reconnection shipped in 8afc989 restores the PIPE and can never
// restore the TASK, and the failure names the wrong cause -- which is the part
// most likely to cost a session, because the operator is told to choose a
// browser that is already connected.
//
// WHY NO TEST SAW IT (/kee class 3, the friendly fixture). Every controller rig
// returns a fixed `browserId: 'b'` or `'brave'` and never checks the one it is
// handed, so every resume test passes AROUND the bridge rather than through it.
// The fixture was more generous than the wire. Fixing the bridge without
// fixing the rigs would have left the guard untested a second time, so the rigs
// now refuse an id they never issued.
//
// THE DESIGN, chosen by the operator 2026-09-09. The extension persists an
// instance id in `chrome.storage.local` and sends it in `hello` behind a
// protocol bump; the bridge requires it to be UUID-shaped, adopts it as the
// browserId, and refuses a SECOND live client claiming the same one.
//
// Why refuse rather than replace: a duplicate can only be a cloned profile or a
// second extension copy, and silently handing it the running session's identity
// would let it inherit task ownership and observations. Refusing is also
// self-healing for the reconnect race -- the extension's own backoff retries
// after the stale client is reaped -- while a real clone simply never connects
// and is visible on the bus rather than mysterious.
//
// PROTOCOL 1 IS REFUSED, DELIBERATELY. The extension lives in this repo and
// ships with the bridge, so there is no third-party client to keep working, and
// an old extension silently falling back to random identities would rebuild the
// exact bug behind a version number. It is refused loudly, on the bus, naming
// the reload.
const PROTOCOL = 2;
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createBrowserExtensionBridge({ runtimeDir, allowedExtensionIds = [], bus, logger = {}, transportFactory = createPipeTransport, requestTimeoutMs = 15000, pipeName = 'mythos-browser-' + randomUUID() }) {
  if (!path.isAbsolute(runtimeDir || '')) throw new Error('An absolute project/runtime directory is required');
  const clients = new Map(), pending = new Map(), observations = new Map(), cancelled = new Set(), taskSignals = new Map(), taskOwners = new Map();
  let transport, started = false, security = null;
  const key = (taskId, target) => JSON.stringify([taskId, target.browserId, target.tabId, target.frameId]);
  function emit(kind, fields = {}) { bus?.emit('browser.extension.' + kind, fields); }
  function invalidate(taskId, reason) {
    for (const [k, value] of observations) if (value.taskId === taskId) observations.delete(k);
    for (const p of pending.values()) if (p.taskId === taskId) p.finish(fail('INVALIDATED', reason));
    for (const [k, owner] of taskOwners) if (owner === taskId) taskOwners.delete(k);
  }
  function disconnect(clientId) {
    const client = clients.get(clientId); clients.delete(clientId);
    if (!client) return;
    for (const k of taskOwners.keys()) if (k.startsWith(client.browserId + ':')) taskOwners.delete(k);
    for (const [k, value] of observations) if (value.target.browserId === client.browserId) observations.delete(k);
    for (const p of pending.values()) if (p.clientId === clientId) p.finish(fail('DETACHED', 'Browser extension disconnected'));
    emit('detached', { browserId: client.browserId });
  }
  function receive(clientId, message) {
    if (!message || typeof message !== 'object') return transport.close(clientId);
    if (message.type === 'hello') {
      if (clients.has(clientId) || !allowedExtensionIds.includes(message.extensionId)) return transport.close(clientId);
      // BUG-416. Each refusal names itself on the bus: a closed pipe with no
      // reason is indistinguishable from a crash, and the extension retries on
      // its own backoff, so a silent refusal would loop invisibly forever.
      if (message.protocol !== PROTOCOL) {
        emit('protocol-mismatch', { extensionId: message.extensionId, got: message.protocol ?? null, want: PROTOCOL });
        return transport.close(clientId);
      }
      const browserId = typeof message.instanceId === 'string' ? message.instanceId : '';
      if (!UUID_SHAPED.test(browserId)) {
        emit('identity-invalid', { extensionId: message.extensionId, instanceId: browserId.slice(0, 64) });
        return transport.close(clientId);
      }
      for (const other of clients.values()) {
        if (other.browserId !== browserId) continue;
        // The FIRST client keeps the session untouched — it may be mid-task. The
        // newcomer is closed and will retry, which is what makes this safe for
        // the reconnect race and visible for a real clone.
        emit('collision', { browserId, extensionId: message.extensionId });
        return transport.close(clientId);
      }
      clients.set(clientId, { browserId, extensionId: message.extensionId, browserName: ['brave', 'chrome'].includes(message.browserName) ? message.browserName : 'chromium' });
      transport.send(clientId, { type: 'welcome', browserId, protocol: PROTOCOL }); emit('connected', { browserId }); return;
    }
    const client = clients.get(clientId); if (!client) return transport.close(clientId);
    if (message.type === 'user-takeover' && typeof message.taskId === 'string' && Number.isInteger(message.tabId) && ['pointerdown', 'keydown', 'wheel'].includes(message.inputType)) {
      if (taskOwners.get(client.browserId + ':' + message.tabId) !== message.taskId) return;
      cancelled.add(message.taskId); invalidate(message.taskId, 'User took control of browser tab');
      emit('user-takeover', { taskId: message.taskId, browserId: client.browserId, tabId: message.tabId, inputType: message.inputType }); return;
    }
    if (message.type === 'invalidated') {
      for (const [k, value] of observations) if (value.target.browserId === client.browserId && value.target.tabId === message.tabId) observations.delete(k);
      emit('invalidated', { browserId: client.browserId, tabId: message.tabId, reason: String(message.reason || 'document changed').slice(0, 120) }); return;
    }
    const p = pending.get(message.id);
    if (!p || p.clientId !== clientId || p.taskId !== message.taskId) return;
    if (message.ok !== true) { p.finish(fail(String(message.code || 'BROWSER_ERROR'), String(message.error || 'Browser operation failed'))); return; }
    const result = message.result;
    if (p.operation === 'tabs') {
      if (!Array.isArray(result?.tabs)) return p.finish(fail('INVALID_RESPONSE', 'Missing tab list'));
      result.tabs = result.tabs.filter(t => Number.isInteger(t.tabId)).map(t => ({ ...t, browserId: client.browserId, frameId: 0, browserName: client.browserName }));
    } else if (p.operation === 'observe' || p.operation === 'videoList') {
      const target = result?.target;
      if (!target || target.browserId !== client.browserId || target.tabId !== p.target.tabId || target.frameId !== 0 || typeof target.observationId !== 'string' || !Number.isInteger(target.generation) || typeof target.documentId !== 'string') {
        return p.finish(fail('INVALID_RESPONSE', 'Observation target did not match request'));
      }
      observations.set(key(p.taskId, target), { taskId: p.taskId, target });
      taskOwners.set(client.browserId + ':' + target.tabId, p.taskId);
    }
    p.finish({ ok: true, result });
  }
  async function start() {
    if (started) return getStatus();
    if (!allowedExtensionIds.length || allowedExtensionIds.some(id => !validId(id))) throw new Error('Explicit valid allowedExtensionIds are required');
    fs.mkdirSync(runtimeDir, { recursive: true });
    transport = transportFactory({ runtimeDir, pipeName });
    transport.on('message', receive); transport.on('disconnected', disconnect);
    transport.on('stopped', () => { started = false; for (const id of clients.keys()) disconnect(id); });
    security = await transport.start();
    started = true;
    fs.writeFileSync(path.join(runtimeDir, 'browser-extension-host.json'), JSON.stringify({ protocol: 1, pipeName, allowedExtensionIds }, null, 2));
    return getStatus();
  }
  async function stop() {
    started = false; for (const id of clients.keys()) disconnect(id);
    if (transport) await transport.stop(); observations.clear(); cancelled.clear();
    for (const release of taskSignals.values()) release(); taskSignals.clear();
  }
  function getStatus() { return { state: !started ? 'OFFLINE' : clients.size ? 'ONLINE' : 'WAITING_FOR_EXTENSION', browsers: [...clients.values()], security: security ? { sid: security.sid, sddl: security.sddl } : null }; }
  function request(clientId, operation, args, taskId, signal) {
    return new Promise(resolve => {
      const id = randomUUID(); let timer;
      const finish = result => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); resolve(result); };
      const abort = () => {
        cancelled.add(taskId); invalidate(taskId, 'Task cancelled');
        try { transport.send(clientId, { type: 'cancel', taskId }); } catch { /* disconnection already invalidates */ }
      };
      pending.set(id, { clientId, taskId, operation, target: args.target || args, finish });
      timer = setTimeout(() => { finish(fail('TIMEOUT', 'Browser operation timed out; observe again before acting')); invalidate(taskId, 'Operation timed out'); try { transport.send(clientId, { type: 'cancel', taskId }); } catch {} }, requestTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { transport.send(clientId, { type: 'command', id, taskId, operation, args }); }
      catch (err) { finish(fail('OFFLINE', err.message)); }
    });
  }
  async function execute(operation, args = {}, { signal, taskId } = {}) {
    if (!started) return fail('OFFLINE', 'Start the browser extension bridge first');
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 160) return fail('TASK_REQUIRED', 'A bounded taskId is required');
    if (signal?.aborted || cancelled.has(taskId)) return fail('CANCELLED', 'Task has been cancelled');
    if (signal && !taskSignals.has(taskId)) {
      const abortTask = () => {
        cancelled.add(taskId); invalidate(taskId, 'Task cancelled');
        for (const id of clients.keys()) { try { transport.send(id, { type: 'cancel', taskId }); } catch {} }
        taskSignals.delete(taskId);
      };
      signal.addEventListener('abort', abortTask, { once: true });
      taskSignals.set(taskId, () => signal.removeEventListener('abort', abortTask));
    }
    if (!OPERATIONS.has(operation)) return fail('UNSUPPORTED', 'Unsupported browser operation');
    // No authenticated extension is a missing prerequisite, not an empty page and
    // not a wrong browser choice. This guard first covered `tabs` alone, because
    // that was the operation whose empty-but-ok answer was observed; the reason it
    // was written -- "nothing is connected" is a different fact from anything the
    // caller passed -- was never about `tabs`. Every other operation fell through
    // to BROWSER_REQUIRED ("choose an observed connected browser"), which tells the
    // operator to pick among zero browsers instead of to reconnect the extension.
    if (!clients.size) return fail('EXTENSION_DISCONNECTED', 'MYTHOS Browser Operator is disconnected. Open the extension in the intended browser to reconnect.');
    if (operation === 'tabs') {
      const results = await Promise.all([...clients.keys()].map(id => request(id, operation, {}, taskId, signal)));
      if (results.some(r => !r.ok)) return results.find(r => !r.ok);
      return { ok: true, result: { tabs: results.flatMap(r => r.result.tabs) } };
    }
    const target = args.target || args;
    const pair = [...clients].find(([, c]) => c.browserId === target.browserId);
    if (!pair) return fail('BROWSER_REQUIRED', 'Choose an observed connected browser; no profile or browser switch is automatic');
    if (operation === 'createTab') return request(pair[0], operation, { browserId: target.browserId, url: args.url }, taskId, signal);
    if (!Number.isInteger(target.tabId) || target.frameId !== 0) return fail('TARGET_REQUIRED', 'An explicit tabId and top-level frameId:0 are required; nested frames are not supported');
    if (!['observe', 'videoList'].includes(operation)) {
      const current = observations.get(key(taskId, target))?.target;
      if (!current || ['observationId', 'generation', 'documentId', 'url'].some(k => current[k] !== target[k])) return fail('STALE_OBSERVATION', 'Observe this task/browser/tab/document again before acting');
      if (!READS.has(operation)) observations.delete(key(taskId, target));
    }
    return request(pair[0], operation, { ...args, target }, taskId, signal);
  }
  // Only trusted backend task control may resume. It waits for debugger detach
  // completion; re-observation is still required and old capsules remain invalid.
  async function resumeTask(taskId) {
    invalidate(taskId, 'Task resumed; fresh observation required');
    taskSignals.get(taskId)?.(); taskSignals.delete(taskId);
    const replies = await Promise.all([...clients.keys()].map(id => request(id, 'resumeTask', {}, taskId)));
    if (replies.some(r => !r.ok)) return replies.find(r => !r.ok);
    cancelled.delete(taskId); return { ok: true };
  }
  return { start, stop, getStatus, execute, resumeTask, beginTask: resumeTask };
}
module.exports = { createBrowserExtensionBridge, HOST_NAME, validId };
