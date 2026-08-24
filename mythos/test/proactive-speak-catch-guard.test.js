'use strict';

// Source-shape guard (BUG-333, 2026-08-24): every fire-and-forget
// proactiveSpeak() call in server/index.js must carry a .catch.
//
// Mechanism being guarded: src/core/crash-handlers.js installs
// unhandledRejection -> exit(1) deliberately (BUG-308 posture), and
// serializeSpeech re-throws the inner failure to the caller. Seven bus
// subscribers called proactiveSpeak() bare, so any TTS/Live failure during an
// announcement could kill the whole process mid-conversation. One site
// (onSilentTurn) always remembered .catch — this guard makes forgetting
// impossible to merge.
//
// Why source-shape and not a unit test: server/index.js is a ~4700-line boot
// monolith whose voice wiring only runs inside a real server; there is no seam
// through which a unit test can invoke these subscriber bodies. Same precedent
// as test/electron-cursor-overlay.test.js — a shape assertion is the only
// automated guard available, so it gets a negative control instead of trust.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'server', 'index.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const LINES = SRC.split(/\r?\n/);

// Capture the full statement containing a call that starts at column `col` of
// startIdx: from there through the first top-level semicolon up to 6 lines
// down, so a wrapped call with a trailing .catch is judged on its whole text.
function statementText(startIdx, col) {
  let out = LINES[startIdx].slice(col) + '\n';
  const limit = Math.min(LINES.length, startIdx + 6);
  for (let i = startIdx + 1; i < limit; i++) {
    out += LINES[i] + '\n';
    let depth = 0;
    for (let j = 0; j < LINES[i].length; j++) {
      const ch = LINES[i][j];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ';' && depth <= 0) return out;
    }
  }
  return out;
}

test('guard-the-guard: the matcher sees real shapes, never passes vacuously', () => {
  // Negative control 1: the one historically-correct site must still be there,
  // still guarded. If it disappears this test's blindness must be investigated,
  // not celebrated.
  assert.match(
    SRC,
    /proactiveSpeak\(text, ws, \{ skipLive: true \}\)\s*\n\s*\.catch\(/,
    'the guarded onSilentTurn reference site is gone — the negative control is blind'
  );
  // Negative control 2: the bare shape itself must still be detectable.
  const fakeBare = '    proactiveSpeak(e.payload.text);';
  assert.ok(/^\s*proactiveSpeak\(/.test(fakeBare), 'bare-shape detector regressed');
});

test('every fire-and-forget proactiveSpeak() call carries a .catch', () => {
  const offenders = [];
  LINES.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (!/\bproactiveSpeak\s*\(/.test(line)) return;
    if (/^\s*(async\s+)?function\s+proactiveSpeak/.test(line)) return; // the definition
    if (/^\s*await\s/.test(trimmed)) return; // awaited sites own their rejection
    const col = line.indexOf('proactiveSpeak(');
    const stmt = statementText(idx, col);
    if (/\.catch\s*\(/.test(stmt)) return;
    offenders.push(`server/index.js:${idx + 1}: ${trimmed}`);
  });

  assert.deepStrictEqual(
    offenders,
    [],
    [
      'Bare proactiveSpeak() calls found. This process exits on unhandledRejection;',
      'a failed announcement would take MYTHOS down mid-conversation. Chain',
      '.catch((err) => logger.warn("proactive.speak-failed", { error: err.message }))',
      'like the onSilentTurn site does:',
      ...offenders,
    ].join('\n')
  );
});
