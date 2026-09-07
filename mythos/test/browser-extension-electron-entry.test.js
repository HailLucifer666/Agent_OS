'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createBrowserExtensionBridge } = require('../adapters/browser-extension');
const { encodeNativeMessage, createNativeDecoder } = require('./fixtures/browser-native-protocol');
const root = path.resolve(__dirname, '../..');

test('compiled console native host exchanges bounded frames over restricted pipe and exits on EOF', { timeout: 25000 }, async t => {
  if (process.platform !== 'win32') { assert.throws(() => require('../scripts/build-browser-native-host').buildBrowserNativeHost(), /Windows/); return; }
  fs.mkdirSync(path.join(root, '.cache/windows-operator'), { recursive: true });
  const run = fs.mkdtempSync(path.join(root, '.cache/windows-operator/entry-'));
  const extensionId = 'a'.repeat(32), frames = [], stderr = [];
  const bridge = createBrowserExtensionBridge({ runtimeDir: run, allowedExtensionIds: [extensionId] });
  let child;
  t.after(async () => { if (child && child.exitCode === null) child.kill(); await bridge.stop(); });
  await bridge.start();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|windir|COMSPEC|PATHEXT|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  Object.assign(env, { TEMP: run, TMP: run, HOME: run, USERPROFILE: run, APPDATA: run, LOCALAPPDATA: run, MYTHOS_BROWSER_EXTENSION_RUNTIME_DIR: run });
  const exe = require('../scripts/build-browser-native-host').buildBrowserNativeHost(path.join(run, 'build'));
  child = spawn(exe, [`chrome-extension://${extensionId}/`], { cwd: run, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  let welcome;
  const ready = new Promise(resolve => { welcome = resolve; });
  const decode = createNativeDecoder(message => {
    frames.push(message);
    if (message.type === 'welcome') welcome();
    if (message.type === 'command') child.stdin.write(encodeNativeMessage({ id: message.id, taskId: message.taskId, ok: true, result: { tabs: [{ tabId: 42, url: 'https://www.youtube.com/', active: true }] } }));
  });
  child.stdout.on('data', chunk => { fs.appendFileSync(path.join(run,'stdout.bin'), chunk); decode(chunk); }); child.stderr.on('data', chunk => stderr.push(String(chunk)));
  child.stdin.write(encodeNativeMessage({ type: 'hello', protocol: 1, extensionId, browserName: 'brave' }));
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Native entry handshake timed out: ' + stderr.join(''))), 10000).unref())]);
  const result = await bridge.execute('tabs', {}, { taskId: 'entry-proof' });
  assert.equal(result.ok, true); assert.equal(result.result.tabs[0].tabId, 42);
  child.stdin.end();
  const exit = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Native host remained alive after stdin EOF')), 2500).unref())]);
  assert.equal(exit[0], 0, stderr.join(''));
  assert.ok(frames.some(frame => frame.type === 'welcome'));
  assert.equal(fs.existsSync(path.join(run, 'logs', 'main.log')), false, 'GUI logging must not start');
});

test('compiled host rejects unauthorized origin and malformed native frames without stdout payload', { timeout: 25000 }, async t => {
  if (process.platform !== 'win32') return;
  fs.mkdirSync(path.join(root, '.cache/windows-operator'), { recursive: true });
  const run = fs.mkdtempSync(path.join(root, '.cache/windows-operator/entry-invalid-'));
  const extensionId = 'a'.repeat(32), bridge = createBrowserExtensionBridge({ runtimeDir: run, allowedExtensionIds: [extensionId] });
  t.after(() => bridge.stop()); await bridge.start();
  const exe = require('../scripts/build-browser-native-host').buildBrowserNativeHost(path.join(run, 'build'));
  for (const [origin, frame, reason] of [
    ['chrome-extension://' + 'b'.repeat(32) + '/', Buffer.alloc(0), /not allowed/],
    ['https://untrusted.test/', Buffer.alloc(0), /origin/],
    ['chrome-extension://' + extensionId + '/', Buffer.from([255,255,255,255]), /size/],
    ['chrome-extension://' + extensionId + '/', Buffer.from([20,0]), /Truncated/],
    ['chrome-extension://' + extensionId + '/', encodeNativeMessage({ type: 'hello', extensionId, protocol: 2 }), /handshake/],
  ]) {
    const child = spawn(exe, [origin], { cwd: run, windowsHide: true, env: { ...process.env, TEMP: run, TMP: run, MYTHOS_BROWSER_EXTENSION_RUNTIME_DIR: run }, stdio: ['pipe','pipe','pipe'] });
    let output = '', errors = ''; child.stdout.on('data', data => { output += data.toString('hex'); }); child.stderr.on('data', data => { errors += String(data); });
    child.stdin.on('error', () => {}); child.stdin.end(frame);
    const [code] = await once(child, 'close'); assert.equal(code, 1); assert.equal(output, ''); assert.match(errors, reason);
  }
});
