'use strict';

// log-redaction-collateral.test.js — 2026-08-17.
//
// server/index.js's LOG_REDACT_KEYS blanks a log field whose KEY NAME CONTAINS
// any of nine words, one of which is 'session' and another 'token'. Those are
// words that turn up in perfectly ordinary diagnostic field names, so the
// over-match carries the failure mode this repo has paid for repeatedly: a
// protection that also destroys the evidence trail (rules/core.md §11.2 — "does
// this hide evidence?").
//
// The substring semantics are DELIBERATELY KEPT — see the pinned disposition on
// LOG_REDACT_KEYS. audit-writer.js's REDACT_KEYS is byte-identical and matches
// the same way, and two redaction rules with different semantics would be worse
// than one over-broad rule. So this file is the enforcement instead: it sweeps
// the REAL emitters and fails when a new payload key would be swallowed, turning
// silent drift into a red commit.
//
// The first run of this sweep found exactly one collateral key — `sessionsClosed`
// in the live.voice-changed line, since renamed to `closedCount`.
//
// Deliberately NOT asserted here: that no secret ever reaches a client. That is
// anti-drift-secret-leak-sentinel.test.js's job (AD-8) and server-log-redaction
// .test.js's. This file only asks the opposite question — what does the
// protection cost.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');

// Read the list out of the source rather than hard-coding a copy — a third copy
// of these nine words is exactly the drift this file exists to catch.
function logRedactKeys() {
  const src = fs.readFileSync(path.join(MYTHOS_ROOT, 'server', 'index.js'), 'utf8');
  const m = /const LOG_REDACT_KEYS = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'could not find LOG_REDACT_KEYS in server/index.js — if it was renamed, update this test');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

function sourceFiles() {
  const roots = [path.join(MYTHOS_ROOT, 'src'), path.join(MYTHOS_ROOT, 'server')];
  const files = [];
  while (roots.length) {
    const dir = roots.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules/.test(full)) roots.push(full); continue; }
      if (e.isFile() && e.name.endsWith('.js')) files.push(full);
    }
  }
  return files;
}

// Keys appearing in logger.*/anomaly payload object literals. Single-level
// literals only ({...} with no nested braces) — deliberately conservative, since
// a greedy match across nested objects would invent keys that are not payload
// keys at all and make this gate noisy enough to be ignored.
function payloadKeys() {
  const patterns = [
    /(?:logger|log)\.(?:info|warn|error|debug)\s*\(\s*[^,)]+,\s*\{([^{}]*)\}/g,
    /emit\(\s*'health\.anomaly'\s*,\s*\{([^{}]*)\}/g,
  ];
  const found = new Map();
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const keyRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g;
        let km;
        while ((km = keyRe.exec(m[1])) !== null) {
          const key = km[1];
          if (!found.has(key)) found.set(key, new Set());
          found.get(key).add(path.relative(MYTHOS_ROOT, file).split(path.sep).join('/'));
        }
      }
    }
  }
  return found;
}

describe('log redaction does not swallow diagnostics', () => {
  const keys = logRedactKeys();
  const swallows = (key) => keys.some((r) => key.toLowerCase().includes(r.toLowerCase()));

  it('the sweep found emitters, so a broken regex cannot pass vacuously', () => {
    // BUG-221's lesson: an assertion that passes against the bug is worthless.
    // The real sweep finds ~144 distinct payload keys today; the floor is set
    // well below that so ordinary churn does not trip it, but far above the ~0
    // a broken regex would yield.
    assert.ok(payloadKeys().size > 100,
      'expected to sweep >100 real payload keys, found ' + payloadKeys().size +
      ' — the emitter regex has probably stopped matching');
  });

  it('LOG_REDACT_KEYS was parsed, not silently defaulted to empty', () => {
    assert.equal(keys.length, 9,
      'expected the 9 documented key names, parsed ' + keys.length + ': ' + keys.join(','));
  });

  it('no log or anomaly payload key is redacted as collateral', () => {
    // A key that IS one of the nine exactly is a genuine secret and must stay
    // redacted. Anything else that matches is collateral: a diagnostic silently
    // replaced with [REDACTED] in the HUD log and the replay buffer.
    const collateral = [];
    for (const [key, files] of payloadKeys()) {
      if (!swallows(key)) continue;
      if (keys.includes(key)) continue; // an actual secret field — correct to redact
      collateral.push(key + ' (' + [...files].sort()[0] + ')');
    }
    assert.deepEqual(collateral.sort(), [],
      'these log/anomaly payload keys are not secrets but contain one of LOG_REDACT_KEYS as a substring, '
      + 'so the client-bound copy shows [REDACTED] and the diagnostic is lost. Rename the field — do NOT '
      + 'narrow LOG_REDACT_KEYS without narrowing audit-writer.js\'s identical REDACT_KEYS too '
      + '(see the pinned disposition in server/index.js).');
  });

  it('the two redaction key lists have not drifted apart', () => {
    // server/index.js's comment asks for these to be kept in sync; nothing
    // enforced it. Different semantics in two places is the worse failure than
    // either list being broad.
    const auditSrc = fs.readFileSync(
      path.join(MYTHOS_ROOT, 'src', 'core', 'memory', 'audit-writer.js'), 'utf8');
    const m = /REDACT_KEYS = \[([^\]]+)\]/.exec(auditSrc);
    assert.ok(m, 'could not find REDACT_KEYS in audit-writer.js');
    const auditKeys = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual(auditKeys, keys,
      'audit-writer.js REDACT_KEYS and server/index.js LOG_REDACT_KEYS have drifted. They are two copies of '
      + 'one policy; a value redacted in the audit trail but not in the log frame (or vice versa) is a leak '
      + 'on whichever side is looser.');
  });

  it('both lists still match by substring, not exact equality', () => {
    // If either implementation is ever switched to exact matching, the pinned
    // disposition above stops being true and this whole file needs revisiting —
    // fail loudly at that moment rather than quietly guarding the wrong thing.
    const serverSrc = fs.readFileSync(path.join(MYTHOS_ROOT, 'server', 'index.js'), 'utf8');
    const auditSrc = fs.readFileSync(
      path.join(MYTHOS_ROOT, 'src', 'core', 'memory', 'audit-writer.js'), 'utf8');
    for (const [label, src] of [['server/index.js', serverSrc], ['audit-writer.js', auditSrc]]) {
      assert.match(src, /\.includes\(\s*r\.toLowerCase\(\)\s*\)/,
        label + ' no longer matches redaction keys by substring — revisit the pinned disposition');
    }
  });
});
