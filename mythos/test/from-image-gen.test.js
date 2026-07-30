'use strict';

// test/from-image-gen.test.js — §7.10 image generation: generate_image.
// Mocks global.fetch against the real Gemini generateContent request/response
// shape verified live 2026-07-30 (see from-image-gen.js header comment for the
// citation). No real network needed for this suite — see the session's
// live-verification transcript for the real-network proof (and its honest
// free-tier-quota failure mode, also asserted here).

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools, registerFromImageGen } = require('../src/core/effectors/from-image-gen');
const { createEffectorHub } = require('../src/core/effectors/hub');

// Smallest valid PNG (1x1 transparent pixel) — same fixture used by
// test/capture-screenshot.test.js.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function tempVault() {
  const dir = path.join(os.tmpdir(), 'mythos-imagegen-' + require('crypto').randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function fakeBus() { const e = []; return { emit: (t, p) => e.push({ type: t, payload: p }), _emitted: () => e, subscribe: () => {} }; }

describe('from-image-gen — generate_image', () => {
  let dir, vault, tools;
  const realFetch = global.fetch;
  const realKey = process.env.GOOGLE_API_KEY;

  before(() => { dir = tempVault(); vault = createFsStore(() => dir, null); });
  after(() => { cleanup(dir); });
  beforeEach(() => { process.env.GOOGLE_API_KEY = 'test-key-123'; tools = buildTools({ vault }); });
  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = realKey;
  });

  function fn(name) { return tools.find((t) => t.name === name).fn; }

  it('registers generate_image (T2-shaped, non-danger)', () => {
    const t = tools.find((t) => t.name === 'generate_image');
    assert.ok(t);
    assert.equal(t.danger, false);
  });

  it('decodes a real inlineData image and saves it as a valid PNG under builds/images/', async () => {
    global.fetch = async (url, opts) => {
      assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent\?key=test-key-123/);
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
      assert.match(body.contents[0].parts[0].text, /banana/);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }] } }],
        }),
      };
    };
    const result = await fn('generate_image')({ prompt: 'a simple banana on a table', title: 'My Banana' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.format, 'png');
    assert.ok(result.result.bytes > 0);
    assert.ok(result.result.savedTo.split(path.sep).indexOf('images') !== -1);

    const abs = vault.vaultPath(result.result.savedTo);
    const buf = fs.readFileSync(abs);
    assert.equal(buf.length, result.result.bytes);
    // PNG magic bytes: 89 50 4E 47
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x4e);
    assert.equal(buf[3], 0x47);
  });

  it('degrades honestly when GOOGLE_API_KEY is unset, without calling fetch', async () => {
    delete process.env.GOOGLE_API_KEY;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const result = await fn('generate_image')({ prompt: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.result, /GOOGLE_API_KEY/);
    assert.equal(called, false);
  });

  it('degrades honestly when the model returns no image data (text-only response)', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] } }] }),
    });
    const result = await fn('generate_image')({ prompt: 'something refused' });
    assert.equal(result.ok, false);
    assert.match(result.result, /no image/i);
  });

  it('degrades honestly on a non-ok HTTP response (e.g. quota exhausted), surfacing the real reason', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests' } }),
    });
    const result = await fn('generate_image')({ prompt: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.result, /429|[Qq]uota/);
  });

  it('degrades honestly on a network failure instead of throwing', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const result = await fn('generate_image')({ prompt: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.result, /network down/);
  });

  it('rejects an empty prompt without calling fetch', async () => {
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const result = await fn('generate_image')({ prompt: '   ' });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  it('sanitizes a path-traversal title so the file never escapes builds/images/', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }] } }],
      }),
    });
    const result = await fn('generate_image')({ prompt: 'x', title: '../../etc/passwd' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.result.savedTo.indexOf('..') === -1, 'no parent-dir segment: ' + result.result.savedTo);
    assert.ok(result.result.savedTo.split(path.sep).indexOf('images') !== -1);
    const abs = vault.vaultPath(result.result.savedTo);
    assert.ok(abs.startsWith(dir), 'resolved path must stay inside vault root');
  });

  it('registers via registerFromImageGen and appears in the hub catalog', () => {
    const hub = createEffectorHub({ bus: fakeBus(), config: {} });
    const count = registerFromImageGen(hub, { vault });
    assert.equal(count, 1);
    const names = hub.catalog().map((t) => t.name);
    assert.ok(names.indexOf('generate_image') !== -1);
  });
});
