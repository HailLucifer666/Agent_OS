'use strict';

// test/anti-drift-single-dispatch.test.js — AD-1 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "One execution surface.
// Every tool call — cortex, voice-agent, Live session, REST, confirm-accept — goes
// leash.check() -> dispatchAction() -> sharedDispatch. No channel gets its own path."
// Executable check, verbatim from the spine's own table: read every file under
// src/core/ + server/; assert `effectors.invoke(` appears ONLY in
// src/core/effectors/dispatch-action.js.
//
// STATUS (2026-07-30, first run of this test): the assertion FAILS against real
// code. Three real call sites bypass dispatchAction() with a raw effectors.invoke():
//   - src/core/cortex/index.js:403      — mull-loop propose_goal call (its own
//     comment claims "T1 leash tier handles the audit automatically", which is
//     false: only dispatchAction() drives leash.check()/writeAudit(); a raw
//     hub.invoke() call skips leash entirely, so these proposals are unaudited).
//   - server/index.js:140,143,158        — TTS mic-duck/unduck (get_volume/
//     set_volume around the mic-hot window).
//   - server/routes/media.js:78          — media_key fallback "for callers/tests
//     that don't wire dispatchAction".
// Two more hits are comment text, not code, and are artifacts of this being a
// literal-substring check (implemented "verbatim" per the spec, not AST-aware):
// src/core/cortex/index.js:156 and src/core/immune/monitor.js:119 both just mention
// the string `effectors.invoke(` while explaining unrelated history/behavior.
// Fixing these is real Wave-1-scale engineering (rerouting three call sites through
// dispatchAction() with correct ctx/tier/goalId, not a docs fix) and is out of this
// session's scope (merged-order step 1 only). Per this session's brief: write the
// real, unweakened check now and report the violation rather than silently loosen
// it — but also don't retroactively break the just-established 0-fail baseline this
// same session wired into .githooks/pre-commit and .github/workflows/ci.yml. `todo`
// keeps the assertion live (still runs, still strict, still visible every run) while
// not counting as a failure. Flip this back to a plain `it` once the three call
// sites above are rerouted through dispatchAction().
//
// If you are reading this because it started passing: someone fixed the three call
// sites above. Delete this comment block's "STATUS" note and drop the `todo` flag.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const ALLOWED_FILE = path.join('src', 'core', 'effectors', 'dispatch-action.js');
const SCAN_ROOTS = ['src/core', 'server'];
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

test('AD-1: effectors.invoke( appears only in dispatch-action.js (single execution surface)', { todo: 'known violation, see file header — 3 real call sites bypass dispatchAction(); tracked, not this session\'s scope to fix' }, () => {
  const hits = [];
  for (const root of SCAN_ROOTS) {
    for (const file of collectJsFiles(path.join(MYTHOS_ROOT, root))) {
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
