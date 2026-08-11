'use strict';

// src/core/setup/components.js — the optional-component catalog, and the pure
// decisions around it.
//
// WHY A CATALOG AND NOT A COMMAND PARAMETER: the install route spawns a child
// process. If the renderer could name the script, a compromised page would have
// arbitrary code execution on the host. So the HTTP surface accepts component
// IDs only, and this file is the allowlist that maps an ID to a fixed argv. No
// caller-supplied string ever reaches spawn().
//
// EVERY ENTRY MUST BE ACTUALLY INSTALLABLE. `piper` was excluded for exactly
// that reason until 2026-08-11 — scripts/setup-piper.js was advertised in three
// places and existed in none, and a checkbox that cannot act is the same lie as
// a fake progress bar. The script now exists (MIT voices from
// rhasspy/piper-voices), so the row is real and the gap it left in a packaged
// install — no offline voice at all, because mythos/models is not shipped — is
// closable from the wizard.
//
// The doctorId on each entry is what makes "installed" an observed fact rather
// than a remembered one: after an install we re-read doctor's asset rows, so a
// download that half-finished reads as not installed, not as done.

const COMPONENTS = [
  {
    id: 'silero',
    label: 'Silero VAD',
    note: '~2 MB — voice turn-taking, so MYTHOS knows when you stopped talking',
    doctorId: 'silero',
    script: 'scripts/setup-silero.js',
    args: [],
    requiresWsl: false,
  },
  {
    id: 'wakeword',
    label: 'Wake word "hey jarvis"',
    note: '~4 MB — three .onnx models; WAKEWORD_ENABLED cannot arm without all three',
    doctorId: 'wakeword',
    script: 'scripts/setup-wakeword.js',
    args: [],
    requiresWsl: false,
  },
  {
    id: 'piper',
    label: 'Offline voice (Piper)',
    note: '~60 MB — the last link of the TTS chain, and the only one that speaks with no network and no key',
    doctorId: 'piper',
    script: 'scripts/setup-piper.js',
    args: ['--install'],
    requiresWsl: false,
  },
  {
    id: 'hermes',
    label: 'Hermes build agent',
    note: 'installs into WSL — the only build-content engine; builds fail without it',
    doctorId: 'hermes',
    script: 'scripts/setup-hermes.js',
    args: ['--install'],
    requiresWsl: true,
  },
  {
    id: 'adb',
    label: 'Phone control (adb)',
    note: '~15 MB Android platform-tools — every phone_* effector shells out to adb',
    doctorId: 'adb',
    script: 'scripts/setup-android.js',
    args: ['--install'],
    requiresWsl: false,
  },
  {
    id: 'autostart',
    label: 'Start MYTHOS at sign-in',
    note: 'registers the login task; no download',
    doctorId: null, // nothing in doctor's asset table reports this
    script: 'scripts/setup-autostart.js',
    args: ['--install'],
    requiresWsl: false,
  },
];

function catalog() {
  // A copy per call: a caller that mutates a row must not reshape the allowlist.
  return COMPONENTS.map((c) => ({ ...c, args: c.args.slice() }));
}

function findComponent(id) {
  return COMPONENTS.find((c) => c.id === id) || null;
}

// resolveComponentIds(ids, {wslPresent}) -> {ok, components} | {ok:false, error}
// Rejects the whole request on the first unknown ID rather than silently
// installing the subset it recognised: a typo'd ID means the client and the
// server disagree about the catalog, and quietly doing part of the job is how
// "it said it installed" happens.
function resolveComponentIds(ids, opts) {
  const wslPresent = Boolean(opts && opts.wslPresent);
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: 'no components requested' };
  }
  if (ids.length > COMPONENTS.length) {
    return { ok: false, error: 'more components requested than exist' };
  }
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string') return { ok: false, error: 'component id must be a string' };
    const found = findComponent(id);
    if (!found) return { ok: false, error: `unknown component: ${id}` };
    if (seen.has(id)) return { ok: false, error: `component requested twice: ${id}` };
    if (found.requiresWsl && !wslPresent) {
      return { ok: false, error: `${found.label} needs WSL, which is not available on this machine` };
    }
    seen.add(id);
    out.push({ ...found, args: found.args.slice() });
  }
  return { ok: true, components: out };
}

// mergeComponentState({assets, selection, wslPresent}) -> rows for the HUD
//   assets       — doctor's asset rows (id/ok/detail), the authority on installed
//   selection    — {silero:true,...} from the installer's manifest, or null
//   wslPresent   — probed once by the caller
//
// `selected` is a SUGGESTION (what the installer page recorded) and `installed`
// is a FACT (what doctor sees on disk now). Keeping them separate is the point:
// the wizard pre-checks the suggestion but never claims a component is present
// because someone once ticked a box.
function mergeComponentState(input) {
  const assets = (input && Array.isArray(input.assets)) ? input.assets : [];
  const selection = (input && input.selection && typeof input.selection === 'object') ? input.selection : null;
  const wslPresent = Boolean(input && input.wslPresent);

  return catalog().map((c) => {
    const row = c.doctorId ? assets.find((a) => a && a.id === c.doctorId) : null;
    const installed = row ? row.ok === true : null; // null = not observable here
    const blocked = c.requiresWsl && !wslPresent;
    return {
      id: c.id,
      label: c.label,
      note: c.note,
      installed,
      // Nothing is pre-checked once it is already installed — re-running a
      // downloader that already succeeded is a confusing default.
      selected: Boolean(selection && selection[c.id] === true) && installed !== true,
      available: !blocked,
      unavailableReason: blocked ? 'Needs WSL. Install it with: wsl --install' : '',
    };
  });
}

module.exports = { COMPONENTS, catalog, findComponent, resolveComponentIds, mergeComponentState };
