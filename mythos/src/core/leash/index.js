'use strict';

// leash/index.js — tiered autonomy gate. Mandatory dispatch checkpoint between
// Cortex's decide() and Effectors' invoke() (cortex/index.js act(), step 1: the
// Phase 4.5 D-39 fix makes leash.check() unconditional — createCortex throws
// at construction if leash is missing, it never skips the gate at call time).
//
// Real signature (see MYTHOS-PHASE-BUILD-SPEC.md Phase 5, "Spec Ambiguities
// Resolved" #2 — goals/effectors are required constructor deps, not free
// variables closed over from nowhere):
//   createLeash({ bus, config, identity, auditWriter, goals, effectors })

var TIER_TABLE = require('./tiers').TIER_TABLE;
var createConfirmRegistry = require('./confirm').createConfirmRegistry;

function createLeash(deps) {
  var bus = deps.bus, config = deps.config, identity = deps.identity;
  var auditWriter = deps.auditWriter, goals = deps.goals, effectors = deps.effectors;
  var scanner = deps.scanner;  // P23: optional credential scanner

  // Mandatory dependencies — fail construction loudly, never no-op at call time
  // (Lesson #3). identity/effectors get boot-time stubs until Phase 8/7 ship
  // (see main.js) — this constructor never special-cases their absence.
  if (!bus) throw new Error('createLeash requires bus');
  if (!config) throw new Error('createLeash requires config');
  if (!identity || typeof identity.checkBoundary !== 'function') {
    throw new Error('createLeash requires identity with checkBoundary() — inject a stub until Phase 8 ships, never omit this dependency');
  }
  if (typeof identity.getMaxAutonomousTier !== 'function') {
    throw new Error('createLeash requires identity with getMaxAutonomousTier() — Phase 8 must add this to the real identity module and its boot-time stub alike');
  }
  if (!auditWriter || typeof auditWriter.write !== 'function') {
    throw new Error('createLeash requires auditWriter with write() — pass memory.audit');
  }
  if (!goals || typeof goals.get !== 'function') {
    throw new Error('createLeash requires goals with get() — needed to read per-goal T3 grants');
  }
  if (!effectors || typeof effectors.get !== 'function') {
    throw new Error('createLeash requires effectors with get() — inject a stub until Phase 7 ships, never omit this dependency');
  }

  var confirmRegistry = createConfirmRegistry({ config: config });

  // Builds the Audit Trail schema entry (MYTHOS-ARCHITECTURE.md §9) and writes it.
  // Fields NOT set here (id, ts, actor) are auto-filled by memory/audit-writer.js.
  //
  // CROSS-PHASE FIX (consistency pass, P5 vs P9): P9's server/index.js subscribes
  // to 'audit.decision' (exact string, dot-prefixed — matches the bus taxonomy's
  // first-dot-segment=channel rule, channel 'audit') to relay live decisions to
  // the Audit view. writeAudit() must emit it, in addition to (not instead of)
  // the durable auditWriter.write() below — the write is the record, the emit is
  // the live-tail signal for the UI.
  function writeAudit(action, goalId, tier, decision, extra) {
    var entry = Object.assign({
      goalId: goalId || null,
      traceId: action.traceId || null,   // no real source yet — see spec Ambiguity #9
      tool: action.tool,
      args: action.args || {},
      tier: tier,
      decision: decision,
      granted: false,
      outcome: null,
      boundaryHit: null
    }, extra || {});
    var writeResult = auditWriter.write(entry);
    bus.emit('audit.decision', entry);
    return writeResult;
  }

  // FAIL-CLOSED: T>=3 if the audit line couldn't be written, deny regardless of
  // what was otherwise decided. T0-T2 continue without audit (fail-open for
  // reads/local-writes) — exact policy text from the Audit Trail section.
  function failClosedIfUnwritable(tier, writeResult, decision) {
    if (tier >= 3 && writeResult && writeResult.ok === false) {
      return { allow: false, requireConfirm: false, tier: tier, reason: 'audit-unwritable-fail-closed' };
    }
    return decision;
  }

  function check(action, goalCtx) {
    var toolName = action.tool;
    var args = action.args || {};
    var tier = TIER_TABLE[toolName];  // static tier — undefined for unknown tools

    // Args-aware override (e.g., pipeline_advance with reject). effectors.get()
    // returns undefined for any tool Phase 7 hasn't registered yet — that is the
    // safe default; the override can only RAISE tier, never lower it.
    var effector = effectors.get(toolName);
    if (effector && typeof effector.dangerWhen === 'function' && effector.dangerWhen(args)) {
      tier = Math.max(tier === undefined ? 3 : tier, 3);  // guard vs. NaN
    }

    // Unknown tool -> T3 fail-safe. Resolved here — BEFORE the DRY_RUN and
    // maxTier comparisons below, both of which do `tier >= N` — because
    // `undefined >= 1` is always false in JS. Post-build security audit
    // (Phase 5) found that leaving this resolution at its originally-spec'd
    // position (after the DRY_RUN gate) let an unmapped/hallucinated tool
    // name skip the DRY_RUN no-op entirely and fall through to the maxTier
    // check, auto-allowing for real whenever AUTONOMOUS_MAX_TIER >= 3. Moving
    // the resolution earlier changes nothing for tools that ARE in
    // TIER_TABLE; it only closes the gap for tools that aren't.
    if (tier === undefined) tier = 3;

    // P23: Credential scan — before any T3/T4 effector executes, scan args for
    // secret patterns. If found, deny immediately (credential leak prevention).
    // The scanner output is always redacted — never echoes the full secret.
    if (tier >= 3 && scanner) {
      var credScan = scanner.scan(args);
      if (credScan.found) {
        var credReason = 'credential-detected: ' + credScan.matches.map(function(m) { return m.name + '(' + m.sample + ')'; }).join(', ');
        var credWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'deny', { boundaryHit: 'credential-leak', reason: credReason });
        return failClosedIfUnwritable(tier, credWrite, { allow: false, requireConfirm: false, tier: tier, reason: credReason });
      }
    }

    // DRY RUN -> T>=1 becomes logged no-op. Read config.MYTHOS_DRY_RUN live,
    // every call — never cached at createLeash() construction time.
    if (config.MYTHOS_DRY_RUN && tier >= 1) {
      var dryRunWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'dry-run', { reason: 'dry-run' });
      return failClosedIfUnwritable(tier, dryRunWrite, { allow: false, requireConfirm: false, tier: tier, reason: 'dry-run' });
    }

    // 1. Boundaries DENY (absolute blocks from boundaries.md / identity stub)
    var boundaryHit = identity.checkBoundary(toolName, args);
    if (boundaryHit) {
      var denyWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'deny', { boundaryHit: boundaryHit, reason: boundaryHit });
      return failClosedIfUnwritable(tier, denyWrite, { allow: false, requireConfirm: false, tier: tier, reason: boundaryHit });
    }

    // 2. Below maxTier -> auto-allow. Read config.AUTONOMOUS_MAX_TIER live, every
    // call — never cache at construction time (same bug class as D-46). No `|| 2`
    // fallback: the config schema already guarantees a validated 0-4 number.
    // Effective ceiling = MOST RESTRICTIVE of config and boundaries.md (P8).
    // Both read LIVE, every call — never cached at construction. boundaries.md
    // can only tighten, never loosen, beyond config's ceiling.
    var maxTier = Math.min(config.AUTONOMOUS_MAX_TIER, identity.getMaxAutonomousTier());
    if (tier <= maxTier) {
      var allowWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'allow', { reason: 'within-autonomous-max' });
      return failClosedIfUnwritable(tier, allowWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'within-autonomous-max' });
    }

    // 4. T3 -> check per-goal grant (goal.grants['3'], set by goals.grantTier()).
    // Grant dies with the goal record itself — no separate expiry bookkeeping.
    if (tier === 3) {
      var goal = (goalCtx && goalCtx.goalId) ? goals.get(goalCtx.goalId) : null;
      if (goal && goal.grants && goal.grants['3']) {
        var grantedWrite = writeAudit(action, goalCtx.goalId, tier, 'allow', { granted: true, reason: 'goal-granted' });
        return failClosedIfUnwritable(tier, grantedWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'goal-granted' });
      }
      var confirm3Write = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: 'tier-3-requires-confirm' });
      return failClosedIfUnwritable(tier, confirm3Write, { allow: false, requireConfirm: true, tier: tier, reason: 'tier-3-requires-confirm' });
    }

    // 5. T4 -> always confirm, never cached
    var confirm4Write = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: 'tier-4-always-confirm' });
    return failClosedIfUnwritable(tier, confirm4Write, { allow: false, requireConfirm: true, tier: tier, reason: 'tier-4-always-confirm' });
  }

  return {
    check: check,
    confirm: confirmRegistry
  };
}

module.exports = { createLeash };
