'use strict';

// test/reinstall-asks-again.test.js — the two things a reinstall/update kept
// asking for that the operator had already done (2026-08-12).
//
//   "every time after a fresh install it is giving the prompt to store the API keys"
//   "when updating it's asking me for the same things — the phone install, the
//    Hermes install. Those are already installed."
//
// Three separate defects, all measured on the operator's machine rather than
// reasoned about:
//
// 1. KEYS ORPHANED BY A RENAME. app.setName('MYTHOS') moved userData from
//    %APPDATA%\agent-os to %APPDATA%\MYTHOS. adoptSiblingVault carried the VAULT
//    across; keys.json sits directly in userData and was left behind. Measured:
//    a 1,309-byte keys.json in agent-os, none in MYTHOS, and the packaged
//    /api/setup/status reporting "none of: GOOGLE_API_KEY, GROQ_API_KEY, …" with
//    needsSetup:true, which is what puts the wizard over the HUD.
//
// 2. HERMES DELIVERED WHERE UPDATES DELETE. setup-hermes.js installed into
//    <repo>/Hermes Agent, and for a packaged install <repo> is inside the
//    install tree — the NSIS updater removes it wholesale (23,283 files,
//    measured). doctor.js restated that one path by hand, so it also could not
//    see an install anywhere else.
//
// 3. THE INSTALLER ASKED WITHOUT LOOKING. build/installer.nsh hardcoded every
//    checkbox default and never touched the disk, and its update-path fallback
//    wrote silero:true/wakeword:true unconditionally — queueing re-downloads of
//    assets already present, with no page shown and nothing asked.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  adoptSiblingFile,
  adoptSiblingUserDataFiles,
  rankSiblingFiles,
  ORPHANED_USERDATA_FILES,
} = require('../../electron/vault-migration');
const hermes = require('../scripts/setup-hermes.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-reinstall-')); }
function write(file, text, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

describe('1. keys.json survives the userData rename', () => {
  it('adopts the key store from the sibling directory the rename orphaned', () => {
    const parent = tmpDir();
    const userData = path.join(parent, 'MYTHOS');
    write(path.join(parent, 'agent-os', 'keys.json'), '{"GOOGLE_API_KEY":"encrypted-blob"}');
    fs.mkdirSync(userData, { recursive: true });

    const results = adoptSiblingUserDataFiles({
      userDataDir: userData,
      siblingUserDataNames: ['agent-os', 'Electron'],
    });

    assert.equal(results['keys.json'].status, 'adopted');
    assert.equal(
      fs.readFileSync(path.join(userData, 'keys.json'), 'utf8'),
      '{"GOOGLE_API_KEY":"encrypted-blob"}',
    );
  });

  it('config.json comes across too — the same rename orphaned both', () => {
    assert.deepEqual(ORPHANED_USERDATA_FILES, ['keys.json', 'config.json']);
    const parent = tmpDir();
    const userData = path.join(parent, 'MYTHOS');
    // Built from tmpdir, never a literal drive letter. AD-7 scans TRACKED files
    // for machine-specific absolute paths and reads comments as well as code, so
    // even a throwaway fixture path written out in full blocks the commit the
    // moment the file is staged — which is why it passed before `git add` and
    // failed inside the pre-commit hook.
    const fakeCli = path.join(os.tmpdir(), 'hermes.exe');
    write(path.join(parent, 'agent-os', 'config.json'), JSON.stringify({ HERMES_CLI: fakeCli }));

    const results = adoptSiblingUserDataFiles({ userDataDir: userData, siblingUserDataNames: ['agent-os'] });

    assert.equal(results['config.json'].status, 'adopted');
    assert.equal(results['keys.json'].status, 'no-candidate', 'each file is judged on its own');
  });

  it('NEVER overwrites a key store this install already has', () => {
    // The failure mode worse than the re-prompt: clobbering keys the operator
    // just entered with an older copy from a directory they abandoned.
    const parent = tmpDir();
    const userData = path.join(parent, 'MYTHOS');
    write(path.join(userData, 'keys.json'), '{"NEW":"current"}');
    write(path.join(parent, 'agent-os', 'keys.json'), '{"OLD":"stale"}');

    const results = adoptSiblingUserDataFiles({ userDataDir: userData, siblingUserDataNames: ['agent-os'] });

    assert.equal(results['keys.json'].status, 'dest-present');
    assert.equal(fs.readFileSync(path.join(userData, 'keys.json'), 'utf8'), '{"NEW":"current"}');
  });

  it('is one-time: a marker stops it re-adopting over a store the operator later cleared', () => {
    const parent = tmpDir();
    const userData = path.join(parent, 'MYTHOS');
    write(path.join(parent, 'agent-os', 'keys.json'), '{"A":"1"}');

    assert.equal(adoptSiblingUserDataFiles({ userDataDir: userData, siblingUserDataNames: ['agent-os'] })['keys.json'].status, 'adopted');
    fs.rmSync(path.join(userData, 'keys.json'));
    assert.equal(adoptSiblingUserDataFiles({ userDataDir: userData, siblingUserDataNames: ['agent-os'] })['keys.json'].status, 'already-done');
    assert.equal(fs.existsSync(path.join(userData, 'keys.json')), false, 'a deliberate reset stays reset');
  });

  it('newest wins, not biggest — a bigger key store can be an older one', () => {
    const parent = tmpDir();
    const userData = path.join(parent, 'MYTHOS');
    write(path.join(parent, 'Electron', 'keys.json'), '{"lots":"of","old":"keys","padding":"xxxxxxxxxxxxxxxxxxxx"}', 1_600_000_000_000);
    write(path.join(parent, 'agent-os', 'keys.json'), '{"new":"1"}', 1_700_000_000_000);

    const results = adoptSiblingUserDataFiles({ userDataDir: userData, siblingUserDataNames: ['agent-os', 'Electron'] });

    assert.equal(results['keys.json'].status, 'adopted');
    assert.match(results['keys.json'].from, /agent-os/);
  });

  it('a genuinely new machine reports no-candidate instead of failing', () => {
    const parent = tmpDir();
    const results = adoptSiblingUserDataFiles({
      userDataDir: path.join(parent, 'MYTHOS'),
      siblingUserDataNames: ['agent-os', 'Electron'],
    });
    assert.equal(results['keys.json'].status, 'no-candidate');
    assert.equal(results['config.json'].status, 'no-candidate');
  });

  it('an empty sibling file is not a candidate — it would adopt nothing over nothing', () => {
    const parent = tmpDir();
    write(path.join(parent, 'agent-os', 'keys.json'), '');
    const { winner } = rankSiblingFiles([path.join(parent, 'agent-os', 'keys.json')]);
    assert.equal(winner, null);
  });

  it('adoption runs before the child is forked, or the keys arrive one launch late', () => {
    // Source-shape: decryptedKeysForChild() reads the store at fork time, so an
    // adoption placed after it would need a second launch to take effect.
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
    const adopt = main.indexOf('adoptSiblingUserDataFiles({');
    // The CALL inside startChild's env spread, not the function definition
    // higher up the file — the definition's position proves nothing.
    const keyRead = main.indexOf('...decryptedKeysForChild(),');
    assert.ok(adopt > 0, 'main.js must call adoptSiblingUserDataFiles');
    assert.ok(keyRead > 0, 'the fork must still inject decrypted keys');
    assert.ok(adopt < keyRead, 'adoption must precede the key read at fork');
  });
});

describe('2. Hermes is delivered where an update cannot erase it', () => {
  it('writes into MYTHOS_TOOLS_DIR when Electron injected one', () => {
    const tools = path.join(os.tmpdir(), 'ud-tools');
    const home = hermes.resolveHermesHome({ MYTHOS_TOOLS_DIR: tools });
    assert.equal(home, path.resolve(path.join(tools, 'Hermes Agent')));
  });

  it('falls back to the repo for a bare dev-checkout run', () => {
    assert.equal(hermes.resolveHermesHome({}), hermes.REPO_HERMES_HOME);
  });

  it('an explicit HERMES_HOME still wins — it is the documented escape hatch', () => {
    const explicit = path.join(os.tmpdir(), 'custom-hermes');
    const home = hermes.resolveHermesHome({ HERMES_HOME: explicit, MYTHOS_TOOLS_DIR: path.join(os.tmpdir(), 'ud-tools') });
    assert.equal(home, path.resolve(explicit));
  });

  it('a READ searches every home, so an install that predates this change is still found', () => {
    const homes = hermes.hermesSearchHomes({ MYTHOS_TOOLS_DIR: path.join(os.tmpdir(), 'ud-tools') });
    assert.ok(homes.some((h) => h.includes('tools')), 'the new location');
    assert.ok(homes.includes(hermes.REPO_HERMES_HOME), 'the pre-2026-08-12 location must stay searchable');
  });

  it('finds a real binary in the userData home', () => {
    const tools = tmpDir();
    const bin = process.platform === 'win32'
      ? path.join(tools, 'Hermes Agent', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
      : path.join(tools, 'Hermes Agent', 'hermes-agent', 'venv', 'bin', 'hermes');
    write(bin, 'binary');

    const found = hermes.findInstalledBinary({ MYTHOS_TOOLS_DIR: tools });
    assert.ok(found, 'an installed Hermes must be detected, or the wizard re-offers it');
    assert.equal(found.bin, bin);
  });

  it('reports nothing when nothing is installed in any searched home', () => {
    // The homes are injected, not derived from env: the repo home is always in
    // the real search list, and THIS machine has Hermes in its dev checkout, so
    // an env-only version of this test would assert the host's state rather than
    // the function's behaviour.
    assert.equal(hermes.findInstalledBinary({}, [tmpDir(), tmpDir()]), null);
  });

  it('doctor asks setup-hermes rather than restating a path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'doctor.js'), 'utf8');
    assert.match(src, /require\('\.\/setup-hermes\.js'\)/);
    assert.match(src, /hermes\.binaryPath\(\)/);
    assert.doesNotMatch(src, /path\.join\(REPO_ROOT, 'Hermes Agent'/,
      'the hand-restated path is what let doctor and the installer disagree');
  });

  it('requiring setup-hermes does not run its probe', () => {
    // doctor.js requires it on every report; an unguarded entry point would
    // spawn a child process each time.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-hermes.js'), 'utf8');
    assert.match(src, /require\.main === module/);
  });
});

describe('3. the installer looks before it asks', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8');

  it('probes the userData paths electron/main.js actually injects', () => {
    assert.match(nsh, /\$APPDATA\\MYTHOS\\models\\silero\\silero_vad\.onnx/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\models\\wakeword\\melspectrogram\.onnx/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\tools\\Hermes Agent/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\tools\\Android Platform Tools\\platform-tools\\adb\.exe/);
  });

  it('requires all three wake-word assets — a partial set must still offer the download', () => {
    const detect = nsh.slice(nsh.indexOf('!macro DetectComponents'), nsh.indexOf('Function mythosComponentsPage'));
    for (const asset of ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx']) {
      assert.ok(detect.includes(asset), `${asset} must be part of the wake-word check`);
    }
    assert.match(detect, /\$\{AndIf\}/, 'all-or-nothing, not any-of');
  });

  it('checks all three legitimate Hermes homes, including HERMES_HOME', () => {
    const detect = nsh.slice(nsh.indexOf('!macro DetectComponents'), nsh.indexOf('Function mythosComponentsPage'));
    assert.match(detect, /ReadEnvStr \$0 "HERMES_HOME"/);
    assert.match(detect, /\$INSTDIR\\resources\\app\.asar\.unpacked\\Hermes Agent/);
  });

  it('shows a found component as installed and disables it rather than hiding it', () => {
    assert.match(nsh, /"Silero VAD — already installed"/);
    assert.match(nsh, /'Wake word "hey jarvis" — already installed'/);
    assert.match(nsh, /"Hermes build agent — already installed"/);
    assert.match(nsh, /"Phone control via adb — already installed"/);
  });

  it('the update path detects before it defaults — this is the one that re-downloaded', () => {
    const install = nsh.slice(nsh.indexOf('!macro customInstall'));
    const detect = install.indexOf('!insertmacro DetectComponents');
    const defaults = install.indexOf('StrCpy $SelSilero "true"');
    assert.ok(detect > 0, 'the silent update path must probe the disk');
    assert.ok(detect < defaults, 'detection must run before the fallback defaults are chosen');
    assert.match(install, /\$\{If\} \$FoundSilero == "1"[\s\S]{0,120}StrCpy \$SelSilero "false"/);
    assert.match(install, /\$\{If\} \$FoundWakeword == "1"[\s\S]{0,120}StrCpy \$SelWakeword "false"/);
  });

  it('the detection macro is defined before both of its call sites', () => {
    // NSIS resolves !insertmacro at parse time — a macro used above its
    // definition is a build failure, and the installer is not covered by any
    // compile step this suite can run.
    const def = nsh.indexOf('!macro DetectComponents');
    assert.ok(def > 0);
    const uses = [...nsh.matchAll(/!insertmacro DetectComponents/g)].map((m) => m.index);
    assert.equal(uses.length, 2, 'the page and the update path both probe');
    for (const use of uses) assert.ok(use > def, 'every use must follow the definition');
  });

  it('defines no macro inside another macro — NSIS forbids it and fails the whole build', () => {
    // Measured 2026-08-12: DetectComponents was defined INSIDE
    // customPageAfterChangeDir, so every installer build died with "can't
    // define a macro inside a macro!" — and the failure mode is the dangerous
    // kind. electron-builder still exited 0 and still left a file called
    // "MYTHOS Setup 0.1.7.exe" in dist/, except it was a 222 KB stub instead of
    // a ~320 MB installer. A release script that trusts the exit code would
    // have published it. The macro-order test above passed throughout.
    const lines = nsh.split('\n');
    let openLine = 0;
    let openName = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const start = /^!macro\s+(\S+)/.exec(line);
      if (start) {
        assert.equal(openLine, 0,
          `!macro ${start[1]} on line ${i + 1} is nested inside !macro ${openName} (line ${openLine}) — ` +
          'NSIS cannot define a macro inside a macro, and the build failure produces a stub .exe, not an error');
        openLine = i + 1;
        openName = start[1];
      } else if (/^!macroend\b/.test(line)) {
        openLine = 0;
        openName = '';
      }
    }
    assert.equal(openLine, 0, `!macro ${openName} (line ${openLine}) is never closed with !macroend`);
  });

  it('stays inside the BUILD_UNINSTALLER guard — the uninstaller pass has no pages', () => {
    const guard = nsh.indexOf('!ifndef BUILD_UNINSTALLER');
    assert.ok(guard > 0);
    assert.ok(nsh.indexOf('!macro DetectComponents') > guard);
  });
});
