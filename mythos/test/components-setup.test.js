'use strict';

// test/components-setup.test.js — the optional-component picker: catalog
// allowlist, installer-manifest reader, and the /api/setup/components routes.
//
// The behaviours worth pinning are the ones that would make this dangerous or
// dishonest:
//   - a request naming a script instead of an id would be arbitrary code
//     execution, so resolveComponentIds must reject anything off the allowlist;
//   - "installed" must come from doctor's on-disk view, never from a remembered
//     checkbox or a zero exit code;
//   - a corrupt install-selection.json must read as "no selection" (fall back to
//     defaults), not as "the operator chose nothing";
//   - Hermes must not be offered where WSL is absent.
//
// Run: cd mythos && node --test test/components-setup.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { EventEmitter } = require('events');

const components = require('../src/core/setup/components.js');
const { readInstallSelection } = require('../src/core/setup/install-selection.js');
const { mountComponentsRoutes } = require('../server/routes/components.js');

describe('components catalog', () => {
  it('offers only components that actually have an installer script', () => {
    // This used to be pinned by naming piper as the one row that must NOT
    // appear, because scripts/setup-piper.js was advertised in three places and
    // existed in none. The script exists as of 2026-08-11, so the assertion is
    // now the general rule it was always standing in for: every checkbox must
    // map to a script that is really on disk. A checkbox that cannot act is the
    // same lie as a fake progress bar, whichever row it is.
    const path = require('path');
    const fs = require('fs');
    for (const c of components.catalog()) {
      assert.match(c.script, /^scripts\/setup-[a-z]+\.js$/, 'every entry maps to a fixed script path');
      assert.ok(Array.isArray(c.args));
      const full = path.join(__dirname, '..', c.script);
      assert.ok(fs.existsSync(full), `${c.id} points at ${c.script}, which does not exist`);
    }
    // And the row that motivated the rule is now real, with the doctor asset id
    // that makes "installed" an observed fact rather than a claimed one.
    const piper = components.findComponent('piper');
    assert.ok(piper, 'piper has an installer now and must be offerable');
    assert.equal(piper.doctorId, 'piper');
  });

  it('hands back copies, so a caller cannot reshape the allowlist', () => {
    const first = components.catalog();
    first[0].script = 'scripts/../../evil.js';
    first[0].args.push('--rm-rf');
    const second = components.catalog();
    assert.notEqual(second[0].script, 'scripts/../../evil.js');
    assert.equal(second[0].args.length, components.COMPONENTS[0].args.length);
  });
});

describe('resolveComponentIds', () => {
  it('accepts known ids', () => {
    const res = components.resolveComponentIds(['silero', 'wakeword'], { wslPresent: false });
    assert.equal(res.ok, true);
    assert.deepEqual(res.components.map((c) => c.id), ['silero', 'wakeword']);
  });

  it('rejects an unknown id outright instead of installing the subset it liked', () => {
    const res = components.resolveComponentIds(['silero', 'rm -rf /'], { wslPresent: true });
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown component/);
  });

  it('rejects non-strings, duplicates, and an empty request', () => {
    assert.equal(components.resolveComponentIds([{ script: 'evil.js' }], {}).ok, false);
    assert.equal(components.resolveComponentIds(['silero', 'silero'], {}).ok, false);
    assert.equal(components.resolveComponentIds([], {}).ok, false);
    assert.equal(components.resolveComponentIds('silero', {}).ok, false);
  });

  it('refuses Hermes when WSL is absent, and names the reason', () => {
    const res = components.resolveComponentIds(['hermes'], { wslPresent: false });
    assert.equal(res.ok, false);
    assert.match(res.error, /WSL/);
    assert.equal(components.resolveComponentIds(['hermes'], { wslPresent: true }).ok, true);
  });
});

describe('mergeComponentState', () => {
  const assets = [
    { id: 'silero', ok: true },
    { id: 'wakeword', ok: false },
    { id: 'adb', ok: false },
  ];

  it('takes "installed" from doctor, not from the remembered selection', () => {
    const rows = components.mergeComponentState({
      assets,
      selection: { silero: true, wakeword: true },
      wslPresent: true,
    });
    const silero = rows.find((r) => r.id === 'silero');
    const wakeword = rows.find((r) => r.id === 'wakeword');
    assert.equal(silero.installed, true);
    assert.equal(wakeword.installed, false);
  });

  it('does not pre-check something already installed', () => {
    const rows = components.mergeComponentState({ assets, selection: { silero: true }, wslPresent: true });
    assert.equal(rows.find((r) => r.id === 'silero').selected, false,
      're-running a downloader that already succeeded is a confusing default');
  });

  it('marks Hermes unavailable with the fix when WSL is missing', () => {
    const row = components.mergeComponentState({ assets, selection: null, wslPresent: false })
      .find((r) => r.id === 'hermes');
    assert.equal(row.available, false);
    assert.match(row.unavailableReason, /wsl --install/);
  });

  it('reports installed:null for a component doctor cannot observe (autostart)', () => {
    const row = components.mergeComponentState({ assets, selection: null, wslPresent: true })
      .find((r) => r.id === 'autostart');
    assert.equal(row.installed, null, 'null is "unknown", which is not the same as false');
  });
});

describe('readInstallSelection', () => {
  const fakeFs = (files) => ({
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
      return files[p];
    },
  });

  const APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
  const file = require('path').join(APPDATA, 'MYTHOS', 'install-selection.json');

  it('reads the installer manifest', () => {
    const res = readInstallSelection({
      env: { APPDATA },
      fs: fakeFs({ [file]: JSON.stringify({ version: 1, wslPresent: true, selected: { silero: true, adb: true } }) }),
    });
    assert.equal(res.found, true);
    assert.deepEqual(res.selected, { silero: true, adb: true });
    assert.equal(res.wslPresent, true);
  });

  it('counts only real booleans, never a guessed "yes"', () => {
    const res = readInstallSelection({
      env: { APPDATA },
      fs: fakeFs({ [file]: JSON.stringify({ selected: { silero: 'yes', adb: 1, hermes: true } }) }),
    });
    assert.deepEqual(res.selected, { hermes: true });
  });

  it('treats corrupt or absent as NO selection, not an empty one', () => {
    const corrupt = readInstallSelection({ env: { APPDATA }, fs: fakeFs({ [file]: '{ not json' }) });
    assert.equal(corrupt.found, false);
    assert.equal(corrupt.reason, 'unparseable');

    const absent = readInstallSelection({ env: {}, fs: fakeFs({}), homedir: 'C:\\Users\\x' });
    assert.equal(absent.found, false);
    assert.equal(absent.reason, 'absent');
  });
});

// ---- routes ---------------------------------------------------------------

function serve(deps) {
  const app = express();
  app.use(express.json());
  mountComponentsRoutes(app, deps);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { port, host: '127.0.0.1', method, path, headers: data ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* leave null */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// A spawn stand-in: records what was launched and finishes with the given code.
function fakeSpawn(record, code) {
  return (cmd, args) => {
    record.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('installer said something\n'));
      child.emit('close', code, null);
    });
    return child;
  };
}

const report = () => ({ assets: [{ id: 'silero', ok: false }, { id: 'wakeword', ok: true }] });

describe('GET /api/setup/components', () => {
  it('reports installed state from doctor plus the installer selection', async () => {
    const s = await serve({
      buildReport: report,
      probeWsl: () => false,
      installSelection: { readInstallSelection: () => ({ found: true, selected: { silero: true } }) },
    });
    try {
      const res = await request(s.port, 'GET', '/api/setup/components');
      assert.equal(res.status, 200);
      assert.equal(res.body.selectionSource, 'installer');
      const silero = res.body.components.find((c) => c.id === 'silero');
      assert.equal(silero.installed, false);
      assert.equal(silero.selected, true);
      assert.equal(res.body.components.find((c) => c.id === 'hermes').available, false);
    } finally { await s.close(); }
  });

  it('a report that throws is a 500, not a cheerful "nothing installed"', async () => {
    const s = await serve({
      buildReport: () => { throw new Error('disk on fire'); },
      probeWsl: () => true,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'absent' }) },
    });
    try {
      const res = await request(s.port, 'GET', '/api/setup/components');
      assert.equal(res.status, 500);
      assert.match(res.body.error, /disk on fire/);
    } finally { await s.close(); }
  });
});

describe('POST /api/setup/components/install', () => {
  it('spawns the allowlisted script for each id, never a request string', async () => {
    const launched = [];
    const s = await serve({
      buildReport: report,
      probeWsl: () => true,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'absent' }) },
      spawn: fakeSpawn(launched, 0),
    });
    try {
      const res = await request(s.port, 'POST', '/api/setup/components/install', { ids: ['silero'] });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results, [{ id: 'silero', ok: true, code: 0, error: '' }]);
      assert.equal(launched.length, 1);
      assert.equal(launched[0].cmd, process.execPath, 'the interpreter is ours, not the caller\'s');
      assert.match(launched[0].args[0], /setup-silero\.js$/);
    } finally { await s.close(); }
  });

  it('refuses an unknown id with 400 and spawns nothing', async () => {
    const launched = [];
    const s = await serve({
      buildReport: report,
      probeWsl: () => true,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'absent' }) },
      spawn: fakeSpawn(launched, 0),
    });
    try {
      const res = await request(s.port, 'POST', '/api/setup/components/install', { ids: ['../../evil'] });
      assert.equal(res.status, 400);
      assert.equal(launched.length, 0, 'nothing may be launched for a rejected batch');
    } finally { await s.close(); }
  });

  it('reports a failing installer as failed, with its own last words', async () => {
    const s = await serve({
      buildReport: report,
      probeWsl: () => true,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'absent' }) },
      spawn: fakeSpawn([], 1),
    });
    try {
      const res = await request(s.port, 'POST', '/api/setup/components/install', { ids: ['wakeword'] });
      assert.equal(res.body.results[0].ok, false);
      assert.match(res.body.results[0].error, /installer said something/,
        'a generic "install failed" is never actionable');
    } finally { await s.close(); }
  });

  it('refuses Hermes on a machine without WSL', async () => {
    const s = await serve({
      buildReport: report,
      probeWsl: () => false,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'absent' }) },
      spawn: fakeSpawn([], 0),
    });
    try {
      const res = await request(s.port, 'POST', '/api/setup/components/install', { ids: ['hermes'] });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /WSL/);
    } finally { await s.close(); }
  });
});
