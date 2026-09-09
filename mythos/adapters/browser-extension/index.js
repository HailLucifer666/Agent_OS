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
      const browserId = randomUUID();
      clients.set(clientId, { browserId, extensionId: message.extensionId, browserName: ['brave', 'chrome'].includes(message.browserName) ? message.browserName : 'chromium' });
      transport.send(clientId, { type: 'welcome', browserId, protocol: 1 }); emit('connected', { browserId }); return;
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
    if (operation === 'tabs') {
      // No authenticated extension is a missing prerequisite, not an empty page.
      if (!clients.size) return fail('EXTENSION_DISCONNECTED', 'MYTHOS Browser Operator is disconnected. Open the extension in the intended browser to reconnect.');
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
