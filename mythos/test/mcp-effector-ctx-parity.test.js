'use strict';

// test/mcp-effector-ctx-parity.test.js
//
// THE INCIDENT (2026-08-21 capability audit, source-read).
// mcp/server.js registered the computer effector family as a bare
// `registerFromComputer(hub);` — no ctx at all — while src/main.js:508 passes
// `{ brain, config, logger }`. from-computer.js stores ctx.config into
// vaultRootConfig, and resolveSandboxed()'s vault branch refuses EVERY
// `vault/...` path when that is null, with the reason
// "registerFromComputer was never given ctx.config". On the MCP surface,
// read_file('vault/anything') was therefore unconditionally refused, and
// think_deeply had no brain.
//
// WHY IT SURVIVED, and the reason this file exists at all:
// the MECHANISM was already fully covered — vault-path-resolution.test.js
// tests the configured case, the escape case AND the no-ctx refusal. What had
// no test anywhere was the WIRING: whether a given call site actually supplies
// the ctx the mechanism needs. The bug lived precisely in that gap, so a guard
// on the mechanism could never have caught it. This asserts the call sites.
//
// SEVERITY, bounded honestly: the standalone bootstrap is opt-in and has never
// run. MCP_SERVER_ENABLED defaults false (config/schema.js) and is commented
// out in .env/.env.example; the 2026-08-21 audit records zero MCP calls in the
// entire history. So this was latent fragility on a never-executed path, NOT
// the cause of any observed failure. In particular it does NOT explain the
// audit's `read_file self.md` ENOENTs — those came through the voice surface,
// which goes via src/main.js and has always passed ctx correctly.
//
// There is no runtime seam: the bootstrap is an unexported IIFE guarded by
// `require.main === module`, so calling it would boot a real config/bus/memory/
// identity/goals stack over stdio. Source-shape assertion is the only option
// available, and is the pattern this repo already uses in that situation
// (bug-075, bug-168, bug-272). Per the "source-shape windows are brittle"
// lesson, the parse below scans the WHOLE file for call sites rather than
// pinning line numbers, so adding a comment cannot break it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MCP_SERVER = path.join(__dirname, '..', 'mcp', 'server.js');
const MAIN = path.join(__dirname, '..', 'src', 'main.js');

// Extract { EffectorName: [ctx keys] } from every `registerFromX(hub, {...})`
// call in a file. Deliberately tolerant: optional ctx object, any whitespace,
// any key order. Only the top level of the object literal is read, which is
// all these call sites ever use.
function ctxKeysByEffector(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = Object.create(null);
  const re = /registerFrom([A-Za-z]+)\(\s*hub\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const keys = String(m[2] || '')
      .split(',')
      .map((s) => s.split(':')[0].trim())
      .filter(Boolean)
      .sort();
    found[m[1]] = keys;
  }
  return found;
}

// The drift that existed when this guard was written and was deliberately NOT
// closed in the same change. Each entry is a real gap of the same shape as the
// Computer one, on the same never-executed surface. They are pinned rather
// than fixed because closing them means handing effectors dependencies whose
// behaviour cannot be verified live on a surface that has never run, and a
// speculative widening of five effectors is not what the fix was for. Pinning
// them here means the set cannot grow silently: a NEW drift fails this test.
// Escalated separately for individual, verifiable treatment.
const PINNED_KNOWN_DRIFT = {
  Browser: ['fs'],
  Calendar: ['goals'],
  Memory: ['notes'],
  Pc: ['config', 'logger'],
  Spotify: ['bus', 'config', 'goals', 'memory'],
};

describe('mcp/server.js effector registration passes the ctx each effector needs', () => {
  const mcp = ctxKeysByEffector(MCP_SERVER);
  const main = ctxKeysByEffector(MAIN);

  // Stage 4 #6: prove the parse matched something before trusting any
  // assertion built on it. A regex that silently matched nothing would make
  // every check below pass vacuously — which is exactly how a guard reads as
  // coverage while testing air.
  it('the source parse actually found the call sites (negative control)', () => {
    assert.ok(
      Object.keys(mcp).length >= 8,
      'expected to parse many registerFrom* calls from mcp/server.js, got ' +
        JSON.stringify(Object.keys(mcp))
    );
    assert.ok(
      Object.keys(main).length >= 8,
      'expected to parse many registerFrom* calls from src/main.js, got ' +
        JSON.stringify(Object.keys(main))
    );
    assert.ok('Computer' in mcp, 'registerFromComputer must be present in mcp/server.js');
    assert.ok('Computer' in main, 'registerFromComputer must be present in src/main.js');
  });

  // The actual defect. Written from the requirement — from-computer.js reads
  // ctx.config (vault root), ctx.brain (think_deeply) and ctx.logger — not
  // from whatever the code currently happens to pass.
  it('registerFromComputer receives config, so the vault branch can resolve', () => {
    assert.ok(
      mcp.Computer.includes('config'),
      'without ctx.config, resolveSandboxed() refuses every vault/... path on the MCP ' +
        'surface with "registerFromComputer was never given ctx.config". Got ctx keys: ' +
        JSON.stringify(mcp.Computer)
    );
  });

  it('registerFromComputer receives brain, so think_deeply can dispatch', () => {
    assert.ok(
      mcp.Computer.includes('brain'),
      'without ctx.brain, think_deeply fails with a named missing-dependency reason. ' +
        'Got ctx keys: ' + JSON.stringify(mcp.Computer)
    );
  });

  it('registerFromComputer receives the full ctx src/main.js passes (no drift)', () => {
    const missing = main.Computer.filter((k) => !mcp.Computer.includes(k));
    assert.deepEqual(
      missing,
      [],
      'mcp/server.js must pass the same ctx main.js does for the computer family; missing: ' +
        JSON.stringify(missing)
    );
  });

  // Stage 3 #6 — the class guard. The Computer gap was not unique; six
  // effectors drifted. This locks the remainder so the set can only shrink.
  it('no NEW ctx drift appears on the MCP surface beyond the pinned set', () => {
    const unexpected = {};
    for (const name of Object.keys(mcp)) {
      if (!main[name]) continue; // registered on only one surface — not a parity claim
      const missing = main[name].filter((k) => !mcp[name].includes(k));
      if (!missing.length) continue;
      const pinned = PINNED_KNOWN_DRIFT[name] || [];
      const beyond = missing.filter((k) => !pinned.includes(k));
      if (beyond.length) unexpected[name] = beyond;
    }
    assert.deepEqual(
      unexpected,
      {},
      'new ctx drift between src/main.js and mcp/server.js. Either pass the ctx on the MCP ' +
        'surface, or add it to PINNED_KNOWN_DRIFT with a reason. Drift: ' +
        JSON.stringify(unexpected)
    );
  });

  // Stage 3 #8 — pin the disposition. If someone closes one of the pinned
  // gaps, this fails and tells them to delete the stale entry, so the pinned
  // list cannot rot into a description of a problem that no longer exists.
  it('the pinned drift list describes drift that is still real', () => {
    const stale = [];
    for (const name of Object.keys(PINNED_KNOWN_DRIFT)) {
      if (!mcp[name] || !main[name]) { stale.push(name + ' (no longer on both surfaces)'); continue; }
      const missing = main[name].filter((k) => !mcp[name].includes(k));
      for (const k of PINNED_KNOWN_DRIFT[name]) {
        if (!missing.includes(k)) stale.push(name + '.' + k);
      }
    }
    assert.deepEqual(
      stale,
      [],
      'PINNED_KNOWN_DRIFT names gaps that are now closed — remove them: ' + JSON.stringify(stale)
    );
  });
});
