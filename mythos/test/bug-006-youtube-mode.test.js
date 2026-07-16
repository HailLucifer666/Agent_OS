'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(toolsObj, name) {
  const tools = toolsObj.TOOLS || toolsObj;
  return tools.find((t) => t.name === name).fn;
}

describe('BUG-006: YouTube embed mode configuration', () => {
  let ctx;
  const realFetch = global.fetch;

  beforeEach(() => {
    ctx = {
      bus: {},
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

  it('with default config (no YOUTUBE_MODE), returns widgetType:"youtube" with embed URL', async () => {
    ctx.config = {}; // no YOUTUBE_MODE set, should default to 'embed'

    const tools = buildTools(ctx);
    const open_web = toolFn(tools, 'open_web');
    const result = await open_web({ type: 'youtube', query: 'test video' });

    assert.equal(result.ok, true, 'Should succeed');
    assert.equal(result.result.widgetType, 'youtube', 'Default mode should return youtube widget');
    assert.ok(result.result.videoId, 'Should extract a video ID');
    assert.match(result.result.embedUrl, /youtube-nocookie\.com\/embed\//, 'Should build embed URL');
    assert.ok(result.result.title, 'Should have a title');
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

});
