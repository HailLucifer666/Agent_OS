'use strict';

// test/anti-drift-no-fake-telemetry.test.js — AD-5 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "No invented telemetry —
// the IRIS anti-pattern. No status, health, metric, or HUD value may be
// synthesized." IRIS's HUD famously does `temperature = 40 + cpu*0.4 +
// Math.random()*2` and pure-`Math.random()` network stats; MYTHOS's honest-inert
// principle is the thing this whole plan explicitly refuses to import.
//
// Executable check, verbatim from the spine's own table: grep src/core/, server/,
// ui/public/js/ for Math.random() and fail on any hit inside a file whose path OR
// nearby symbol matches stat|metric|health|telemetry|temperature|latency — with an
// explicit line-numbered allowlist for legitimate jitter/backoff/id-suffix sites.
//
// 2026-07-30: every current Math.random() site in these three trees is either a
// non-colliding id suffix ('job-<ts>-<rand>') or a visual-only animation jitter
// (spark timers/angles in the neural-map canvas) — none synthesize a status,
// metric, or telemetry value. This test currently PASSES; it exists to make sure
// it stays that way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['src/core', 'server', 'ui/public/js'];
const NEEDLE = 'Math.random()';
const SUSPECT_RE = /stat|metric|health|telemetry|temperature|latency/i;

// Explicit allowlist of known-legitimate jitter/backoff/id-suffix sites (file, line).
// Each one was manually reviewed at the time it was added — adding a new entry here
// must come with the same review, not a reflex to silence a real finding.
const ALLOWLIST = new Set([
  // id-suffix generators (collision-avoidance, not a measurement)
  'src/core/effectors/build-runner.js:125',
  'src/core/effectors/from-calendar.js:24',
  'src/core/effectors/from-memory.js:62',
  'src/core/effectors/kanban.js:28',
  'src/core/effectors/kanban.js:59',
  'src/core/effectors/pipeline.js:41',
  'server/index.js:96',
  'server/index.js:114',
  // HUD canvas animation jitter (visual-only spark/burst timing, not a metric)
  'ui/public/js/neural-map/core-orb.js:85',
  'ui/public/js/neural-map/core-orb.js:310',
  'ui/public/js/neural-map/core-orb.js:312',
  'ui/public/js/neural-map/core-orb.js:334',
  'ui/public/js/neural-map/core-orb.js:528',
  'ui/public/js/neural-map/hud-canvas.js:327',
]);

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

test('AD-5: Math.random() never fabricates a status/metric/health/telemetry value', () => {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    const dir = path.join(MYTHOS_ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of collectJsFiles(dir)) {
      const rel = path.relative(MYTHOS_ROOT, file).split(path.sep).join('/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((lineText, i) => {
        if (!lineText.includes(NEEDLE)) return;
        const lineNo = i + 1;
        const key = `${rel}:${lineNo}`;
        if (ALLOWLIST.has(key)) return;
        // context = the path itself, or a window of nearby lines (identifiers like
        // the variable being assigned usually sit within a couple of lines).
        const windowStart = Math.max(0, i - 2);
        const windowEnd = Math.min(lines.length, i + 3);
        const context = rel + '\n' + lines.slice(windowStart, windowEnd).join('\n');
        if (SUSPECT_RE.test(context)) violations.push(key);
      });
    }
  }
  assert.deepEqual(violations, [], `Math.random() used near a stat/metric/health/telemetry/temperature/latency symbol, not allowlisted: ${violations.join(', ')}`);
});
