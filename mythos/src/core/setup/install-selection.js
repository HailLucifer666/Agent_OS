'use strict';

// src/core/setup/install-selection.js — reads what the operator ticked on the
// installer's component page.
//
// build/installer.nsh writes $APPDATA\MYTHOS\install-selection.json during the
// NSIS install section. This file is the only reader. It exists so the choice
// made in the installer is not lost by the time the app can act on it — the
// installer records intent, the app does the work where progress and failure are
// visible.
//
// Path resolution copies doctor.js's keyStoreNames() idiom deliberately, for the
// same reason it exists there: check every userData name MYTHOS has ever used,
// because checking only one silently reports "no selection" on whichever install
// the operator is actually using. Never a hardcoded user path.
//
// CORRECTED 2026-08-11 (installer parity). This comment used to say userData is
// "MYTHOS in a packaged build and agent-os in an unpackaged dev run". That was
// backwards AND incomplete, and believing it is part of why the installed build
// running on a second, empty brain went unnoticed. What actually happened:
// electron/main.js never called app.setName, so Electron fell back to
// package.json's `name` ("agent-os") for the PACKAGED app and to the literal
// "Electron" for a dev run out of node_modules — while build.productName
// ("MYTHOS") is what NSIS used for install-selection.json. Three directories,
// none of them the one this file's author expected:
//   %APPDATA%\Electron   the dev run (npm start / Start Electron App.bat)
//   %APPDATA%\agent-os   the installed .exe
//   %APPDATA%\MYTHOS     the installer's own write target
// electron/main.js now calls app.setName('MYTHOS') so both runs land on MYTHOS,
// matching the installer. The other two names stay in the list below because
// existing machines still have data under them.
//
// Failure policy: absent, unreadable, corrupt, or wrong-shaped all return
// {found:false}. That is NOT the same as "selected nothing" — mergeComponentState
// falls back to the wizard's own defaults on {found:false}, whereas an empty
// selection would pre-check nothing and quietly leave a machine unequipped.

const fsDefault = require('fs');
const os = require('os');
const path = require('path');

const FILE = 'install-selection.json';
// Canonical first, then the two legacy names in the order they are likely to
// hold real data. 'Electron' was missing entirely until 2026-08-11, which is
// exactly the dev-run directory this file most needed to find.
const PRODUCTS = ['MYTHOS', 'agent-os', 'Electron'];

function candidatePaths(env, homedir) {
  const e = env || {};
  const home = homedir || os.homedir();
  const out = [];
  for (const product of PRODUCTS) {
    if (e.APPDATA) out.push(path.join(e.APPDATA, product, FILE));
    if (e.XDG_CONFIG_HOME) out.push(path.join(e.XDG_CONFIG_HOME, product, FILE));
    out.push(path.join(home, '.config', product, FILE));
    out.push(path.join(home, 'Library', 'Application Support', product, FILE));
  }
  return out;
}

// readInstallSelection({env, fs, homedir}) ->
//   {found:true, file, selected:{id:bool}, wslPresent:bool} | {found:false, reason}
function readInstallSelection(opts) {
  const o = opts || {};
  const fs = o.fs || fsDefault;
  const env = o.env || process.env;

  for (const file of candidatePaths(env, o.homedir)) {
    let raw;
    try {
      if (!fs.existsSync(file)) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      // Unreadable is treated as absent, same as doctor's key-store read: a
      // permissions problem on an optional hint must not stop first run.
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { found: false, reason: 'unparseable', file };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: false, reason: 'wrong-shape', file };
    }
    const selected = {};
    const src = (parsed.selected && typeof parsed.selected === 'object' && !Array.isArray(parsed.selected))
      ? parsed.selected
      : {};
    // Only true booleans count. NSIS writes bare true/false, but a hand-edited
    // "yes" or 1 should not be guessed at — an ambiguous hint is no hint.
    for (const key of Object.keys(src)) {
      if (src[key] === true) selected[key] = true;
    }
    return {
      found: true,
      file,
      selected,
      // The installer probed WSL at install time; the server re-probes at
      // runtime, so this is a record, not the authority.
      wslPresent: parsed.wslPresent === true || parsed.wslPresent === 1,
    };
  }
  return { found: false, reason: 'absent' };
}

module.exports = { readInstallSelection, candidatePaths };
