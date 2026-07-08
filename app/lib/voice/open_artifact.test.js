// open_artifact.test.js — unit tests for the voice open_artifact tool.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('open_artifact', () => {
  test('constructs localhost URL from /vault/builds/... path and spawns OS open command', async () => {
    let captured = null;
    const originalChild = require.cache[require.resolve('child_process')];
    require.cache[require.resolve('child_process')] = {
      exports: {
        spawnSync: (...args) => { captured = args; return { error: null }; },
      },
    };
    delete require.cache[require.resolve('./tools-dashboard')];
    const { open_artifact } = require('./tools-dashboard');
    const result = await open_artifact({ path: '/vault/builds/pipeline/subway-dash.html', title: 'Subway Dash' });
    assert.equal(result.ok, true);
    assert.equal(result.result.url, 'http://localhost:4477/vault/builds/pipeline/subway-dash.html');
    assert.equal(result.result.display, 'Subway Dash');
    assert.ok(captured, 'spawnSync should have been called');
    if (originalChild) require.cache[require.resolve('child_process')] = originalChild;
    delete require.cache[require.resolve('./tools-dashboard')];
  });

  test('passes raw http/https URLs through unchanged', async () => {
    let captured = null;
    const originalChild = require.cache[require.resolve('child_process')];
    require.cache[require.resolve('child_process')] = {
      exports: {
        spawnSync: (...args) => { captured = args; return { error: null }; },
      },
    };
    delete require.cache[require.resolve('./tools-dashboard')];
    const { open_artifact } = require('./tools-dashboard');
    const result = await open_artifact({ path: 'https://example.com/game.html', title: 'Example Game' });
    assert.equal(result.ok, true);
    assert.equal(result.result.url, 'https://example.com/game.html');
    if (originalChild) require.cache[require.resolve('child_process')] = originalChild;
    delete require.cache[require.resolve('./tools-dashboard')];
  });

  test('returns ok:false for missing path', async () => {
    delete require.cache[require.resolve('./tools-dashboard')];
    const { open_artifact } = require('./tools-dashboard');
    const result = await open_artifact({});
    assert.equal(result.ok, false);
    assert.ok(result.result.includes('required'));
    delete require.cache[require.resolve('./tools-dashboard')];
  });
});
