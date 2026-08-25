'use strict';

// Pins a DELIBERATE non-change (repo rule: "deliberately not changing behavior →
// say why in code and add a regression test that locks it in").
//
// The 2026-08-19 audit listed "blocking appendFileSync on the voice hot path" and
// proposed an async queue for T0–T2 audit writes, keeping the synchronous path
// only for the tier >= 3 fail-closed check. Measurement killed it: one write
// costs 0.169ms p50 / 0.826ms max on the operator's real vault, and 0.195ms mean
// even against a 52MB day file. A voice turn makes one to three leash.check()
// calls. The saving is a fraction of a millisecond; the risk is the gate below.
//
// leash.js's failClosedIfUnwritable reads `writeResult.ok === false` on the same
// tick as the write. Any deferral — a promise, a queue handle, anything not
// resolved by the time check() inspects it — turns that comparison false forever
// and silently converts fail-CLOSED into fail-OPEN for every T3/T4 action whose
// audit line could not be written. The reason string never changes, so the
// existing leash tests stay green while the gate is disarmed. That is the exact
// failure this file exists to catch.

const { test } = require('node:test');
const assert = require('node:assert');

const { createAuditWriter } = require('../src/core/memory/audit-writer');
const { createLeash } = require('../src/core/leash');

function collectingBus() {
  const events = [];
  return { events, emit(type, payload) { events.push({ type, payload }); } };
}

function writerWith(appendLine) {
  const bus = collectingBus();
  const audit = createAuditWriter({
    fs: { appendLine, listFiles: () => [], ensureDir() {}, vaultPath: (p) => p },
    config: {}, bus, logger: { info() {}, warn() {} },
  });
  return { audit, bus };
}

test('write() returns a resolved verdict synchronously, never a thenable', () => {
  const { audit } = writerWith(() => {});
  const result = audit.write({ tool: 'get_time', decision: 'allow', tier: 0 });

  assert.equal(result.ok, true);
  assert.equal(typeof result.then, 'undefined',
    'write() must not return a promise: leash.js reads .ok on the same tick, and a ' +
    'thenable makes `ok === false` unreachable — fail-closed becomes fail-open');
});

test('a failed write reports ok:false on the same tick, and says so on the bus', () => {
  const { audit, bus } = writerWith(() => { throw new Error('EACCES: vault is read-only'); });
  const result = audit.write({ tool: 'gmail_send', decision: 'allow', tier: 3 });

  assert.equal(result.ok, false, 'the failure must be visible to the caller immediately');
  assert.equal(result.degraded, true);
  const anomalies = bus.events.filter((e) => e.type === 'health.anomaly'
    && e.payload.kind === 'audit-write-failed');
  assert.equal(anomalies.length, 1, 'an unwritable audit trail is a health event, not a silent skip');
});

test('the entry is stamped and redacted before write returns, not afterwards', () => {
  // leash.js emits `audit.decision` with the SAME object it passed to write(),
  // immediately after write() returns, and the Audit view renders that. If
  // stamping or redaction moved behind a queue, the UI would show a record with
  // no id, no timestamp, and — the part that matters — an unredacted apiKey.
  const written = [];
  const { audit } = writerWith((relPath, obj) => written.push({ relPath, obj }));
  const entry = { tool: 'mcp_call_tool', decision: 'allow', tier: 3, args: { apiKey: 'sk-real-secret', q: 'hi' } };

  const result = audit.write(entry);

  assert.equal(result.ok, true);
  assert.equal(written.length, 1, 'the line must already be on disk when write() returns');
  assert.ok(entry.id, 'id stamped on the caller-visible object');
  assert.equal(typeof entry.ts, 'number', 'ts stamped on the caller-visible object');
  assert.equal(entry.actor, 'cortex');
  assert.equal(entry.args.apiKey, '[REDACTED]',
    'redaction must happen before write() returns — the same object is emitted to the UI');
  assert.equal(entry.args.q, 'hi', 'non-secret args survive redaction');
});

test('leash denies a T3 action when the audit line cannot be written, and allows T0', () => {
  // End-to-end through the real gate, so the contract is pinned where it is
  // actually consumed rather than only at the writer's boundary.
  function leashWith(appendLine, maxTier) {
    const { audit, bus } = writerWith(appendLine);
    return createLeash({
      bus, config: { AUTONOMOUS_MAX_TIER: maxTier, MYTHOS_DRY_RUN: false, TRUSTED_TOOLS_DISABLED: true },
      identity: { checkBoundary: () => null, getMaxAutonomousTier: () => maxTier },
      auditWriter: audit, goals: { get: () => null }, effectors: { get: () => undefined },
    });
  }
  const broken = () => { throw new Error('EACCES'); };

  // gmail_send is T3 and on NEVER_TRUSTABLE, so nothing else can allow it.
  const t3 = leashWith(broken, 3).check({ tool: 'gmail_send', args: { to: 'x@y.z' } }, {});
  assert.equal(t3.allow, false, 'T3 with an unwritable audit trail must be denied');
  assert.equal(t3.reason, 'audit-unwritable-fail-closed');

  // T0/T1/T2 are documented as fail-OPEN: a read must not become unavailable
  // because the audit disk filled up.
  const t0 = leashWith(broken, 2).check({ tool: 'get_time', args: {} }, {});
  assert.equal(t0.allow, true, 'T0 stays fail-open — that half of the policy is deliberate too');
});
