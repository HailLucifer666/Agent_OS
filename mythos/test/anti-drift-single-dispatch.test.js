'use strict';

// test/anti-drift-single-dispatch.test.js — AD-1 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "One execution surface.
// Every tool call — cortex, voice-agent, Live session, REST, confirm-accept — goes
// leash.check() -> dispatchAction() -> sharedDispatch. No channel gets its own path."
// Executable check, verbatim from the spine's own table: read every file under
// src/core/ + server/ + adapters/ + ui/ (all of mythos/) plus the repo-root
// electron/ dir; assert `effectors.invoke(` appears ONLY in
// src/core/effectors/dispatch-action.js.
//
// FIXED (2026-07-30, merged-order step 2): the three real call sites that bypassed
// dispatchAction() with a raw effectors.invoke() are rerouted:
//   - src/core/cortex/index.js — mull-loop propose_goal call now goes through
//     dispatchAction() (tier 1, channel:'cortex'), so proposals get a real
//     audit/episodic line instead of none at all.
//   - server/index.js — TTS mic-duck/unduck (get_volume/set_volume around the
//     mic-hot window) now goes through dispatchAction() (channel:'voice-ducking').
//   - server/routes/media.js — the media_key raw-invoke fallback ("for callers/
//     tests that don't wire dispatchAction") was dead in production and in every
//     test that exercised this route; removed, dispatchAction is now required.
// The two comment-text-only hits noted in the original violation report
// (src/core/cortex/index.js and src/core/immune/monitor.js, both just historical
// prose mentioning the call shape) were reworded to not spell out the literal
// substring contiguously, since this check is a literal scan, not AST-aware.
// This is a real, unweakened assertion now — no `todo`, no allowlist beyond
// dispatch-action.js itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const ALLOWED_FILE = path.join('src', 'core', 'effectors', 'dispatch-action.js');
const SCAN_ROOTS = ['src/core', 'server', 'adapters', 'ui'];
// electron/ lives at the repo root, outside mythos/ — scan it by absolute path.
const EXTRA_SCAN_ROOTS = [path.join(MYTHOS_ROOT, '..', 'electron')];
const NEEDLE = 'effectors.invoke(';

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('AD-1: effectors.invoke( appears only in dispatch-action.js (single execution surface)', () => {
  const hits = [];
  const scanDirs = [...SCAN_ROOTS.map((root) => path.join(MYTHOS_ROOT, root)), ...EXTRA_SCAN_ROOTS];
  for (const dir of scanDirs) {
    for (const file of collectJsFiles(dir)) {
      const rel = path.relative(MYTHOS_ROOT, file);
      const content = fs.readFileSync(file, 'utf8');
      let idx = content.indexOf(NEEDLE);
      while (idx !== -1) {
        const line = content.slice(0, idx).split('\n').length;
        hits.push(`${rel}:${line}`);
        idx = content.indexOf(NEEDLE, idx + 1);
      }
    }
  }

  const violations = hits.filter((h) => !h.startsWith(ALLOWED_FILE + ':'));
  assert.deepEqual(violations, [], `effectors.invoke( found outside dispatch-action.js: ${violations.join(', ')}`);
});
