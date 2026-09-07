'use strict';
importScripts('engine.js');
let port = null;
const engine = MythosBrowserEngine.createExtensionEngine(chrome, { notify: message => { try { port?.postMessage(message); } catch {} } });
function connect() {
  if (port) return;
  port = chrome.runtime.connectNative('com.mythos.browser_operator');
  port.onMessage.addListener(async message => {
    if (message.type === 'welcome') { engine.welcome(message.browserId); return; }
    if (message.type === 'cancel') { await engine.cancel(message.taskId); return; }
    if (message.type !== 'command') return;
    try {
      const result = await engine.execute(message.operation, message.args || {}, message.taskId);
      port?.postMessage({ id: message.id, taskId: message.taskId, ok: true, result });
    } catch (err) {
      port?.postMessage({ id: message.id, taskId: message.taskId, ok: false, code: 'BROWSER_REFUSED', error: String(err.message || err).slice(0, 1000) });
    }
  });
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = null; void engine.disconnect(); });
  port.postMessage({ type: 'hello', protocol: 1, extensionId: chrome.runtime.id, browserName: typeof navigator.brave !== 'undefined' ? 'brave' : 'chrome' });
}
chrome.action.onClicked.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
