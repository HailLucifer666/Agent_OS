'use strict';

// test/bug-436-no-blocking-child-process.test.js — BUG-436, the blocking half.
//
// THE MEASUREMENT, 2026-09-23 (attended run, LOOP_LAG_TRACE on). A 3 s freeze with
// 47 ms of CPU ended the instant a debug-browser launch returned; that launch's
// process queries ran PowerShell through execFileSync (bounded at 15 s). A
// synchronous child-process call stops EVERYTHING in this process for as long as
// the child runs — the Live socket, the HUD, every timer — which is exactly what
// "MYTHOS goes quiet mid-conversation" looks like from outside.
//
// WHAT CHANGED. Every such call reachable after boot now runs through
// src/core/util/exec-file-text.js (async execFile, still bounded, killed on
// timeout): the browser process queries and taskkill, the default-browser
// registry read, the setup page's `wsl.exe --status`, and the Piper / edge-tts
// python probes, which re-ran on every crash-restart. The two that remain are
// boot-only, and (b) proves that from the source rather than asserting it.
//
// SCOPE, SAID SO. fs.*Sync is not in this guard: file reads are short and bounded
// by the disk, and pinning them is a separate decision. Electron's main process
// (repo-root electron/) is outside it too — it blocks the shell window, not this
// server. Harness code (scripts/, tests) may block freely.
//
// RED FIRST, 2026-09-23, against e4aea51f (HEAD's files restored in place, then
// re-hashed identical): 9 of the first 10 failed — (a) on the unwaived calls, the
// rest because nothing was async. (b), the waiver proof, passed there, as it must:
// it is true of the old code too. (k)–(o) were written after the probes below.
//
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const MYTHOS = path.join(__dirname, '..');
const SYNC_CALL = /\b(?:execFileSync|execSync|spawnSync)\s*\(/g;

// Every sync child-process call left in product code, and the reason it may stay.
// A waiver is a claim, so each carries a check that runs against the source.
const WAIVERS = {
  'src/core/identity/version.js': { calls: 1, reason: 'memoized: git runs once per process, at the first getVersion(); refresh() has no production caller' },
  'adapters/android-child/index.js': { calls: 2, reason: 'boot-only: startAndroidChild() runs the adb version / start-server probes, and its only production caller is src/main.js at boot' },
};

function productFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(MYTHOS, 'src'));
  for (const d of ['server', 'adapters']) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(path.join(MYTHOS, d));
  }
  return out;
}
// Comments are not calls: drop // lines and trailing // text, and /* */ blocks.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
const rel = (p) => path.relative(MYTHOS, p).split(path.sep).join('/');

describe('BUG-436 — nothing reachable after boot blocks the event loop on a child process', () => {
  test('(a) DERIVED: every synchronous child-process call in product code is waived, at its recorded count', () => {
    const found = {};
    for (const file of productFiles()) {
      const n = (codeOf(fs.readFileSync(file, 'utf8')).match(SYNC_CALL) || []).length;
      if (n) found[rel(file)] = n;
    }
    const unwaived = Object.keys(found).filter((f) => !WAIVERS[f]);
    assert.deepEqual(unwaived, [], 'a new synchronous child-process call — make it async, or waive it here with a proof');
    for (const [f, w] of Object.entries(WAIVERS)) {
      assert.equal(found[f] || 0, w.calls, f + ': the waived count moved (' + w.reason + ')');
    }
  });

  test('(b) the waivers are proven, not asserted: version.js is memoized, and android-child starts only at boot', () => {
    const version = fs.readFileSync(path.join(MYTHOS, 'src/core/identity/version.js'), 'utf8');
    assert.match(version, /function getVersion\(\) \{\s*if \(cached\) return cached;/, 'getVersion must stay memoized');
    const callers = (name) => productFiles().filter((f) => {
      const code = codeOf(fs.readFileSync(f, 'utf8'));
      return new RegExp('\\b' + name + '\\s*\\(').test(code.replace(new RegExp('function\\s+' + name + '\\s*\\(', 'g'), ''));
    }).map(rel);
    // CODE only: brain/index.js MENTIONS version.refresh() in a comment, and the
    // first draft of this check read raw text and failed on it.
    const refreshCallers = productFiles().filter((f) => /\bversion\.refresh\s*\(/.test(codeOf(fs.readFileSync(f, 'utf8')))).map(rel);
    assert.deepEqual(refreshCallers, [], 'a production caller of version.refresh() would re-run git synchronously mid-session');
    assert.deepEqual(callers('startAndroidChild'), ['src/main.js'], 'startAndroidChild runs sync adb probes; it must stay boot-only');
  });

  test('(c) THE MECHANISM, with a real child: the event loop keeps running during execFileText, and does not under execFileSync', async () => {
    const { execFileText } = require('../src/core/util/exec-file-text');
    const args = ['-e', 'setTimeout(() => {}, 400)'];
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    await execFileText(process.execPath, args, { timeoutMs: 10000 });
    const asyncTicks = ticks;
    ticks = 0;
    execFileSync(process.execPath, args, { timeout: 10000 });
    await new Promise((r) => setImmediate(r));
    const syncTicks = ticks;
    clearInterval(timer);
    assert.ok(asyncTicks >= 5, 'timers must fire while the child runs: ' + asyncTicks);
    assert.ok(syncTicks <= 1, 'the contrast: under execFileSync the loop was frozen for the whole 400 ms: ' + syncTicks);
  });

  test('(d) the bound still holds: a child that outlives its timeout is killed, and the promise rejects', async () => {
    const { execFileText, exitsCleanly } = require('../src/core/util/exec-file-text');
    const started = Date.now();
    await assert.rejects(execFileText(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 }), (err) => err.killed === true);
    assert.ok(Date.now() - started < 5000, 'it must not wait for the child to finish on its own');
    assert.equal(await exitsCleanly(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 5000 }), false);
    assert.equal(await exitsCleanly('mythos-no-such-binary-436', [], { timeoutMs: 5000 }), false);
    assert.equal(await exitsCleanly(process.execPath, ['-e', '0'], { timeoutMs: 5000 }), true);
  });
});

describe('BUG-436 — the browser path is async end to end', () => {
  test('(e) processOnPort, processesForProfile and identifyBrowserOnPort return promises and still answer', async () => {
    const bp = require('../adapters/browser-agent/browser-process');
    let resolveExec;
    const slow = () => new Promise((r) => { resolveExec = r; });
    const pending = bp.processOnPort(9222, { execFile: slow });
    assert.ok(pending && typeof pending.then === 'function', 'processOnPort must not block its caller');
    resolveExec('21708=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.deepEqual(await pending, { pid: 21708, exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
    const profile = path.join(os.homedir(), 'AppData', 'Local', 'MYTHOS', 'brave-debug-profile');
    assert.deepEqual(await bp.processesForProfile(profile, { execFile: async () => '7=brave.exe' }), [{ pid: 7, name: 'brave.exe' }]);
    assert.equal(await bp.identifyBrowserOnPort('http://127.0.0.1:9222', { processOnPort: async () => ({ pid: 1, exe: 'C:\\x\\brave.exe' }) }), 'brave');
  });

  test('(f) the default-browser read is async and still resolves by rule', async () => {
    const bt = require('../src/core/effectors/browser-target');
    const reads = [];
    const reader = async (args) => { reads.push(args[1]); return /UserChoice/.test(args[1])
      ? '\r\n    ProgId    REG_SZ    BraveHTML\r\n' : '\r\n    (Default)    REG_SZ    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1\r\n'; };
    const d = await bt.osDefaultBrowser({ platform: 'win32', readRegistryValue: reader });
    assert.equal(d.name, 'brave');
    assert.equal(reads.length, 2);
  });

  test('(g) close_window awaits the attached-browser check — an unawaited promise would refuse EVERY close', async () => {
    const { makeCloseWindow } = require('../src/core/effectors/close-window-guard');
    const delegated = [];
    const agent = { getStatus: () => ({ state: 'ONLINE', cdpUrl: 'http://127.0.0.1:9222' }), processOnPort: async () => ({ pid: 4242, exe: 'x' }) };
    const close = makeCloseWindow({ delegate: async (c) => { delegated.push(c.pid); return { ok: true, result: { closed: true } }; },
      fail: (m) => ({ ok: false, result: m }), implicitTarget: { forgetIf() {} }, agent, readPid: () => null, now: () => 0 });
    const other = await close({ pid: 1111 });
    assert.deepEqual(delegated, [1111], 'a window that is NOT the attached browser must still close: ' + JSON.stringify(other));
    const refused = await close({ pid: 4242 });
    assert.equal(refused.ok, false, 'and the attached browser is still refused');
    assert.deepEqual(delegated, [1111]);
  });
});

describe('BUG-436 — a TTS child start that stop() overtook spawns nothing', () => {
  function withTtsEnv(fn) {
    return async () => {
      const saved = { ctx: process.env.NODE_TEST_CONTEXT, env: process.env.NODE_ENV, edge: process.env.EDGE_TTS_AUTOSTART, piper: process.env.PIPER_AUTOSTART };
      delete process.env.NODE_TEST_CONTEXT; delete process.env.NODE_ENV; delete process.env.EDGE_TTS_AUTOSTART; delete process.env.PIPER_AUTOSTART;
      try { await fn(); } finally {
        for (const [k, name] of [['ctx', 'NODE_TEST_CONTEXT'], ['env', 'NODE_ENV'], ['edge', 'EDGE_TTS_AUTOSTART'], ['piper', 'PIPER_AUTOSTART']]) {
          if (saved[k] === undefined) delete process.env[name]; else process.env[name] = saved[k];
        }
      }
    };
  }
  const fakeChild = () => { const c = new EventEmitter(); c.kill = () => {}; return c; };
  const quiet = { info() {}, warn() {} };

  function rig(create, extra) {
    let release; const gate = new Promise((r) => { release = r; });
    const spawned = [];
    const child = create(Object.assign({ logger: quiet, deps: {
      exitsCleanly: async () => { await gate; return true; },
      execFileText: async () => '',
      spawn: (...a) => { spawned.push(a); return fakeChild(); },
    } }, extra));
    return { child, release, spawned };
  }

  test('(h) edge-tts: stop() during the python probe → no child is spawned; without stop, exactly one', withTtsEnv(async () => {
    const { createEdgeTtsChild } = require('../src/core/effectors/edge-tts-child');
    const a = rig(createEdgeTtsChild);
    const starting = a.child.start();
    a.child.stop();
    a.release();
    assert.equal(await starting, false);
    assert.deepEqual(a.spawned, [], 'a child spawned after stop() is an orphan nothing will ever kill');
    const b = rig(createEdgeTtsChild);
    const ok = b.child.start(); b.release();
    assert.equal(await ok, true, 'fixture check: with no stop() the same start spawns');
    assert.equal(b.spawned.length, 1);
    b.child.stop();
  }));

  test('(i) piper: the same, with a model directory that has a voice', withTtsEnv(async () => {
    const { createPiperChild } = require('../src/core/effectors/piper-child');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug436-piper-'));
    fs.writeFileSync(path.join(dir, 'v.onnx'), 'x'); fs.writeFileSync(path.join(dir, 'v.onnx.json'), '{}');
    try {
      const a = rig(createPiperChild, { config: { PIPER_MODEL_DIR: dir } });
      const starting = a.child.start(); a.child.stop(); a.release();
      assert.equal(await starting, false);
      assert.deepEqual(a.spawned, []);
      const b = rig(createPiperChild, { config: { PIPER_MODEL_DIR: dir } });
      const ok = b.child.start(); b.release();
      assert.equal(await ok, true);
      assert.equal(b.spawned.length, 1);
      b.child.stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  test('(j) start() never rejects — a throwing probe is reported and answered false (fire-and-forget callers)', withTtsEnv(async () => {
    const { createEdgeTtsChild } = require('../src/core/effectors/edge-tts-child');
    const warns = [];
    const c = createEdgeTtsChild({ logger: { info() {}, warn: (m) => warns.push(m) }, deps: { exitsCleanly: async () => { throw new Error('boom'); } } });
    assert.equal(await c.start(), false);
    assert.ok(warns.includes('edge-tts.start-failed'), JSON.stringify(warns));
  }));
});

// ---- missing awaits, observed with ASYNC fakes -------------------------------
//
// ADDED 2026-09-23, from four probes that SURVIVED: removing an `await` at four
// call sites left every test green. The existing tests inject SYNCHRONOUS fakes,
// and a synchronous fake behaves identically with or without `await` — so they
// structurally cannot see the bug this change creates the risk of (a fixture more
// generous than the wire). Production returns promises; these fakes do too.

describe('BUG-436 — every converted call site awaits (async fakes, like production)', () => {
  const browserAgent = require('../adapters/browser-agent');
  const browserMod = require('../src/core/effectors/from-browser');
  const EXE = { chrome: path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    brave: path.join('C:', 'Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') };

  async function launchWith(deps, args) {
    const saved = { getStatus: browserAgent.getStatus, ensureOnline: browserAgent.ensureOnline, lad: process.env.LOCALAPPDATA };
    process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug436-launch-'));
    const spawned = [];
    let connects = 0;
    browserAgent.getStatus = () => (connects > 0 ? { state: 'ONLINE', mode: 'cdp', pageCount: 1 } : { state: 'OFFLINE', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => { if (!spawned.length) return false; connects += 1; return true; };
    browserMod.__setLaunchDepsForTest(Object.assign({
      spawn: (exe, a) => { spawned.push({ exe, a }); const c = new EventEmitter(); c.pid = 999; c.unref = () => {}; process.nextTick(() => c.emit('spawn')); return c; },
    }, deps));
    try { return { res: await browserMod.browser_launch_debug(args), spawned }; } finally {
      browserAgent.getStatus = saved.getStatus; browserAgent.ensureOnline = saved.ensureOnline;
      browserMod.__setLaunchDepsForTest(null); browserMod.__setAttachedBrowserForTest(null);
      if (saved.lad === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved.lad;
    }
  }

  test('(k1) an async port-owner check that names ANOTHER browser still fails the launch, naming it', async () => {
    const { res } = await launchWith({
      resolveLaunchTarget: async () => ({ name: 'chrome', exe: EXE.chrome, source: 'requested' }),
      identifyBrowserOnPort: async () => 'brave',
    }, { browser: 'chrome' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /held by brave/, 'an unawaited check reads as "[object Promise]": ' + String(res.result).slice(0, 160));
  });

  test('(k2) an async resolver\'s choice is the browser launched and reported', async () => {
    const { res, spawned } = await launchWith({
      resolveLaunchTarget: async () => ({ name: 'brave', exe: EXE.brave, source: 'os-default' }),
      identifyBrowserOnPort: async () => 'brave',
    }, {});
    assert.equal(res.ok, true, String(res.result).slice(0, 200));
    assert.equal(res.result.browser, 'brave');
    assert.equal(res.result.browserSource, 'os-default');
    assert.equal(spawned[0] && spawned[0].exe, EXE.brave);
  });

  test('(l) planLocalLaunch puts an async resolver\'s answer first', async () => {
    const attempts = await browserAgent.planLocalLaunch(path.join('C:', 'fake', 'MYTHOS', 'chrome-debug-profile'), {
      resolveLaunchTarget: async () => ({ name: 'edge', exe: path.join('C:', 'fake', 'edge.exe'), source: 'os-default' }),
      findBrowserExecutable: (n) => path.join('C:', 'fake', String(n) + '.exe'),
      debugProfileDir: (n) => path.join('C:', 'fake', 'MYTHOS', (n || 'chrome') + '-debug-profile'),
    });
    assert.equal(attempts[0] && attempts[0].name, 'edge', 'edge is LAST in the search order, so only an awaited resolver puts it first');
  });

  test('(m) the setup page reports an async WSL probe\'s real answer, not a promise', async () => {
    const express = require('express');
    const http = require('node:http');
    const { mountComponentsRoutes } = require('../server/routes/components');
    const app = express(); app.use(express.json());
    mountComponentsRoutes(app, { buildReport: () => ({ assets: [] }), probeWsl: async () => false,
      installSelection: { readInstallSelection: () => ({ found: false, reason: 'none' }) } });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/setup/components' }, (res) => {
          let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw)));
        }).on('error', reject);
      });
      assert.strictEqual(body.wslPresent, false, 'an unawaited probe serialises as {} — and a pending promise is TRUTHY');
    } finally { await new Promise((r) => server.close(r)); }
  });

  test('(n) closeDebugBrowser with an ASYNC process list: ownership is read, a survivor is killed, the kill is reported', async () => {
    const bp = require('../adapters/browser-agent/browser-process');
    const profile = path.join(os.homedir(), 'AppData', 'Local', 'MYTHOS', 'brave-debug-profile');
    // before the close: ours; after it: still there; after the kill: gone.
    const lists = [[{ pid: 7, name: 'brave.exe' }], [{ pid: 7, name: 'brave.exe' }], []];
    let n = 0; const killed = [];
    const out = await bp.closeDebugBrowser({ profileDir: profile, sendClose: async () => {},
      deps: { sleep: async () => {}, ceilingMs: 0, intervalMs: 0,
        processesForProfile: async () => lists[Math.min(n++, lists.length - 1)],
        killProcess: async (pid) => { killed.push(pid); return true; } } });
    assert.equal(out.method, 'kill', 'an unawaited list is a promise: ownership reads as "not ours", survivors read as "none"; got ' + JSON.stringify(out));
    assert.deepEqual(killed, [7]);
    assert.equal(out.closed, true);
  });

  test('(o) the external-open oracle resolves an unnamed hand-off through an ASYNC OS-default read', async () => {
    const externalRoute = require('../src/core/effectors/open-external-route');
    const evidence = require('../src/core/effectors/evidence');
    const out = await externalRoute.settleExternalOpen({
      href: 'https://github.com',
      handoff: { opened: true, via: 'os-default', browser: null },
      payload: { ok: true, result: { widgetType: 'newtab', url: 'https://github.com', handedToBrowser: true } },
    }, { sleep: async () => {},
      listWindows: async () => ({ ok: true, result: { windows: [{ pid: 4, processName: 'chrome', title: 'GitHub - Google Chrome', visible: true }] } }),
      osDefaultBrowser: async () => ({ name: 'chrome', exe: 'chrome.exe', progId: 'ChromeHTML', drivable: true }) });
    assert.equal(evidence.isVerified(out), true, 'an unawaited default read has no .drivable, so the oracle has no browser to look for: ' + JSON.stringify(out).slice(0, 200));
  });

  test('(n2) a kill that FAILED is not reported as a termination, even when the browser then exits on its own', async () => {
    const bp = require('../adapters/browser-agent/browser-process');
    const profile = path.join(os.homedir(), 'AppData', 'Local', 'MYTHOS', 'brave-debug-profile');
    const lists = [[{ pid: 7, name: 'brave.exe' }], [{ pid: 7, name: 'brave.exe' }], []];
    let n = 0;
    const out = await bp.closeDebugBrowser({ profileDir: profile, sendClose: async () => {},
      deps: { sleep: async () => {}, ceilingMs: 0, intervalMs: 0,
        processesForProfile: async () => lists[Math.min(n++, lists.length - 1)],
        killProcess: async () => false } });
    assert.doesNotMatch(out.reason, /brave\.exe pid 7/, 'an unawaited kill is a promise, and a promise is truthy: ' + out.reason);
  });

  test('(k3) the ADOPT path reports the real port owner from an async check, not a promise', async () => {
    const saved = { getStatus: browserAgent.getStatus, ensureOnline: browserAgent.ensureOnline };
    let calls = 0;
    browserAgent.getStatus = () => ({ state: calls++ === 0 ? 'OFFLINE' : 'ONLINE', mode: 'cdp', pageCount: 1 });
    browserAgent.ensureOnline = async () => true;
    browserMod.__setLaunchDepsForTest({ identifyBrowserOnPort: async () => 'brave', spawn: () => { throw new Error('must adopt, not spawn'); } });
    try {
      const res = await browserMod.browser_launch_debug({});
      assert.equal(res.ok, true, String(res.result).slice(0, 200));
      assert.equal(res.result.adopted, true, 'fixture check: the adopt branch ran');
      assert.equal(res.result.portOwner, 'brave');
    } finally {
      browserAgent.getStatus = saved.getStatus; browserAgent.ensureOnline = saved.ensureOnline;
      browserMod.__setLaunchDepsForTest(null); browserMod.__setAttachedBrowserForTest(null);
    }
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug436/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All tests GREEN before
// each one.
//
//   V1  browser-process back to a synchronous PowerShell call   -> (a)
//   V2  close_window does not await the refusal                 -> (g)
//   V3  the refusal does not await processOnPort                -> (g)
//   V4  edge-tts: no epoch check before spawn                   -> (h)
//   V5  piper: no epoch check before spawn                      -> (i)
//   V6  edge-tts: stop() does not move the epoch                -> (h)
//   V7  edge-tts: start() rejects                               -> (j)
//   V8  exec-file-text drops the timeout                        -> (d)
//   V9  GUARD ATTACK: a new child_process.execSync member call  -> (a)
//   V10 the setup route does not await the WSL probe            -> (m)
//   V11 the launch does not await resolveLaunchTarget           -> (k2)
//   V12 the named-request probe is never consulted              -> bug-412 ONLINE case
//   V13 the launch does not await the post-launch owner check   -> (k1)(k2)
//   V14 planLocalLaunch does not await the resolver             -> (l)
//   V15 osDefaultBrowser does not await the registry read       -> (f)
//   V16 closeDebugBrowser does not await the ownership read     -> (n)
//   V17 … nor the first survivor read                           -> (n)
//   V18 … nor the kill                                          -> (n2)
//   V19 the external-open oracle does not await the default     -> (o)
//   V20 the adopt path does not await the owner check           -> (k3)
//
// V10, V11, V13 and V14 SURVIVED the first run, and V18 and V20 the second: the
// tests that existed injected SYNCHRONOUS fakes, and a synchronous fake behaves
// the same with or without `await`. Every one was closed by a test with an async
// fake, the shape production has. That is the general risk of this change, and
// the reason the (k)–(o) block exists.
//
// NOT COVERED: writeBrowserPidFile's awaits (adapters/browser-agent/index.js).
// It runs only inside a real Playwright launch and writes the repo-root pid file,
// so no test drives it; a missing await there would write "[object Promise]" to
// that file. The derived guard (a) still covers it for synchronous calls.
//
// A HAZARD FOUND WHILE PROVING THIS, 2026-09-23: the red-first run of (h)/(i)
// against the OLD code, which has no seam, started a REAL edge-tts server from
// the test process and hung until that process tree was killed. The seam is what
// makes these tests safe to run at all.
