'use strict';

// test/installer-uninstall-hardening.test.js — the NSIS uninstaller must not
// fail an update over one locked file (operator, 2026-08-13).
//
// In-app updates 0.1.6 → 0.1.7 failed three times; the only success was a
// manual install with nothing running. Root cause on the uninstall side: the
// default update path (un.atomicRMDir, app-builder-lib/templates/nsis/
// uninstaller.nsh) renames every file one at a time into
// $PLUGINSDIR\old-install, and a single locked file (AV scan, slow handle
// release) aborts the whole pass; the new installer's uninstallOldVersion then
// retries the ENTIRE uninstaller only 5× at 1s before rolling the update back.
//
// build/installer.nsh now defines customRemoveFiles, which uninstaller.nsh
// consumes in place of BOTH the rename dance and the plain RMDir of a normal
// uninstall: bounded retry of `RMDir /r`, then defer stragglers to reboot via
// /REBOOTOK instead of failing. These are source-shape assertions in the style
// of reinstall-asks-again.test.js — the installer is not covered by any
// compile step this suite can run, so the shape is what we can pin. The
// electron-builder smoke build in scripts/release.js is what proves it
// compiles.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('customRemoveFiles hardens the uninstaller against locked files', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8');

  it('defines customRemoveFiles before the !ifndef BUILD_UNINSTALLER guard', () => {
    // The rest of the file is wrapped in !ifndef BUILD_UNINSTALLER, which the
    // uninstaller compile pass skips entirely. A customRemoveFiles defined
    // inside that guard would never be seen by the pass that consumes it —
    // the uninstaller would silently fall back to the fragile default.
    const def = nsh.indexOf('!macro customRemoveFiles');
    const guard = nsh.indexOf('!ifndef BUILD_UNINSTALLER');
    assert.ok(def > 0, 'customRemoveFiles must be defined');
    assert.ok(guard > 0, 'the installer-only guard must still exist');
    assert.ok(def < guard, 'customRemoveFiles must sit before the installer-only guard to reach the uninstaller pass');
  });

  it('is wrapped in its own !ifdef BUILD_UNINSTALLER block with a matching !endif', () => {
    const ifdef = nsh.indexOf('!ifdef BUILD_UNINSTALLER');
    const def = nsh.indexOf('!macro customRemoveFiles');
    const end = nsh.indexOf('!macroend', def);
    const endif = nsh.indexOf('!endif', end);
    assert.ok(ifdef > 0 && ifdef < def, 'the macro must be guarded uninstaller-only');
    assert.ok(end > def, 'the macro must be closed');
    assert.ok(endif > end, 'the !ifdef must be closed after the macro');
  });

  it('removes with RMDir /r and defers locked stragglers via /REBOOTOK', () => {
    const body = nsh.slice(nsh.indexOf('!macro customRemoveFiles'), nsh.indexOf('!macroend', nsh.indexOf('!macro customRemoveFiles')));
    assert.match(body, /RMDir \/r "\$INSTDIR"/, 'whole-tree removal, not per-file');
    assert.match(body, /RMDir \/r \/REBOOTOK "\$INSTDIR"/, 'the give-up path must schedule removal on reboot instead of failing the update');
  });

  it('contains no Rename — the per-file dance is what a single locked file aborts', () => {
    const body = nsh.slice(nsh.indexOf('!macro customRemoveFiles'), nsh.indexOf('!macroend', nsh.indexOf('!macro customRemoveFiles')));
    assert.doesNotMatch(body, /\bRename\b/, 'reintroducing the rename-into-old-install dance restores the original failure mode');
  });

  it('retries a bounded number of times with a sleep between attempts', () => {
    const body = nsh.slice(nsh.indexOf('!macro customRemoveFiles'), nsh.indexOf('!macroend', nsh.indexOf('!macro customRemoveFiles')));
    assert.match(body, /Sleep 1000/, 'waiting gives an AV scan or a closing handle time to release');
    assert.match(body, /IntCmp \$removeFilesTries 5/, 'the retry loop must be bounded, or a permanently locked file hangs the uninstall forever');
  });
});
