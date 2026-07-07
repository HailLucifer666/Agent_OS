// tools-computer.test.js — path sandbox, mailto/gmail encoding, list/read tool contracts.
// Filesystem tools operate on real temp directories (not vault-backed), scoped to
// VOICE_ALLOWED_DIRS pointed at an isolated temp root for the duration of this suite.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-computer-test-'));
process.env.VOICE_ALLOWED_DIRS = TMP_ROOT;

// tools-computer.js does `const { spawn } = require('child_process')` at its own require
// time, capturing whatever child_process.spawn pointed to at that moment into a local
// const — so this patch MUST happen before `require('./tools-computer')` below, or the
// module's already-bound reference to the real spawn would be unaffected by this stub.
// Without this, every test run for open_folder/compose_email actually launches a real
// Explorer window / browser tab / mail app on the machine running the suite.
const cp = require('child_process');
const spawnCalls = [];
cp.spawn = (...args) => {
  spawnCalls.push(args);
  return { on: () => {}, unref: () => {}, kill: () => {} };
};

const tools = require('./tools-computer');

describe('tools-computer.js', () => {
  before(() => {
    fs.mkdirSync(path.join(TMP_ROOT, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(TMP_ROOT, 'notes.txt'), 'hello from a sandboxed file\n');
    fs.writeFileSync(path.join(TMP_ROOT, 'subdir', 'nested.txt'), 'nested content');
    // A file bigger than the 1MB read cap.
    fs.writeFileSync(path.join(TMP_ROOT, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
  });

  after(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    delete process.env.VOICE_ALLOWED_DIRS;
  });

  describe('resolveSandboxed', () => {
    test('accepts a path inside the allowed root', () => {
      const res = tools.resolveSandboxed(path.join(TMP_ROOT, 'notes.txt'));
      assert.equal(res.ok, true);
    });

    test('rejects a path outside the allowed root', () => {
      const outside = path.join(os.tmpdir(), 'definitely-outside-dir');
      const res = tools.resolveSandboxed(outside);
      assert.equal(res.ok, false);
    });

    test('rejects ".." traversal that escapes the allowed root', () => {
      const escape = path.join(TMP_ROOT, '..', '..', 'escaped');
      const res = tools.resolveSandboxed(escape);
      assert.equal(res.ok, false);
    });

    test('".." that stays inside the allowed root is fine', () => {
      const staysInside = path.join(TMP_ROOT, 'subdir', '..', 'notes.txt');
      const res = tools.resolveSandboxed(staysInside);
      assert.equal(res.ok, true);
    });

    test('rejects UNC paths (\\\\host\\share)', () => {
      const res = tools.resolveSandboxed('\\\\fileserver\\share\\secret.txt');
      assert.equal(res.ok, false);
      assert.match(res.reason, /network|unc/i);
    });

    test('rejects forward-slash UNC-style paths (//host/share)', () => {
      const res = tools.resolveSandboxed('//fileserver/share/secret.txt');
      assert.equal(res.ok, false);
    });

    test('rejects reserved Windows device names (CON, NUL, PRN, AUX, COM1, LPT1)', () => {
      for (const name of ['CON', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT1']) {
        const res = tools.resolveSandboxed(path.join(TMP_ROOT, name));
        assert.equal(res.ok, false, `${name} should be rejected`);
      }
    });

    test('rejects a reserved device name even with an extension (CON.txt)', () => {
      const res = tools.resolveSandboxed(path.join(TMP_ROOT, 'CON.txt'));
      assert.equal(res.ok, false);
    });

    test('rejects an empty/missing path without throwing', () => {
      assert.doesNotThrow(() => {
        const res = tools.resolveSandboxed('');
        assert.equal(res.ok, false);
      });
    });
  });

  describe('open_folder', () => {
    test('rejects a path outside the sandbox, never throws', () => {
      const res = tools.open_folder({ path: path.join(os.tmpdir(), 'outside') });
      assert.equal(res.ok, false);
    });

    test('rejects a non-existent folder inside the sandbox', () => {
      const res = tools.open_folder({ path: path.join(TMP_ROOT, 'does-not-exist') });
      assert.equal(res.ok, false);
    });
  });

  describe('list_folder', () => {
    test('lists entries with name/isDirectory/size/mtime and sets needs_result:true', () => {
      const res = tools.list_folder({ path: TMP_ROOT });
      assert.equal(res.ok, true);
      assert.equal(res.needs_result, true);
      const names = res.result.entries.map((e) => e.name);
      assert.ok(names.includes('notes.txt'));
      assert.ok(names.includes('subdir'));
      const dirEntry = res.result.entries.find((e) => e.name === 'subdir');
      assert.equal(dirEntry.isDirectory, true);
      const fileEntry = res.result.entries.find((e) => e.name === 'notes.txt');
      assert.equal(fileEntry.isDirectory, false);
      assert.equal(typeof fileEntry.size, 'number');
      assert.equal(typeof fileEntry.mtime, 'string');
    });

    test('caps at 50 entries and reports truncated:true when exceeded', () => {
      const manyDir = fs.mkdtempSync(path.join(TMP_ROOT, 'many-'));
      for (let i = 0; i < 60; i += 1) {
        fs.writeFileSync(path.join(manyDir, `file-${i}.txt`), 'x');
      }
      const res = tools.list_folder({ path: manyDir });
      assert.equal(res.ok, true);
      assert.equal(res.result.entries.length, 50);
      assert.equal(res.result.truncated, true);
      assert.equal(res.result.totalCount, 60);
    });

    test('rejects a folder outside the sandbox', () => {
      const res = tools.list_folder({ path: os.tmpdir() });
      assert.equal(res.ok, false);
    });
  });

  describe('read_file', () => {
    test('reads a text file and returns its content with needs_result:true', () => {
      const res = tools.read_file({ path: path.join(TMP_ROOT, 'notes.txt') });
      assert.equal(res.ok, true);
      assert.equal(res.needs_result, true);
      assert.match(res.result.text, /hello from a sandboxed file/);
      assert.equal(res.result.truncated, false);
    });

    test('rejects a file over 1MB', () => {
      const res = tools.read_file({ path: path.join(TMP_ROOT, 'big.bin') });
      assert.equal(res.ok, false);
      assert.match(res.result, /too large/i);
    });

    test('rejects a path outside the sandbox', () => {
      const res = tools.read_file({ path: path.join(os.tmpdir(), 'notes.txt') });
      assert.equal(res.ok, false);
    });

    test('rejects a directory path (not a file)', () => {
      const res = tools.read_file({ path: TMP_ROOT });
      assert.equal(res.ok, false);
    });
  });

  describe('compose_email — mailto mode', () => {
    test('builds a mailto: URL with encoded subject/body/to', () => {
      delete process.env.VOICE_EMAIL_MODE;
      const url = tools.buildMailtoUrl({ to: 'sam@example.com', subject: 'Friday deadline', body: 'See you then.' });
      assert.match(url, /^mailto:sam%40example\.com\?/);
      assert.match(url, /subject=Friday\+deadline|subject=Friday%20deadline/);
      assert.match(url, /body=See\+you\+then\.|body=See%20you%20then\./);
    });

    test('round-trips special characters (&, #, newlines, unicode) through encode/decode', () => {
      const subject = 'Q&A: #urgent';
      const body = 'Line one\nLine two — emoji: 🚀 & more';
      const url = tools.buildMailtoUrl({ to: 'x@y.com', subject, body });
      const qIndex = url.indexOf('?');
      const params = new URLSearchParams(url.slice(qIndex + 1));
      assert.equal(params.get('subject'), subject);
      assert.equal(params.get('body'), body);
    });

    test('truncates the body BEFORE encoding, not after — no split %XX escape at the boundary', () => {
      // A multi-byte character (emoji) placed exactly at the truncation boundary. If truncation
      // happened on the ALREADY-ENCODED string, this could split a %XX escape in the middle.
      const longBody = 'a'.repeat(1799) + '🚀' + 'b'.repeat(50);
      const truncated = tools.truncateBody(longBody);
      assert.equal(truncated.length, 1800, 'truncation is on the raw string length, not encoded length');
      const url = tools.buildMailtoUrl({ subject: 'test', body: longBody });
      const qIndex = url.indexOf('?');
      const params = new URLSearchParams(url.slice(qIndex + 1));
      // Must decode cleanly with no replacement/garbage characters from a split escape.
      assert.doesNotThrow(() => decodeURIComponent(encodeURIComponent(params.get('body'))));
      assert.equal(params.get('body').length, 1800);
    });

    test('omits the "to" query param encoding issue: to goes in the path, not a query param', () => {
      const url = tools.buildMailtoUrl({ to: 'a+b@example.com', subject: 's' });
      assert.ok(url.startsWith('mailto:'));
      assert.ok(!url.includes('to='), 'to must be part of the mailto: path, not a query param');
    });
  });

  describe('compose_email — gmail mode', () => {
    test('builds a Gmail compose URL with to/subject/body query params', () => {
      const url = tools.buildGmailUrl({ to: 'sam@example.com', subject: 'Hi', body: 'Body text' });
      assert.match(url, /^https:\/\/mail\.google\.com\/mail\/\?/);
      const params = new URLSearchParams(url.split('?')[1]);
      assert.equal(params.get('to'), 'sam@example.com');
      assert.equal(params.get('subject'), 'Hi');
      assert.equal(params.get('body'), 'Body text');
      assert.equal(params.get('view'), 'cm');
      assert.equal(params.get('fs'), '1');
    });

    test('gmail body is also truncated before encoding', () => {
      const longBody = 'z'.repeat(3000);
      const url = tools.buildGmailUrl({ subject: 's', body: longBody });
      const params = new URLSearchParams(url.split('?')[1]);
      assert.equal(params.get('body').length, 1800);
    });
  });

  describe('compose_email tool function', () => {
    test('requires at least a subject or a body, never throws', () => {
      const res = tools.compose_email({ to: 'x@y.com' });
      assert.equal(res.ok, false);
    });

    test('returns ok:true with the built url when subject is present', () => {
      const res = tools.compose_email({ to: 'x@y.com', subject: 'Hi', body: 'Body' });
      assert.equal(res.ok, true);
      assert.equal(typeof res.result.url, 'string');
    });

    test('defaults to gmail (browser compose) mode when VOICE_EMAIL_MODE is unset — no desktop mail app configured yet', () => {
      delete process.env.VOICE_EMAIL_MODE;
      const res = tools.compose_email({ to: 'x@y.com', subject: 'Hi', body: 'Body' });
      assert.equal(res.result.mode, 'gmail');
      assert.match(res.result.url, /^https:\/\/mail\.google\.com\/mail\/\?/);
    });

    test('uses the OS mail app (mailto:) only when VOICE_EMAIL_MODE=mailto is explicitly set', () => {
      process.env.VOICE_EMAIL_MODE = 'mailto';
      try {
        const res = tools.compose_email({ to: 'x@y.com', subject: 'Hi', body: 'Body' });
        assert.equal(res.result.mode, 'mailto');
        assert.match(res.result.url, /^mailto:/);
      } finally {
        delete process.env.VOICE_EMAIL_MODE;
      }
    });
  });

  test('TOOLS catalog does not include any delete/move/write/shell/run_command/registry tool', () => {
    const names = tools.TOOLS.map((t) => t.name);
    const forbidden = /delete|move|overwrite|write|shell|run_command|registry/i;
    for (const name of names) {
      assert.ok(!forbidden.test(name), `tool "${name}" looks like a forbidden destructive/shell tool`);
    }
    assert.deepEqual(names.sort(), ['compose_email', 'list_folder', 'open_folder', 'read_file'].sort());
  });

  test('all TOOLS entries have danger:false (no computer tool in this file is danger:true)', () => {
    for (const t of tools.TOOLS) {
      assert.equal(t.danger, false, `${t.name} should not be danger:true`);
    }
  });
});
