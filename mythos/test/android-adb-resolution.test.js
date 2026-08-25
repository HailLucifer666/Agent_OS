'use strict';

// test/android-adb-resolution.test.js — BUG-360 (2026-08-26).
//
// THE BUG. All 14 phone_* tools were dead on a machine with adb installed in TWO
// places. `ANDROID_ADB_BIN`'s schema default is the bare string 'adb'; src/main.js
// passes it to startAndroidChild(); the adapter used it verbatim; spawnSync did a
// PATH lookup; adb is not on PATH and never is, because setup-android.js
// --install unpacks INSIDE the project on purpose rather than touching the
// machine. The probe ENOENT'd, the adapter went OFFLINE, and
// buildCapabilitySnapshot() then withheld every phone_* tool as UNAVAILABLE — so
// the model was told the tools did not EXIST rather than that they had failed.
// That is why it read as a missing feature instead of a defect.
//
// The second half was in setup-android.js: --install WRITES to
// <userData>/tools when Electron injects MYTHOS_TOOLS_DIR and to the repo
// otherwise, but resolution READ from only whichever of those two the current
// process happened to select. A dev run could not see a packaged install's adb,
// and a packaged run could not see a dev checkout's. doctor.js already records
// this exact defect and its fix for the build engine ("Both sides search
// userData/tools (MYTHOS_TOOLS_DIR) first and the repo second"), and
// setup-dsh.js's dshSearchHomes() is the shape both now follow.
//
// WHY THESE TESTS AND NOT OTHERS. Every case below injects its own temp
// directories and its own env object. Nothing here asks whether THIS machine has
// adb installed — that premise is what broke test/setup-android.test.js's
// resolveAdbBin case on 2026-08-10, when a concurrent session ran --install
// mid-suite and "adb.exe exists" flipped between runs. A machine-state assertion
// fails for good the moment the machine changes, and it presents as a flake.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setupAndroid = require('../scripts/setup-android.js');
const androidChild = require('../adapters/android-child');

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

// Build a fake install tree: <root>/Android Platform Tools/platform-tools/adb*.
// Returns the root, i.e. what MYTHOS_TOOLS_DIR would be set to.
function fakeToolsDir(label, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-' + label + '-'));
  if (options && options.withAdb) {
    const dir = path.join(root, 'Android Platform Tools', 'platform-tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ADB_EXE), 'not a real binary');
  }
  return root;
}

describe('BUG-360: adb resolution searches every install location', () => {
  it('searches userData/tools FIRST and the repo SECOND, and lists both', () => {
    const tools = fakeToolsDir('order');
    const dirs = setupAndroid.androidSearchDirs({ MYTHOS_TOOLS_DIR: tools });

    assert.equal(dirs.length, 2, 'exactly two locations: userData/tools, then the repo');
    assert.equal(dirs[0], path.join(tools, 'Android Platform Tools'),
      'userData/tools must be searched first — it is the one an update does not delete');
    assert.equal(dirs[1], path.join(setupAndroid.REPO_ROOT(), 'Android Platform Tools'),
      'the repo location must stay in the list forever, or a dev checkout is told to reinstall');
  });

  it('still searches the repo when Electron injected no tools dir (a dev run)', () => {
    const dirs = setupAndroid.androidSearchDirs({});
    assert.deepEqual(dirs, [path.join(setupAndroid.REPO_ROOT(), 'Android Platform Tools')]);
  });

  it('finds an adb that only the PACKAGED location has — the dev-run blind spot', () => {
    const tools = fakeToolsDir('packaged', { withAdb: true });
    const found = setupAndroid.findInstalledAdb({ MYTHOS_TOOLS_DIR: tools });
    assert.equal(found, path.join(tools, 'Android Platform Tools', 'platform-tools', ADB_EXE));
  });

  it('finds an adb that only the REPO location has while pointed at an empty tools dir — the packaged-run blind spot', () => {
    // The repo copy is whatever this checkout really has, so this case asserts
    // the FALLBACK happened rather than a specific path: with an empty userData
    // tools dir, resolution must not stop there.
    const emptyTools = fakeToolsDir('empty');
    const repoAdb = path.join(setupAndroid.REPO_ROOT(), 'Android Platform Tools', 'platform-tools', ADB_EXE);
    const found = setupAndroid.findInstalledAdb({ MYTHOS_TOOLS_DIR: emptyTools });

    if (fs.existsSync(repoAdb)) {
      assert.equal(found, repoAdb, 'must fall through the empty tools dir to the repo install');
    } else {
      assert.equal(found, null, 'with adb in neither location the answer is null, never a guessed path');
    }
  });

  it('returns null rather than a plausible path when adb is in neither location', () => {
    const emptyTools = fakeToolsDir('none');
    const nowhere = fakeToolsDir('nowhere');
    // Both search dirs supplied explicitly so this cannot be answered by the
    // real repo install — the point is the shape of the negative answer.
    const found = setupAndroid.findInstalledAdb({}, [
      path.join(emptyTools, 'Android Platform Tools'),
      path.join(nowhere, 'Android Platform Tools'),
    ]);
    assert.equal(found, null,
      'a path that does not exist must never be returned: the caller spawns it next');
  });

  it('ANDROID_ADB_BIN still outranks every install location', () => {
    const tools = fakeToolsDir('override', { withAdb: true });
    const resolved = setupAndroid.resolveAdbBin(null, {
      ANDROID_ADB_BIN: '/explicit/path/to/adb',
      MYTHOS_TOOLS_DIR: tools,
    });
    assert.equal(resolved, '/explicit/path/to/adb');
  });

  it('falls back to the bare PATH command, not to a non-existent file path', () => {
    const emptyTools = fakeToolsDir('path-fallback');
    const resolved = setupAndroid.resolveAdbBin(null, { MYTHOS_TOOLS_DIR: emptyTools });
    const repoAdb = path.join(setupAndroid.REPO_ROOT(), 'Android Platform Tools', 'platform-tools', ADB_EXE);
    if (!fs.existsSync(repoAdb)) {
      assert.equal(resolved, 'adb', 'with nothing installed the answer is the PATH lookup');
    }
    // Whatever it resolved to, it must be spawnable: either the bare command or
    // a file that is really there. Never a constructed path nobody checked.
    assert.equal(resolved === 'adb' || fs.existsSync(resolved), true,
      'resolveAdbBin returned "' + resolved + '", which is neither the PATH command nor an existing file');
  });
});

describe('BUG-360: the adapter resolves instead of trusting the config default', () => {
  it('treats the bare default as "resolve this for me" — the exact value src/main.js passes', () => {
    // This is the whole bug in one assertion. config.ANDROID_ADB_BIN is 'adb' by
    // default, main.js hands that straight over, and the adapter used to spawn it
    // as-is against a PATH that has never contained adb.
    const resolved = androidChild.resolveAdbBin('adb');
    const installed = setupAndroid.findInstalledAdb();
    if (installed) {
      assert.equal(resolved, installed,
        'with adb installed, the bare default must resolve to the real binary, not stay "adb"');
    } else {
      assert.equal(resolved, 'adb', 'with nothing installed it may only fall back to the PATH lookup');
    }
  });

  it('resolves identically when passed nothing at all', () => {
    assert.equal(androidChild.resolveAdbBin(), androidChild.resolveAdbBin('adb'),
      'an absent opts.adbBin and the bare default must take the same path — otherwise the '
      + 'fix covers main.js and silently misses every other caller');
  });

  it('obeys an absolute path verbatim and never second-guesses it', () => {
    // The cost of the 'adb' sentinel is that ONE value is reinterpreted. Pin
    // that the reinterpretation stops there: an operator who set a real path
    // must get that path even when it is wrong, because silently substituting a
    // different binary for the one they named is worse than failing.
    const bogus = path.join(os.tmpdir(), 'definitely-not-installed', 'adb-custom');
    assert.equal(androidChild.resolveAdbBin(bogus), bogus);
  });

  it('startAndroidChild SPAWNS the resolved binary, not the config default it was handed', () => {
    // The wiring assertion, and the one that actually re-fails on the original
    // bug. Testing resolveAdbBin() alone is not enough: a helper can be correct
    // while start() ignores it, which is precisely the shape of the defect —
    // resolution logic existed in setup-android.js the whole time and the boot
    // path never called it. The versionProbe seam reports the binary that would
    // have been spawned, so this needs no adb and no particular machine.
    const installed = setupAndroid.findInstalledAdb();
    let spawnedWith = null;
    androidChild.startAndroidChild({
      adbBin: 'adb', // exactly what src/main.js passes from config.ANDROID_ADB_BIN
      versionProbe: (bin) => { spawnedWith = bin; return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }; },
    });
    try {
      if (installed) {
        assert.equal(spawnedWith, installed,
          'the bare config default must be resolved to the installed binary BEFORE the probe; '
          + 'spawning "adb" is the original bug');
        assert.notEqual(spawnedWith, 'adb');
      } else {
        assert.equal(spawnedWith, 'adb', 'with nothing installed the PATH lookup is all that is left');
      }
    } finally {
      androidChild.shutdownAndroidChild();
    }
  });

  it('the two DEFAULT_ADB_BIN constants agree', () => {
    // The adapter compares opts.adbBin against ITS copy of 'adb' while
    // setup-android.js falls back to its own. If they ever diverge the sentinel
    // stops matching and this bug returns in full, with no test failing —
    // the comment in each file promises they are kept in sync, so pin it.
    assert.equal(androidChild.DEFAULT_ADB_BIN, setupAndroid.DEFAULT_ADB_BIN);
    assert.equal(androidChild.DEFAULT_ADB_BIN, 'adb');
  });

  it('a bare command is not the install-tree filename on Windows', () => {
    // Adjacent trap: ADB_EXE is 'adb.exe' on Windows but the PATH command stays
    // 'adb'. Spawning 'adb.exe' would miss a PATH entry; probing for 'adb' as a
    // filename would miss the real binary. Pin that the fallback is the command.
    assert.equal(setupAndroid.DEFAULT_ADB_BIN, 'adb',
      'the PATH fallback must be the bare command on every platform, .exe included');
  });
});

describe('BUG-360: an OFFLINE adapter says which adb it could not find', () => {
  it('names the resolved path in the hint when one was resolved', () => {
    const bogus = path.join(os.tmpdir(), 'definitely-not-installed', 'adb-custom');
    androidChild.startAndroidChild({ adbBin: bogus });
    const status = androidChild.getStatus();
    try {
      assert.equal(status.state, 'OFFLINE');
      assert.ok(status.hint.indexOf(bogus) !== -1,
        'the hint must name the path that failed, got: ' + status.hint);
      assert.ok(status.hint.indexOf('setup-android.js --install') !== -1,
        'and must still name the recovery step, got: ' + status.hint);
    } finally {
      androidChild.shutdownAndroidChild();
    }
  });
});
