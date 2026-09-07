'use strict';

// BUG-288 — the adopted local search daemon was never started by anything.
//
// WHAT WAS OBSERVED (operator's audit vault, 2026-08-20, and reproduced on the
// same machine the next day). BUG-280 adopted open-webSearch, shipped the rung
// that queries it, wrote the fixture from a real daemon, and left the install
// and launch in a commented-out block of .env.example. Eight `web_search` calls
// that evening all returned ok, and every one was answered by the LAST rung in
// the chain — Wikipedia:
//
//   "Durand Cup East Bengal vs Mohun Bagan result August 20 2026"
//     -> en.wikipedia.org/wiki/Durand_Cup (the 2023 final)
//   "Kolkata news today" -> en.wikipedia.org/wiki/Kolkata (the city article)
//
// Every other rung was measured dead the same day: exa has no key, exa-mcp is
// 429, jina answers 401, and BOTH DuckDuckGo hosts now serve HTTP 202 with
// "Select all squares containing a duck" — a CAPTCHA, i.e. a deliberate refusal
// that is to be respected rather than worked around. That leaves the daemon as
// the only keyless path, and nothing ever started it.
//
// So these tests pin the LIFECYCLE, not the search: that the sidecar is honest
// when the daemon is absent, that it launches the daemon the one way that
// actually serves POST /search, and that its port cannot drift away from the
// URL the rung will fetch.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHILD = require.resolve('../src/core/effectors/websearch-child.js');

// A temp file standing in for an installed daemon. AD-7: derived from
// os.tmpdir(), never a path literal — and it is a fake entry precisely so no
// test ever has to move the operator's real install aside to fake a state.
function fakeEntry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-websearch-'));
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, '// not executed by these tests\n');
  return file;
}

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (event, data) => lines.push({ level: 'info', event, data }),
    warn: (event, data) => lines.push({ level: 'warn', event, data }),
  };
}

// The module destructures `spawn` at require time, so the stub has to be in
// place BEFORE it loads — and the module cache cleared after, or the next test
// silently gets this stub. Stubbing here rather than adding a deps seam to
// production: an optional `deps.spawn || spawn` is the shape that has switched
// this repo onto incomplete fakes before.
function withStubbedSpawn(fn) {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  const calls = [];
  cp.spawn = function (cmd, args, opts) {
    calls.push({ cmd, args, opts });
    return {
      on() {},
      kill() { calls.push({ killed: true }); },
    };
  };
  delete require.cache[CHILD];
  try {
    return fn(require(CHILD), calls);
  } finally {
    cp.spawn = realSpawn;
    delete require.cache[CHILD];
  }
}

// start() refuses under the test runner (same rule as its siblings), so the
// spawn-path tests have to clear that flag and put it back.
function asNonTestRun(fn) {
  const saved = {
    ctx: process.env.NODE_TEST_CONTEXT,
    env: process.env.NODE_ENV,
    entry: process.env.WEB_SEARCH_LOCAL_ENTRY,
    url: process.env.WEB_SEARCH_LOCAL_URL,
    autostart: process.env.WEB_SEARCH_LOCAL_AUTOSTART,
  };
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_ENV;
  delete process.env.WEB_SEARCH_LOCAL_URL;
  delete process.env.WEB_SEARCH_LOCAL_AUTOSTART;
  try {
    return fn();
  } finally {
    for (const [k, v] of [
      ['NODE_TEST_CONTEXT', saved.ctx], ['NODE_ENV', saved.env],
      ['WEB_SEARCH_LOCAL_ENTRY', saved.entry], ['WEB_SEARCH_LOCAL_URL', saved.url],
      ['WEB_SEARCH_LOCAL_AUTOSTART', saved.autostart],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// --- the launch command -----------------------------------------------------

test('BUG-288: the daemon is launched with `serve` — without it the entrypoint 404s POST /search', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      const child = mod.createWebSearchChild({ logger: capturingLogger(), config: {} });
      assert.equal(child.start(), true);
      assert.equal(calls.length, 1);
      // Measured 2026-08-21: the bare entrypoint starts the MCP server on the
      // same port (GET/POST /mcp, /sse) and answers POST /search with an
      // Express 404 page. A daemon that is up, healthy and useless.
      assert.ok(calls[0].args.includes('serve'),
        'launch args must include the `serve` subcommand, got: ' + JSON.stringify(calls[0].args));
    });
  });
});

test('BUG-288: the daemon is bound to loopback explicitly, never left to its default', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      mod.createWebSearchChild({ logger: capturingLogger(), config: {} }).start();
      const args = calls[0].args;
      const hostAt = args.indexOf('--host');
      assert.ok(hostAt >= 0, 'must pass --host');
      assert.equal(args[hostAt + 1], '127.0.0.1');
    });
  });
});

test('BUG-288: the child is spawned as node, not as a second Electron app', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      mod.createWebSearchChild({ logger: capturingLogger(), config: {} }).start();
      // process.execPath is Electron in the packaged app. Spawning it without
      // this launches a second MYTHOS instead of the daemon.
      assert.equal(calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(calls[0].opts.shell, false);
    });
  });
});

// --- the port cannot drift from the rung ------------------------------------
test('BUG-404: relative daemon override keeps the same file after child cwd changes', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      const entry = fakeEntry();
      try {
        process.env.WEB_SEARCH_LOCAL_ENTRY = path.relative(process.cwd(), entry);
        const child = mod.createWebSearchChild({ logger: capturingLogger(), config: {} });
        assert.equal(child.start(), true);
        assert.equal(calls[0].args[0], entry);
        assert.ok(path.isAbsolute(calls[0].opts.cwd));
        assert.notEqual(calls[0].opts.cwd, path.dirname(CHILD));
        assert.equal(fs.readFileSync(calls[0].args[0], 'utf8'), '// not executed by these tests\n');
        child.stop();
      } finally {
        fs.rmSync(path.dirname(entry), { recursive: true, force: true });
      }
    });
  });
});

test('BUG-288: the daemon port is DERIVED from the URL the rung fetches', () => {
  const mod = require(CHILD);
  assert.equal(mod._resolvePort({ WEB_SEARCH_LOCAL_URL: 'http://127.0.0.1:3456' }), 3456);
  assert.equal(mod._resolvePort({}), mod._defaultPort);
});

test('BUG-288: config and env agree on the port, and the spawn uses it', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      process.env.WEB_SEARCH_LOCAL_URL = 'http://127.0.0.1:3999';
      mod.createWebSearchChild({ logger: capturingLogger(), config: {} }).start();
      const args = calls[0].args;
      assert.equal(args[args.indexOf('--port') + 1], '3999');
    });
  });
});

test('BUG-288: one number, two readers — the sidecar and the search rung resolve the same port', () => {
  // This is the invariant the whole derivation exists for. Two independent
  // settings for one port is how a healthy daemon and a rung that cannot reach
  // it coexist, each looking fine on its own.
  const mod = require(CHILD);
  const rung = require('../src/core/effectors/web-search.js');
  const saved = process.env.WEB_SEARCH_LOCAL_URL;
  try {
    for (const url of ['http://127.0.0.1:3100', 'http://127.0.0.1:3456', 'http://localhost:8123']) {
      process.env.WEB_SEARCH_LOCAL_URL = url;
      const resolved = rung._resolveLocalSearchUrl();
      assert.equal(resolved.ok, true, url + ' should be accepted by the rung');
      assert.equal(new URL(resolved.url).port, String(mod._resolvePort({})),
        'sidecar and rung disagree about the port for ' + url);
    }
  } finally {
    if (saved === undefined) delete process.env.WEB_SEARCH_LOCAL_URL; else process.env.WEB_SEARCH_LOCAL_URL = saved;
  }
});

test('BUG-288: a malformed URL falls back to the default instead of crashing the sidecar', () => {
  const mod = require(CHILD);
  // The rung refuses this value BY NAME. The sidecar must not pre-empt that
  // report by dying first — the operator needs to be told what is wrong.
  assert.equal(mod._resolvePort({ WEB_SEARCH_LOCAL_URL: 'not a url' }), mod._defaultPort);
  assert.equal(mod._resolvePort({ WEB_SEARCH_LOCAL_URL: 'http://127.0.0.1:999999' }), mod._defaultPort);
  assert.equal(mod._resolvePort({ WEB_SEARCH_LOCAL_URL: 'http://127.0.0.1' }), mod._defaultPort);
});

// --- honest absence ---------------------------------------------------------

test('BUG-288: an absent install is reported by name, with the command that fixes it', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      // An override pointing nowhere is the one case that must NOT fall back to
      // the real candidates — otherwise this assertion would pass or fail
      // depending on whether the machine running it happens to have the daemon.
      process.env.WEB_SEARCH_LOCAL_ENTRY = path.join(os.tmpdir(), 'mythos-websearch-absent', 'index.js');
      const logger = capturingLogger();
      const child = mod.createWebSearchChild({ logger, config: {} });
      assert.equal(child.start(), false);
      assert.equal(calls.length, 0, 'nothing may be spawned when the daemon is not installed');
      const warned = logger.lines.find((l) => l.event === 'websearch.entry-missing');
      assert.ok(warned, 'must warn by name, got: ' + JSON.stringify(logger.lines));
      assert.ok(String(warned.data.entry).length > 0);
    });
  });
});

test('BUG-288: a directory where the entry should be is refused, not treated as installed', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      // statSync SUCCEEDS on a directory — only isFile() separates it from a real
      // entry. Getting that wrong would spawn node against a directory and report
      // the daemon as started.
      const logger = capturingLogger();
      process.env.WEB_SEARCH_LOCAL_ENTRY = os.tmpdir();
      const child = mod.createWebSearchChild({ logger, config: {} });
      assert.equal(child.start(), false);
      assert.equal(calls.length, 0);
      assert.ok(logger.lines.some((l) => l.event === 'websearch.entry-missing'),
        'got: ' + JSON.stringify(logger.lines));
    });
  });
});

test('BUG-288: the not-installed warning names the command that fixes it', () => {
  // Asserted against the source rather than by running it: the branch only fires
  // on a machine with no daemon installed anywhere, and the alternative — moving
  // the operator's real install aside to reach it — is the destructive test
  // pattern this repo already lost its wake-word weights to.
  const src = fs.readFileSync(CHILD, 'utf8');
  const block = /websearch\.not-installed'[^)]*\)/s.exec(src);
  assert.ok(block, 'websearch.not-installed warning not found in the sidecar');
  assert.ok(block[0].includes('setup-websearch.js --install'),
    'the warning must name the install command, got: ' + block[0]);
});

test('BUG-288: the sidecar never starts under the test runner', () => {
  withStubbedSpawn((mod, calls) => {
    process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
    const savedCtx = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = 'test';
    try {
      const child = mod.createWebSearchChild({ logger: capturingLogger(), config: {} });
      assert.equal(child.start(), false);
      assert.equal(calls.length, 0);
    } finally {
      if (savedCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = savedCtx;
      delete process.env.WEB_SEARCH_LOCAL_ENTRY;
    }
  });
});

test('BUG-288: WEB_SEARCH_LOCAL_AUTOSTART=false leaves the daemon to the operator', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      process.env.WEB_SEARCH_LOCAL_AUTOSTART = 'false';
      const child = mod.createWebSearchChild({ logger: capturingLogger(), config: {} });
      assert.equal(child.start(), false);
      assert.equal(calls.length, 0);
    });
  });
});

test('BUG-288: stop() kills the child and isRunning() stops claiming it is up', () => {
  withStubbedSpawn((mod, calls) => {
    asNonTestRun(() => {
      process.env.WEB_SEARCH_LOCAL_ENTRY = fakeEntry();
      const child = mod.createWebSearchChild({ logger: capturingLogger(), config: {} });
      child.start();
      assert.equal(child.isRunning(), true);
      child.stop();
      assert.ok(calls.some((c) => c.killed), 'stop() must kill the spawned child');
      assert.equal(child.isRunning(), false);
    });
  });
});

// --- portability ------------------------------------------------------------

test('BUG-288: install candidates are derived from __dirname, not written as literals (AD-7)', () => {
  const mod = require(CHILD);
  const repoRoot = path.join(__dirname, '..', '..');
  for (const candidate of mod._entryCandidates()) {
    assert.ok(path.isAbsolute(candidate), 'candidates resolve to absolute paths at runtime');
    assert.ok(path.resolve(candidate).startsWith(path.resolve(repoRoot)),
      'candidate must live inside the repo, got ' + candidate);
  }
});

test('BUG-288: main.js wires the sidecar into boot AND into shutdown', () => {
  // A sidecar that boots and is never stopped leaves an orphan holding a port
  // after MYTHOS exits — the BUG-029 failure mode, and the reason the other two
  // children are stopped explicitly.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(main.includes("require('./core/effectors/websearch-child')"), 'main.js must require the sidecar');
  assert.ok(/webSearchChild\s*=\s*createWebSearchChild\(/.test(main), 'main.js must construct it');
  assert.ok(/webSearchChild\.start\(\)/.test(main), 'main.js must start it');
  assert.ok(/webSearchChild\.stop\(\)/.test(main), 'main.js must stop it on shutdown');
});

test('BUG-288: the setup script and the sidecar look for the daemon in the same place', () => {
  // These are two files that each compute an install path. They agreeing is the
  // whole point: an installer that writes somewhere the runtime does not read is
  // exactly the shape of the bug this fixes.
  const setup = require('../scripts/setup-websearch.js');
  const mod = require(CHILD);
  assert.ok(mod._entryCandidates().includes(setup.ENTRY),
    'setup-websearch.js installs to ' + setup.ENTRY + ', which is not in the sidecar candidate list');
  assert.equal(setup.DEFAULT_PORT, mod._defaultPort);
});
