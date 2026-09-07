'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { snapshot, createExtensionEngine } = require('../browser-extension/engine');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const executablePath = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe')).find(fs.existsSync);
const card = (id, text) => `<ytd-video-renderer><a href="/watch?v=${id}" aria-label="thumbnail ${text}">thumbnail</a><a id="video-title" href="/watch?v=${id}">${text}</a></ytd-video-renderer>`;
const styles = '<style>ytd-search,ytd-video-renderer,ytd-ad-slot-renderer{display:block} a{display:inline-block;padding:4px}</style>';
test('actual DOM ordinal excludes unrelated anchors, sponsored cards, Shorts and duplicate video links', { skip: !executablePath }, async t => {
  const dir = tempVaultDir(); const browser = await chromium.launchPersistentContext(dir, { executablePath, headless: true, env: { ...process.env, TEMP: dir, TMP: dir } });
  t.after(async () => { await browser.close(); cleanupVaultDir(dir); });
  const page = await browser.newPage();
  const html = styles + '<nav><a href="/watch?v=navigation1">Navigation video</a></nav><ytd-search>'
    + '<ytd-ad-slot-renderer>' + card('sponsored01', 'Sponsored') + '</ytd-ad-slot-renderer>'
    + '<ytd-video-renderer><a id="video-title" href="/shorts/short000001">Shorts</a></ytd-video-renderer>'
    + card('first000001', 'First result') + card('second00001', 'Second result') + card('third000001', 'Third result') + '</ytd-search>';
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://www.youtube.com/results?search_query=fixture');
  const result = await page.evaluate(snapshot, 'observation');
  assert.deepEqual(result.items.map(x => x.title), ['First result', 'Second result', 'Third result']);
  assert.equal(result.items[2].videoId, 'third000001'); assert.equal(result.ambiguous, false);
  await page.evaluate(() => document.body.appendChild(document.querySelector('ytd-search').cloneNode(true)));
  const ambiguous = await page.evaluate(snapshot, 'replacement');
  assert.equal(ambiguous.ambiguous, true); assert.deepEqual(ambiguous.items, []);
});
test('real CDP isolated-world click selects observed third; synthetic input is ignored and trusted input cancels', { skip: !executablePath }, async t => {
  const dir = tempVaultDir(); const browser = await chromium.launchPersistentContext(dir, { executablePath, headless: true, env: { ...process.env, TEMP: dir, TMP: dir } });
  t.after(async () => { await browser.close(); cleanupVaultDir(dir); });
  const page = await browser.newPage();
  const html = styles + '<button id="takeover">User control</button><ytd-search>' + card('first000001', 'First result') + card('second00001', 'Second result') + card('third000001', 'Third result') + '</ytd-search>';
  await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://www.youtube.com/results?search_query=fixture');
  const session = await browser.newCDPSession(page), notifications = [];
  const chrome = {
    tabs: { onRemoved: { addListener() {} }, get: async () => ({ url: page.url() }) },
    debugger: { attach: async () => {}, detach: async () => session.detach(),
      sendCommand: (_target, method, args) => session.send(method, args), onDetach: { addListener() {} },
      onEvent: { addListener(fn) { for (const method of ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Runtime.bindingCalled']) session.on(method, args => fn({ tabId: 1 }, method, args)); } },
    },
  };
  const engine = createExtensionEngine(chrome, { notify: event => notifications.push(event), uuid: () => require('node:crypto').randomUUID() }); engine.welcome('fixture-browser');
  const target = { browserId: 'fixture-browser', tabId: 1, frameId: 0 };
  const observation = await engine.execute('observe', target, 'task');
  assert.equal(observation.items[2].title, 'Third result');
  const delivered = await engine.execute('click', { target: observation.target, ref: observation.items[2].ref }, 'task');
  assert.equal(delivered.commandAccepted, true);
  await page.waitForURL('**/watch?v=third000001');
  await engine.execute('observe', target, 'task');
  await page.evaluate(() => document.querySelector('#takeover').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(notifications.some(x => x.type === 'user-takeover'), false);
  await page.click('#takeover');
  for (let count = 0; count < 100 && !notifications.some(x => x.type === 'user-takeover'); count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(notifications.some(x => x.type === 'user-takeover' && x.taskId === 'task'));
  await assert.rejects(engine.execute('observe', target, 'task'), /cancelled/);
});
