// server-free-claude.test.js — tests for POST /api/free-claude/build endpoint.
// Uses the real server against a temp vault. Since the reasoning engine requires
// API keys (not available in CI), we test validation and the clear error path.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tempVaultDir, rmrf } = require('./lib/test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const server = require('./server');
let BASE = '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: server.address().port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data,
          json: () => JSON.parse(data),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('POST /api/free-claude/build', () => {
  before(async () => {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        setTimeout(() => reject(new Error('server did not start within 2s')), 2000);
      });
    }
    BASE = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    server.close();
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
    await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  });

  test('missing prompt → 400', async () => {
    const res = await request('POST', '/api/free-claude/build', {});
    assert.equal(res.status, 400);
    const json = res.json();
    assert.equal(json.error, 'prompt required');
  });

  test('empty prompt → 400', async () => {
    const res = await request('POST', '/api/free-claude/build', { prompt: '  ' });
    assert.equal(res.status, 400);
    const json = res.json();
    assert.equal(json.error, 'prompt required');
  });

  test('valid prompt → 500 (no reasoning engine available in test env)', async () => {
    const res = await request('POST', '/api/free-claude/build', { prompt: 'build me a hello world page' });
    assert.equal(res.status, 500);
    const json = res.json();
    assert.ok(json.error, 'should have an error message');
    // In CI there are no API keys; the Claude CLI may or may not be installed.
    // Either way the build should fail gracefully with a clear error.
    assert.ok(json.error.length > 10, `error should be descriptive, got: ${json.error}`);
  });

  test('GET /api/builds/free-claude → 200 with empty builds array', async () => {
    const res = await new Promise((resolve, reject) => {
      http.get(`${BASE}/api/builds/free-claude`, (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => resolve({ status: r.statusCode, json: () => JSON.parse(data) }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json().builds), 'builds should be an array');
  });
});
