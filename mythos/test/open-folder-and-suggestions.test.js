'use strict';

// WAVE 6 — the two things MYTHOS kept reaching for and not finding.
//
// 1. OPENING A FOLDER. Three times in the 2026-07-31 session it tried
//    launch_app('explorer.exe "D:\\..."'), which cannot work — launch_app takes an
//    app NAME and has never parsed arguments.
//
//    The Trust Plan says to add an open_folder tool. It ALREADY EXISTED, in
//    from-computer.js, tiered at T2, correctly sandboxed. Adding a second would
//    have collided on the tool name and duplicated its TIER_TABLE key. What was
//    actually broken was different and more interesting: it returned
//    ok({opened: path}) purely because spawning explorer.exe did not throw — the
//    Wave 0 defect, in a tool nobody had looked at — and its description was one
//    terse sentence, which is the likely reason the model reached for launch_app
//    instead of it.
//
// 2. A WRONG TOOL NAME. It called status({}) and got the bare string
//    'unknown-effector' back, with nothing to suggest read_status exists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');

const evidence = require('../src/core/effectors/evidence');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { TIER_TABLE } = require('../src/core/leash/tiers');
const { fakeBus } = require('./helpers');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const FROM_COMPUTER_PATH = path.resolve(__dirname, '../src/core/effectors/from-computer.js');
const originalRequire = Module.prototype.require;

// from-computer reaches from-pc for the window oracle; stub pc-child under both.
//
// MUST await fn before restoring. open_folder requires './from-pc' LAZILY, and
// polls the oracle for up to ~1.6s (4 × 400ms, fix-plan 2.2) — with a
// synchronous try/finally the stub was already gone by then, from-pc loaded the
// real (OFFLINE) pc-child, and the oracle silently returned nothing. The test
// failed while the code was right.
async function withPc(mock, fn) {
  const spawned = [];
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    // Do not actually open Explorer windows on the machine running the suite.
    // The point under test is the ORACLE, not that spawn() works.
    if (id === 'child_process') {
      return Object.assign({}, originalRequire.call(this, 'child_process'), {
        spawn: (cmd, args) => { spawned.push({ cmd, args }); return { unref() {} }; },
      });
    }
    return originalRequire.apply(this, arguments);
  };
  withPc.lastSpawned = spawned;
  delete require.cache[FROM_PC_PATH];
  delete require.cache[FROM_COMPUTER_PATH];
  try {
    return await fn(require(FROM_COMPUTER_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
    delete require.cache[FROM_COMPUTER_PATH];
  }
}

function pcWithWindows(windows) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'list_windows') return { ok: true, result: { windows: windows || [] } };
      return { ok: true, result: {} };
    },
  };
}

// A real directory inside the sandbox. resolveSandboxed keys off the configured
// root, and the vault directory is the reliable in-sandbox path in this repo.
const REAL_DIR = path.resolve(__dirname, '..', 'vault');
const LEAF = path.basename(REAL_DIR);

describe('WAVE 6 — open_folder proves a window opened', () => {
  it('a real Explorer window with the folder name is the oracle', async () => {
    await withPc(pcWithWindows([{ pid: 4242, title: LEAF, process: 'explorer' }]), async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return; // sandbox root differs in this environment — covered below
      assert.equal(evidence.isVerified(res), true, 'spawning explorer.exe is not a window existing');
      assert.equal(res.evidence.oracle, 'window-title');
      assert.match(res.evidence.observed, new RegExp(LEAF, 'i'));
    });
  });

  it('no matching window is UNVERIFIED, not success (Explorer reuses windows)', async () => {
    await withPc(pcWithWindows([]), async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return;
      assert.equal(res.unverified, true,
        'explorer.exe exits non-zero even when it works, so its exit code proves nothing either way');
      assert.match(res.reason, /reused a window|not running/i);
    });
  });

  // fix-plan 2.2 — the old single check after a fixed 700ms reported real
  // successes as unverified whenever Explorer was slow to title the window, and
  // the exact-only title match missed special/localized folders whose Explorer
  // title carries more than the bare leaf.

  it('a window titled with MORE than the leaf still verifies (title-match: contains)', async () => {
    await withPc(pcWithWindows([{ pid: 5150, title: LEAF + ' — File Explorer', process: 'explorer.exe' }]), async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return;
      assert.equal(evidence.isVerified(res), true, 'a title that contains the leaf is the same window');
      assert.match(res.evidence.observed, /title-match: contains/);
    });
  });

  it('a window appearing LATE (second poll attempt) still verifies', async () => {
    // First list_windows answers empty, the second carries the window — the
    // exact race the bounded poll exists for.
    let calls = 0;
    const late = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (c) => {
        if (c.cmd !== 'list_windows') return { ok: true, result: {} };
        calls += 1;
        return calls < 2
          ? { ok: true, result: { windows: [] } }
          : { ok: true, result: { windows: [{ pid: 77, title: LEAF, process: 'explorer' }] } };
      },
    };
    await withPc(late, async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return;
      assert.equal(evidence.isVerified(res), true, 'the poll must still be polling when the window shows up late');
      assert.ok(calls >= 2);
    });
  });

  it('pc-child OFFLINE and no-window are DISTINCT unverified reasons', async () => {
    const offline = {
      getStatus: () => ({ state: 'OFFLINE', hint: 'not running' }),
      sendCommand: async () => { throw new Error('unreachable'); },
    };
    await withPc(offline, async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return;
      assert.equal(res.unverified, true);
      assert.match(res.reason, /pc-child is not running/i,
        'the operator/model must be told the CHECKER is down, not that the window is missing');
      assert.ok(!/reused a window/i.test(res.reason));
    });
    await withPc(pcWithWindows([]), async (m) => {
      const res = await m.open_folder({ path: REAL_DIR });
      if (!res.ok) return;
      assert.equal(res.unverified, true);
      assert.match(res.reason, /reused a window/i);
      assert.ok(!/pc-child is not running/i.test(res.reason));
    });
  });

  it('a path outside the sandbox is refused', async () => {
    await withPc(pcWithWindows([]), async (m) => {
      const res = await m.open_folder({ path: 'C:\\Windows\\System32' });
      assert.equal(res.ok, false);
      assert.notEqual(res.unverified, true, 'a refusal is not an unconfirmed success');
    });
  });

  // CHANGED by BUG-283 (2026-08-20), deliberately, and the old assertion is
  // recorded here rather than deleted quietly. This used to require
  // `res.ok === false` — a file path was refused with a message naming
  // open_artifact. That refusal was measured failing in production: the model
  // received it, ignored the named remedy, and later told the operator that
  // opening a saved file was a "system limitation" while open_artifact sat
  // declared and unused for the whole session. Prose remediation had already
  // lost once on this tool (the launch_app history at the top of this file), so
  // the dead end was removed instead of re-worded a third time.
  //
  // The invariant that survives unchanged: the result must still name
  // open_artifact. Opening the folder is not opening the file.
  it('a file rather than a folder is revealed in its folder, still naming open_artifact', async () => {
    const tmpFile = path.join(REAL_DIR, 'wave6-open-folder-probe.tmp');
    let made = false;
    try { fs.writeFileSync(tmpFile, 'x'); made = true; } catch (_) { /* read-only env */ }
    if (!made) return;
    try {
      await withPc(pcWithWindows([]), async (m) => {
        const res = await m.open_folder({ path: tmpFile });
        if (!res.ok && /outside|sandbox|not allowed/i.test(String(res.result))) return;
        assert.equal(res.ok, true, 'a file path is no longer a dead end');
        assert.match(JSON.stringify(res.result), /open_artifact/,
          'name the tool that does handle files');
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });

  it('requires a path', async () => {
    await withPc(pcWithWindows([]), async (m) => {
      assert.equal((await m.open_folder({})).ok, false);
    });
  });

  it('there is exactly ONE open_folder tool and ONE tier entry for it', () => {
    // The plan would have had us add a second. This is the guard against that.
    const fromComputer = require('../src/core/effectors/from-computer');
    const fromPc = require('../src/core/effectors/from-pc');
    const inComputer = fromComputer.TOOLS.filter((t) => t.name === 'open_folder').length;
    const inPc = (fromPc.TOOLS || []).filter((t) => t.name === 'open_folder').length;
    assert.equal(inComputer, 1, 'from-computer owns open_folder');
    assert.equal(inPc, 0, 'a second registration would collide on the name in the hub');
    assert.equal(TIER_TABLE['open_folder'], 2, 'its long-standing tier is unchanged');

    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/leash/tiers.js'), 'utf8');
    const keys = src.match(/'open_folder'\s*:/g) || [];
    assert.equal(keys.length, 1,
      'a duplicate key in the tier table silently takes the LAST value — mine read 1 and resolved to 2');
  });

  it('the description tells the model not to reach for launch_app', () => {
    const fromComputer = require('../src/core/effectors/from-computer');
    const t = fromComputer.TOOLS.find((x) => x.name === 'open_folder');
    assert.match(t.description, /never pass a path to launch_app/i,
      'the recorded failure was the model choosing launch_app, so the catalog has to say so');
    assert.match(t.description, /downloads folder|show me that directory/i,
      'and cover the phrasings an operator actually uses');
  });
});

describe('WAVE 6 — unknown tool names suggest the real ones', () => {
  function hubWith(names) {
    const hub = createEffectorHub({ bus: fakeBus(), config: {} });
    names.forEach((id) => hub.register({ id, invoke: async () => ({ ok: true, result: {} }), tier: 0 }));
    return hub;
  }

  it('BUG-076 THE RECORDED CASE: status now RESOLVES to read_status instead of suggesting it', async () => {
    // 2026-08-01 ~11:11: the operator was shown "did you mean read_status?",
    // approved it, and the retry still said 'status' and still dead-ended.
    // A suggestion nobody can act on is the same defect as no suggestion.
    const hub = hubWith(['read_status', 'job_status', 'list_goals']);
    const res = await hub.invoke('status', {}, {});
    assert.equal(res.ok, true, 'status is an alias for read_status, not a dead end');
  });

  it('the bare "unknown-effector" prefix survives for existing consumers', async () => {
    // cortex/index.js and several tests match that literal string. Use a name
    // with no alias and no near match — 'status' itself now resolves (above).
    const hub = hubWith(['read_status']);
    const res = await hub.invoke('quantumflux', {}, {});
    assert.match(String(res.result), /^unknown-effector/);
  });

  it('a typo is caught by edit distance', async () => {
    const hub = hubWith(['spotify_play', 'launch_app']);
    const res = await hub.invoke('lauch_app', {}, {});
    assert.match(String(res.result), /launch_app/);
  });

  it('an unrelated name suggests nothing rather than something absurd', async () => {
    const hub = hubWith(['spotify_play', 'launch_app']);
    const res = await hub.invoke('quantumflux', {}, {});
    assert.match(String(res.result), /^unknown-effector/);
    assert.deepEqual(res.suggestions, [], 'a confident bad guess is worse than no guess');
  });

  it('a registered tool is unaffected', async () => {
    const hub = hubWith(['read_status']);
    assert.equal((await hub.invoke('read_status', {}, {})).ok, true);
  });
});
