'use strict';
importScripts('engine.js');
let active = null, cleanup = null, retryTimer = null, retryMs = 500;
const engine = MythosBrowserEngine.createExtensionEngine(chrome, { notify: message => {
  if (active) send(active, message);
} });

function scheduleReconnect() {
  if (active || cleanup || retryTimer !== null) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryMs);
  // Chrome may stop an idle MV3 worker after 30 seconds. Retry the native API
  // before that boundary so backoff does not race worker termination.
  retryMs = Math.min(retryMs * 2, 20000);
}

function disconnected(session) {
  if (active !== session) return;
  active = null;
  // Revoke in-flight task ownership now. Wait for its callbacks and debugger
  // cleanup before welcoming another connection into the same engine. A late
  // detach must never clear the new browser identity or its observations.
  const cancellations = [...new Set(session.pending.values())].map(taskId => engine.cancel(taskId));
  cleanup = (async () => {
    await Promise.all(cancellations);
    await Promise.allSettled([...session.pending.keys()]);
    await engine.disconnect();
    cleanup = null;
    scheduleReconnect();
  })().catch(error => {
    // Failed cleanup leaves reconnect blocked; reusing uncertain ownership is
    // unsafe. Reloading the extension creates a fresh engine instead.
    console.warn('MYTHOS browser cleanup failed; reload the extension.', error);
  });
}

function send(session, message) {
  if (active !== session) return;
  try { session.port.postMessage(message); }
  catch {
    disconnected(session);
    try { session.port.disconnect(); } catch { /* already disconnected */ }
  }
}

// BUG-416: the identity this browser keeps across reconnects, and across a
// backend restart. Before this the BRIDGE minted a fresh UUID on every hello,
// so a desktop task that had persisted its target could never be resumed — the
// bridge answered BROWSER_REQUIRED for an id it had itself invalidated by
// reconnecting. chrome.storage.local survives worker termination, extension
// updates and browser restarts, which is exactly the lifetime a browser
// identity needs; a value held in a module variable would not survive the
// 30-second MV3 worker idle stop that scheduleReconnect above already works
// around.
const INSTANCE_KEY = 'mythosInstanceId';
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let instanceId = null;

async function ensureInstanceId() {
  if (instanceId) return instanceId;
  let stored = null;
  try { stored = await chrome.storage.local.get(INSTANCE_KEY); } catch { stored = null; }
  const existing = stored && stored[INSTANCE_KEY];
  if (typeof existing === 'string' && UUID_SHAPED.test(existing)) { instanceId = existing; return instanceId; }
  // A missing or corrupt value is replaced rather than repaired: the bridge
  // refuses anything that is not UUID-shaped, so keeping a bad one would only
  // produce a silent reconnect loop.
  const fresh = crypto.randomUUID();
  try { await chrome.storage.local.set({ [INSTANCE_KEY]: fresh }); } catch { /* in-memory for this session */ }
  instanceId = fresh;
  return instanceId;
}

function connect() {
  if (active || cleanup) return;
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  // Resolve the identity BEFORE opening the port, so hello can carry it without
  // a second round trip and without a window where `active` is set but
  // unidentified. The guard is re-checked inside because this now awaits.
  ensureInstanceId().then(openPort).catch(scheduleReconnect);
}

function openPort() {
  if (active || cleanup) return;
  let port;
  try { port = chrome.runtime.connectNative('com.mythos.browser_operator'); }
  catch { scheduleReconnect(); return; }
  const session = { port, pending: new Map() };
  active = session;
  port.onMessage.addListener(message => {
    // Bind callbacks and replies to this port generation, never a mutable port
    // global. Old completions cannot acknowledge work to a replacement backend.
    if (active !== session || !message || typeof message !== 'object') return;
    if (message.type === 'welcome') { engine.welcome(message.browserId); retryMs = 500; return; }
    if (message.type !== 'cancel' && message.type !== 'command') return;
    const pending = (async () => {
      if (message.type === 'cancel') { await engine.cancel(message.taskId); return; }
      try {
        const result = await engine.execute(message.operation, message.args || {}, message.taskId);
        send(session, { id: message.id, taskId: message.taskId, ok: true, result });
      } catch (err) {
        send(session, { id: message.id, taskId: message.taskId, ok: false, code: 'BROWSER_REFUSED', error: String(err.message || err).slice(0, 1000) });
      }
    })();
    session.pending.set(pending, message.taskId);
    pending.catch(() => disconnected(session)).finally(() => session.pending.delete(pending));
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; disconnected(session); });
  send(session, { type: 'hello', protocol: 2, instanceId, extensionId: chrome.runtime.id, browserName: typeof navigator.brave !== 'undefined' ? 'brave' : 'chrome' });
}
chrome.action.onClicked.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
