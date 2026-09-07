'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(toolsObj, name) {
  const tools = toolsObj.TOOLS || toolsObj;
  return tools.find((t) => t.name === name).fn;
}

// This test declared `realFetch` and restored it in afterEach from the day it was
// written, but never actually stubbed it — so `open_web({type:'youtube'})` ran a
// LIVE DuckDuckGo search plus a live YouTube oembed call on every run. That made it
// flaky against the real network (1-3 of its 4 subtests failing, varying per run,
// ~2-3s each) and, because `.githooks/pre-commit` hard-blocks on any failure, it
// intermittently blocked every commit in the repo. Reproduced on a clean HEAD
// 2026-07-30 before touching it, so this is a pre-existing defect, not a
// regression. The stub below is what the original scaffolding intended: it makes
// the test hermetic WITHOUT weakening a single assertion — every widgetType /
// embedUrl / videoId / title check still runs, and they now test the YOUTUBE_MODE
// branching logic this file is named for instead of testing whether the network is
// up. Any URL the stub does not recognise throws, so a new live call added here
// fails loudly rather than silently reintroducing the flake.
const STUB_VIDEO_ID = 'dQw4w9WgXcQ'; // 11 chars — matches the extractor's regex
const STUB_TITLE = 'Stub Video Title';

function stubSearchHtml() {
  return '<div class="result">' +
    '<a class="result__a" href="https://www.youtube.com/watch?v=' + STUB_VIDEO_ID + '">' +
    STUB_TITLE + '</a>' +
    '<a class="result__snippet">A stubbed search snippet.</a>' +
    '</div>';
}

function makeFetchStub() {
  return async function fetchStub(url) {
    const u = String(url);
    if (u.includes('duckduckgo.com')) {
      return { ok: true, status: 200, text: async () => stubSearchHtml() };
    }
    if (u.includes('youtube.com/oembed')) {
      return { ok: true, status: 200, json: async () => ({ title: STUB_TITLE }) };
    }
    // Every other provider in the web_search fallback chain (Exa, Exa MCP, Jina,
    // Wikipedia) swallows a rejection and resolves [], so throwing here makes the
    // chain fall through to the stubbed DDG result deterministically.
    throw new Error('unstubbed network call in bug-006 test: ' + u);
  };
}

describe('BUG-006: YouTube embed mode configuration', () => {
  let ctx;
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = makeFetchStub();
    ctx = {
      // `bus: {}` (the original) is a malformed stub: web-search.js's provider
      // fallback chain calls `bus.emit('health.anomaly', …)` when a provider
      // fails, so an object with no `emit` turns any provider failure into a
      // TypeError instead of the intended fall-through to the next provider.
      bus: { emit() {}, subscribe() {} },
      config: {},
      fs: null,
      buildRunner: null,
      probes: null,
      abtop: null,
      goalsEffector: null,
      pipeline: null,
      kanban: null,
      agentActions: null,
    };
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('with default config (no YOUTUBE_MODE), returns widgetType:"youtube" — in-HUD by default (Slice-2: electron mode)', async () => {
    ctx.config = {}; // no YOUTUBE_MODE set — defaults to 'electron' (in-HUD embed)

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube', query: 'test video' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'youtube', 'Default (electron) mode opens in the HUD web panel, not an external browser');
    assert.match(result.result.embedUrl, /youtube-nocookie\.com\/embed\//, 'Should have an embed URL for the in-HUD panel');
  });

  it('with YOUTUBE_MODE="electron" (explicit), returns widgetType:"youtube" — same in-HUD path as embed', async () => {
    ctx.config = { YOUTUBE_MODE: 'electron' };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube', query: 'test video' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'youtube', 'electron mode opens in the HUD web panel');
    assert.match(result.result.embedUrl, /youtube-nocookie\.com\/embed\//, 'Should have an embed URL');
  });

  it('with YOUTUBE_MODE="newtab", returns widgetType:"newtab" with YouTube URL', async () => {
    ctx.config = { YOUTUBE_MODE: 'newtab' };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube', query: 'test video' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'newtab', 'Should return newtab widget type');
    assert.ok(result.result.url, 'Should have a URL');
    assert.match(result.result.url, /youtube\.com\/watch\?v=/, 'URL should be a YouTube watch link');
    assert.ok(result.result.title, 'Should have a title');
  });

  it('with YOUTUBE_MODE="embed" (explicit), returns widgetType:"youtube"', async () => {
    ctx.config = { YOUTUBE_MODE: 'embed' };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube', query: 'test video' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'youtube', 'Should return youtube widget');
    assert.match(result.result.embedUrl, /youtube-nocookie\.com\/embed\//, 'Should have embed URL');
  });

  it('fails when no search query provided', async () => {
    ctx.config = { YOUTUBE_MODE: 'embed' };

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube' }); // no query

    assert.equal(result.ok, false, 'Should fail without query');
    assert.match(result.result, /search query is required/);
  });

  it('probes only real candidates when all videos refuse embedding', async () => {
    const probes = [];
    const fallback = makeFetchStub();
    global.fetch = async (url) => {
      if (String(url).includes('youtube.com/oembed')) {
        probes.push(new URL(String(url)).searchParams.get('url'));
        return { ok: false, status: 403 };
      }
      return fallback(url);
    };
    const result = await toolFn(buildTools(ctx), 'open_web')({ type: 'youtube', query: 'blocked embed' });
    assert.deepEqual(probes, [`https://www.youtube.com/watch?v=${STUB_VIDEO_ID}`]);
    assert.equal(result.result.widgetType, 'newtab');
    assert.equal(result.result.url, probes[0]);
  });

});
