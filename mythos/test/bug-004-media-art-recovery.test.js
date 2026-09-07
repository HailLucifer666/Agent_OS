'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const failure of ['offline', 'throw']) test('same-track art returns after ' + failure + ' without image churn on healthy polls', async () => {
  const nodes = new Map();
  const node = () => ({ innerHTML: '', dataset: {}, style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, querySelector(selector) { return selector === 'img' && this.innerHTML.includes('<img') ? {} : null; } });
  const root = { innerHTML: '', querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); } };
  let tick, broken = false;
  const context = { setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, Date,
    fetch: async () => {
      if (broken && failure === 'throw') throw Error('temporary network failure');
      return { ok: true, json: async () => broken ? { ok: false } : { ok: true, media: { art: true, title: 'Same track', artist: 'Artist' } } };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../ui/public/js/widgets/kinds/media.js'), 'utf8');
  vm.runInNewContext(source.replace(/export function /g, 'function '), context);
  const stop = context.mountMedia(root);
  await new Promise(resolve => setImmediate(resolve));
  const art = nodes.get('[data-role="media-art"]');
  assert.ok(art.querySelector('img'));
  const healthy = art.innerHTML;
  await tick();
  assert.equal(art.innerHTML, healthy, 'healthy same-track polling keeps the existing image');
  broken = true; await tick(); assert.equal(art.querySelector('img'), null);
  broken = false; await tick(); assert.ok(art.querySelector('img'), 'successful same-track recovery must restore cleared art');
  stop();
});
