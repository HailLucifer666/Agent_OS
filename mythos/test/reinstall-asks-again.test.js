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
// 2. THE BUILD ENGINE DELIVERED WHERE UPDATES DELETE. setup-hermes.js installed
//    into <repo>/Hermes Agent, and for a packaged install <repo> is inside the
//    install tree — the NSIS updater removes it wholesale (23,283 files,
//    measured). doctor.js restated that one path by hand, so it also could not
//    see an install anywhere else. W6 (2026-08-22) replaced the engine with
//    DeepSeek Harness and setup-dsh.js carries the SAME dual-search rule, so
//    this section is re-pointed rather than deleted: the defect was about the
//    delivery location, not about which program was delivered.
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
const dsh = require('../scripts/setup-dsh.js');

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
    write(path.join(parent, 'agent-os', 'config.json'), JSON.stringify({ DSH_TASK_TIMEOUT_MS: 600000, _fake: fakeCli }));

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

describe('2. the build engine is delivered where an update cannot erase it', () => {
  it('writes into MYTHOS_TOOLS_DIR when Electron injected one', () => {
    const tools = path.join(os.tmpdir(), 'ud-tools');
    const home = dsh.resolveDshHome({ MYTHOS_TOOLS_DIR: tools });
    assert.equal(home, path.resolve(path.join(tools, 'DeepSeek Harness')));
  });

  it('falls back to the repo root for a bare dev-checkout run', () => {
    assert.equal(dsh.resolveDshHome({}), dsh.REPO_DSH_HOME);
  });

  it('an explicit MYTHOS_DSH_INSTALL_DIR still wins — the documented escape hatch', () => {
    const explicit = path.join(os.tmpdir(), 'custom-dsh');
    const home = dsh.resolveDshHome({ MYTHOS_DSH_INSTALL_DIR: explicit, MYTHOS_TOOLS_DIR: path.join(os.tmpdir(), 'ud-tools') });
    assert.equal(home, path.resolve(explicit));
  });

  it('a READ searches every home, so an install in either location is still found', () => {
    const homes = dsh.dshSearchHomes({ MYTHOS_TOOLS_DIR: path.join(os.tmpdir(), 'ud-tools') });
    assert.ok(homes.some((h) => h.includes('tools')), 'the userData location');
    assert.ok(homes.includes(dsh.REPO_DSH_HOME), 'the dev-checkout location must stay searchable');
  });

  it('finds a real install in the userData home', () => {
    const tools = tmpDir();
    const pkgDir = path.join(tools, 'DeepSeek Harness', 'node_modules', '@deepseek-ai', 'dsh');
    write(path.join(pkgDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n');
    write(path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: dsh.DSH_VERSION, bin: { dsh: 'lib/bin.js' } }));

    const found = dsh.findInstalled({ MYTHOS_TOOLS_DIR: tools });
    assert.ok(found, 'an installed engine must be detected, or the wizard re-offers it');
    assert.equal(found.version, dsh.DSH_VERSION);
    assert.equal(found.entry, path.join(pkgDir, 'lib', 'bin.js'));
  });

  it('reads the bin entry from the package rather than guessing a file name', () => {
    // dsh is a developer preview. `bin` is a string on some packages and a map on
    // others, and guessing would break silently on the next release.
    const tools = tmpDir();
    const pkgDir = path.join(tools, 'DeepSeek Harness', 'node_modules', '@deepseek-ai', 'dsh');
    write(path.join(pkgDir, 'other', 'entry.js'), '');
    write(path.join(pkgDir, 'package.json'),
      JSON.stringify({ version: dsh.DSH_VERSION, bin: 'other/entry.js' }));
    const found = dsh.findInstalled({ MYTHOS_TOOLS_DIR: tools });
    assert.equal(found.entry, path.join(pkgDir, 'other', 'entry.js'));
  });

  it('a present-but-wrong-version install is reported with its version, not as OK', () => {
    // The adapter asserts the pin before every task, so "installed" for a
    // version it refuses is the same half-truth that let six builds fail
    // silently. findInstalled reports the version; doctor.js decides.
    const tools = tmpDir();
    const pkgDir = path.join(tools, 'DeepSeek Harness', 'node_modules', '@deepseek-ai', 'dsh');
    write(path.join(pkgDir, 'lib', 'bin.js'), '');
    write(path.join(pkgDir, 'package.json'),
      JSON.stringify({ version: '0.0.1-not-the-pin', bin: { dsh: 'lib/bin.js' } }));
    const found = dsh.findInstalled({ MYTHOS_TOOLS_DIR: tools });
    assert.equal(found.version, '0.0.1-not-the-pin');
    assert.notEqual(found.version, dsh.DSH_VERSION);
  });

  it('reports nothing when nothing is installed in any searched home', () => {
    // The homes are injected, not derived from env: the real search list always
    // includes the repo root, and THIS machine has dsh there, so an env-only
    // version of this test would assert the host's state rather than the
    // function's behaviour.
    assert.equal(dsh.findInstalled({}, [tmpDir(), tmpDir()]), null);
  });

  it('doctor asks setup-dsh rather than restating a path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'doctor.js'), 'utf8');
    // W6: the build engine moved from Hermes-Agent to DeepSeek Harness, and
    // doctor.js must keep ASKING the installer where it lives rather than
    // restating a path — that restatement is the original defect this file
    // exists to prevent.
    assert.match(src, /require\('\.\/setup-dsh\.js'\)/);
    assert.match(src, /dsh\.findInstalled\(\)/);
    assert.doesNotMatch(src, /path\.join\(REPO_ROOT, 'Hermes Agent'/,
      'the hand-restated path is what let doctor and the installer disagree');
  });

  it('requiring setup-dsh does not run its probe', () => {
    // doctor.js requires it on every report; an unguarded entry point would
    // spawn a child process each time.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-dsh.js'), 'utf8');
    assert.match(src, /require\.main === module/);
  });
});

describe('3. the installer looks before it asks', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8');

  it('probes the userData paths electron/main.js actually injects', () => {
    assert.match(nsh, /\$APPDATA\\MYTHOS\\models\\silero\\silero_vad\.onnx/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\models\\wakeword\\melspectrogram\.onnx/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\tools\\DeepSeek Harness/);
    assert.match(nsh, /\$APPDATA\\MYTHOS\\tools\\Android Platform Tools\\platform-tools\\adb\.exe/);
  });

  it('requires all three wake-word assets — a partial set must still offer the download', () => {
    const detect = nsh.slice(nsh.indexOf('!macro DetectComponents'), nsh.indexOf('Function mythosComponentsPage'));
    for (const asset of ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx']) {
      assert.ok(detect.includes(asset), `${asset} must be part of the wake-word check`);
    }
    assert.match(detect, /\$\{AndIf\}/, 'all-or-nothing, not any-of');
  });

  it('checks both legitimate build-engine homes', () => {
    // W6 (2026-08-22) dropped the third one. Hermes had an HERMES_HOME env var;
    // dsh deliberately has no equivalent — it resolves a PINNED, project-local
    // install and refuses to reach for a global one, which is the property that
    // makes its version assertion meaningful. Two homes remain: userData (which
    // survives an update) and the in-tree one a dev checkout uses.
    const detect = nsh.slice(nsh.indexOf('!macro DetectComponents'), nsh.indexOf('Function mythosComponentsPage'));
    assert.match(detect, /\$APPDATA\\MYTHOS\\tools\\DeepSeek Harness/);
    assert.match(detect, /\$INSTDIR\\resources\\app\.asar\.unpacked\\DeepSeek Harness/);
    assert.equal(/HERMES_HOME/.test(detect), false,
      'a probe for a deleted program\'s env var would report an install that cannot exist');
  });

  it('the build-engine checkbox is not gated on WSL', () => {
    // dsh is an npm package where Hermes-Agent was a Python venv inside WSL.
    // Gating the one component whose absence fails every build on a WSL install
    // it does not need would refuse it on every Windows machine without WSL.
    const page = nsh.slice(nsh.indexOf('Function mythosComponentsPage'));
    const engineRows = page.split('\n').filter((l) => /DeepSeek Harness build engine/.test(l));
    assert.ok(engineRows.length >= 1, 'the engine must still have a checkbox');
    for (const row of engineRows) {
      assert.equal(/WSL/i.test(row), false, 'no WSL gate on the build engine: ' + row.trim());
    }
    // WSL is still PROBED, because install-selection.json reports it and the
    // app's component registry keys other rows on it.
    assert.match(nsh, /wsl\.exe" --status/);
  });

  it('shows a found component as installed and disables it rather than hiding it', () => {
    assert.match(nsh, /"Silero VAD — already installed"/);
    assert.match(nsh, /'Wake word "hey jarvis" — already installed'/);
    assert.match(nsh, /"DeepSeek Harness build engine — already installed"/);
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

// ---- the install check must not report a half-truth ---------------------------
//
// DELETED WITH HERMES (W6 step 6, 2026-08-22): this used to test
// setup-hermes.js's YAML provider check, which existed because Hermes read
// `model.provider` from its own config.yaml and a fresh install defaulted to
// OpenRouter, so pointing the env vars elsewhere yielded a 401. dsh has no
// config.yaml of its own in MYTHOS's path — the provider route is a generated
// per-run overlay — so the whole class of defect is gone rather than moved.
//
// What replaces it is the check that CAN still be got wrong: reporting an
// install as usable when the adapter would refuse it.
describe('setup-dsh.js install check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-dsh.js'), 'utf8');

  it('keeps its version pin in step with the adapter, and refuses if they drift', () => {
    // Two literals that can disagree is how a script ends up installing a
    // version the adapter then refuses to run.
    const adapterPin = require('../adapters/dsh-agent').DSH_PINNED_VERSION;
    assert.equal(dsh.DSH_VERSION, adapterPin);
    assert.match(src, /VERSION PIN MISMATCH/,
      '--check must refuse rather than install a version the adapter asserts against');
  });

  it('verifies the pin against the CLI as well as package.json', () => {
    // A half-finished reinstall makes those two disagree, and that is the state
    // that produces inexplicable results rather than a clean failure.
    assert.match(src, /INCONSISTENT INSTALL/);
    assert.match(src, /'--version'/);
  });

  it('reports whether the BUILD LANE is reachable, not just whether dsh is present', () => {
    // "installed" is only half of "builds will work"; the other half is BUG-168.
    assert.match(src, /NOT USABLE FOR BUILDS/);
    assert.match(src, /selectModel/);
  });

  it('never pipes a remote script into a shell', () => {
    // COMMENTS STRIPPED FIRST, and the reason is that the naive version of this
    // test FAILED on its own subject: setup-dsh.js's header explains that it
    // never does `curl | bash` / `iex (irm …)`, and a scanner that cannot tell
    // code from prose matched the explanation. Same class of false positive this
    // repo already recorded when an /api/* inside a comment blanked a smoke
    // test's input. Line-based, because the file uses // comments only, and the
    // stripper is asserted so it cannot silently end up scanning nothing.
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(code.length < src.length, 'nothing was stripped — the filter is broken');
    assert.ok(code.includes('async function install()'), 'real code must survive the strip');
    assert.equal(/curl[^\n]*\|\s*(ba)?sh/.test(code), false);
    assert.equal(/iex\s*\(/.test(code), false);
    assert.match(code, /--save-exact/, 'the version must be pinned at install time');
  });
});
