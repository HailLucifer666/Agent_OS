'use strict';

// test/file-size-guard.test.js — GAP-ANALYSIS-2026-08-24 (Aug-22 audit Item 13).
//
// The repo's own standard is a ~800-line ceiling per file. Eight files are over it,
// some by 5x. Splitting them is queued work (server/index.js routes move into
// server/routes/ following the existing pattern; electron/main.js must NOT be
// split — its boot-order traps are documented in AUDIT-2026-08-22-FIX-PLAN.md
// Phase 6 and a green suite cannot see an Electron load-order crash). Until that
// lands, this guard's job is the weaker but sufficient property: **the debt can
// shrink but cannot grow.** The two known exceptions are named here with their
// reasons, exactly as the fix plan prescribes; anything NEW crossing the ceiling
// fails this test.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CEILING = 800;

// Named exceptions. MEASURED BASELINE frozen 2026-08-24 — these existed before
// the guard. The list may only SHRINK: removing an entry after splitting its
// file is the intended workflow; adding one requires a written justification
// HERE. electron/main.js sits outside this walk (repo root) and is covered by
// its own do-not-split documentation in AUDIT-2026-08-22-FIX-PLAN.md Phase 6.
const BASELINE = [
  'adapters/dsh-agent/index.js',
  'scripts/spike-dsh-build.js',
  'scripts/verify-voice-session.js',
  'server/index.js', // split planned into server/routes/ per existing pattern
  'src/core/config/schema.js',
  'src/core/effectors/agent-actions.js',
  'src/core/effectors/from-browser.js',
  'src/core/effectors/from-computer.js',
  'src/core/effectors/from-dashboard.js',
  'src/core/effectors/from-pc.js',
  'src/core/effectors/from-spotify.js',
  'src/core/effectors/web-search.js',
  'src/core/engagements/executor.js',
  'src/core/goals/index.js',
  'src/core/immune/healer.js',
  'src/core/voice/live-session.js',
  'src/core/voice/live-tool-adapter.js',
  'src/core/voice/voice-agent.js',
  'src/main.js',
  'ui/public/js/app.js',
  'ui/public/js/neural-map/core-orb.js',
  'ui/public/js/neural-map/hud-canvas.js',
  'ui/public/js/voice/s2s-bridge.js',
  'ui/public/js/voice/voice-loop.js',
];
const EXCEPTIONS = new Set(BASELINE);

function lineCount(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fp, out);
    else if (/\.js$/.test(entry.name)) out.push(path.relative(ROOT, fp).replace(/\\/g, '/'));
  }
  return out;
}

describe('file-size guard: debt can shrink but cannot grow', () => {
  const offenders = [];
  for (const rel of walk(ROOT, [])) {
    if (rel.startsWith('test/')) continue;
    const lines = lineCount(rel);
    if (lines > CEILING && !EXCEPTIONS.has(rel)) offenders.push(`${rel} (${lines} lines)`);
  }

  it('no file outside the named exceptions exceeds the ceiling', () => {
    assert.deepEqual(offenders, [],
      'files over the 800-line ceiling — split them or add a justified exception in this test:\n'
      + offenders.join('\n'));
  });
});
