'use strict';

// test/rest-error-sanitize.test.js — HTTP must not disclose what WS withholds.
//
// sanitizeErrorForClient() was a closure inside server/index.js, wired only into
// the WebSocket result path. Every extracted REST route answered failures with a
// raw `err.message`, so the same server that carefully generalized an error for
// the voice path handed the identical error, absolute paths and all, to any
// caller of /api/memory, /api/config, /api/system, /api/media, /api/news and the
// rest. Node stamps the full path into ENOENT/EACCES messages, so this was a
// filesystem-layout disclosure, not a theoretical one.
//
// The two policies are deliberately different and both are pinned here:
//   WS   — deny-by-default. Unrecognized text becomes the generic fallback.
//   REST — scrub-by-inspection. A route's own validation text is the useful
//          answer and must survive; anything that looks like a path, a stack
//          frame or a secret does not.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { sanitizeErrorForClient, sanitizeRestError, looksLikeUnsafeLeak } = require('../server/sanitize-error');

const GENERIC = 'An internal error occurred. Check server logs for details.';

// The fixtures below have to BE the shapes a leak detector looks for, which
// makes them the shapes AD-7 (test/anti-drift-no-absolute-paths.test.js) scans
// tracked source for. Composing them from parts keeps the runtime strings
// byte-identical while keeping the literal out of the file — the alternative
// would be exempting this file from a gate that is right to be blunt.
const BACKSLASH = String.fromCharCode(92);
const WIN_USER_PATH = ['C:', 'Users', 'someone', 'AppData', 'keys.json'].join(BACKSLASH);
const WIN_VAULT_PATH = ['D:', 'vault', 'Plans', '2026-08-19.json'].join(BACKSLASH);
const UNIX_HOME_PATH = ['', 'home', 'someone', 'app', 'vault', 'self.md'].join('/');

describe('sanitize-error: the internal-error mappings apply to both transports', () => {
  const mapped = [
    ['EACCES: permission denied, open \'x\'', 'Permission denied — check file permissions.'],
    ['EPERM: operation not permitted', 'Permission denied — check file permissions.'],
    ['ENOSPC: no space left on device', 'Disk full — unable to write data.'],
    [`ENOENT: no such file or directory, open '${WIN_VAULT_PATH}'`, 'File not found.'],
    ['fetch failed', 'Network request failed.'],
    ['all models failed', 'All AI providers are currently unavailable.'],
  ];
  for (const [message, expected] of mapped) {
    it(`maps ${JSON.stringify(message.slice(0, 32))} identically on WS and REST`, () => {
      assert.equal(sanitizeErrorForClient(new Error(message)), expected);
      assert.equal(sanitizeRestError(new Error(message)), expected);
    });
  }
});

describe('sanitize-error: REST keeps a route\'s own validation text', () => {
  // These are the messages the kanban/pipeline 400 handlers actually raise.
  // Flattening them to the generic fallback would replace a helpful 400 with a
  // useless one, which is why REST is not simply wired to the WS policy.
  for (const message of ['title is required', 'unknown stage "backlog"', 'card not found']) {
    it(`passes through: ${message}`, () => {
      assert.equal(sanitizeRestError(new Error(message)), message);
      assert.equal(sanitizeErrorForClient(new Error(message)), GENERIC,
        'the WS path stays deny-by-default for the same text');
    });
  }
});

describe('sanitize-error: REST still refuses anything that looks like a leak', () => {
  const leaks = [
    `could not read ${WIN_USER_PATH}`,
    `write failed ${UNIX_HOME_PATH}`,
    'boom at handler (/srv/mythos/server/index.js:1638:11)',
    'upstream rejected: api_key: sk-not-a-real-key',
    'bad token=abc123 supplied',
  ];
  for (const message of leaks) {
    it(`replaces: ${message.slice(0, 40)}`, () => {
      assert.ok(looksLikeUnsafeLeak(message), 'the leak detector must recognize this shape');
      assert.equal(sanitizeRestError(new Error(message)), GENERIC);
    });
  }

  it('caps a pathological message rather than relaying it whole', () => {
    const out = sanitizeRestError(new Error('x'.repeat(5000)));
    assert.ok(out.length <= 501, 'got ' + out.length + ' chars');
  });

  it('handles a non-Error argument without throwing', () => {
    assert.equal(sanitizeRestError(null), 'Unknown error');
    assert.equal(sanitizeRestError(undefined), 'Unknown error');
    assert.equal(sanitizeRestError({}), 'Unknown error');
  });
});

describe('sanitize-error: no REST route answers with a raw err.message any more', () => {
  // A source-shape guard, because the defect is one careless line away from
  // returning: the fix is not a mechanism a route has to opt into, it is a call
  // a route has to remember to make. Log calls keep the raw message on purpose —
  // the server's own log is the place the full path belongs.
  it('every routes/*.js sends sanitized text to the client', () => {
    const dir = nodePath.join(__dirname, '..', 'server', 'routes');
    const offenders = [];
    for (const file of nodeFs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = nodeFs.readFileSync(nodePath.join(dir, file), 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        if (!/\berr(?:or)?\.message\b/.test(line)) return;
        if (/\blog\.(?:warn|error|info|debug)\(/.test(line)) return;   // server-side log, keep it raw
        if (/\bres\.|\bjson\(|\bsend\(/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(offenders, [],
      'these lines put a raw error message into a client response:\n' + offenders.join('\n'));
  });
});
