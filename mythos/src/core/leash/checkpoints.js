'use strict';

// leash/checkpoints.js — persistent workflow-approval gates. DISTINCT from:
//   - leash/confirm.js: 30s single-action T3/T4 confirm, connection-scoped, no
//     continuation, no goal-grant side effect.
//   - memory/checkpoints.js: an UNRELATED working-memory crash-recovery snapshot
//     (tick/activeGoalId). Same English word, nothing to do with each other.
//
// A "checkpoint" here is a long-lived (default 30 min, CHECKPOINT_TTL_MS) human
// approval gate for a multi-step workflow (Forge: plan-approval, mid-build,
// final-review; Research: scope-approval, report-ready). Pending checkpoints
// hold a live onApprove/onReject closure — this is why they CANNOT survive a
// restart (a function cannot be serialized). This module NEVER pretends
// otherwise: init() only reloads RESOLVED history (for list()/audit browsing).
// Any owner of an in-flight workflow (Forge) is responsible for re-arming its
// own pending checkpoints from ITS OWN persisted state at its own init().

const crypto = require('crypto');

const HISTORY_FILE = 'Checkpoints/checkpoint-history.json';
const MAX_HISTORY = 200;

// The exact T3 tools a 'plan-approval' checkpoint pre-authorises for its goal.
// Deliberately minimal: the human approved a BUILD PLAN, so they authorised
// building and revising that project — nothing else. Adding to this list widens
// what one build approval silently permits for the whole life of the goal, so it
// needs a safety review, and test/leash-grant-scope.test.js asserts that the
// outward-facing/destructive T3 tools stay out of it.
const PLAN_APPROVAL_GRANT_TOOLS = ['build_project', 'revise_project'];

function createCheckpointRegistry({ config, bus, auditWriter, goals, fs }) {
  if (!config) throw new Error('createCheckpointRegistry requires config');
  if (!bus) throw new Error('createCheckpointRegistry requires bus');
  if (!auditWriter || typeof auditWriter.write !== 'function') {
    throw new Error('createCheckpointRegistry requires auditWriter with write()');
  }
  // goals/fs are soft deps: missing goals skips grantTier (logged, never throws);
  // missing fs skips history persistence (in-memory only for that run).

  const TTL_MS = config.CHECKPOINT_TTL_MS;
  const pending = new Map();   // id -> record (incl. onApprove/onReject closures)
  let history = [];            // resolved records, JSON-safe, newest last

  function persistHistory() {
    if (!fs) return;
    try { fs.writeJSON(HISTORY_FILE, history.slice(-MAX_HISTORY)); }
    catch (err) { bus.emit('health.anomaly', { kind: 'checkpoint-history-persist-failed', error: err.message }); }
  }

  function init() {
    if (!fs) return { loadedHistory: 0 };
    try { history = fs.readJSON(HISTORY_FILE, []); } catch (_) { history = []; }
    if (!Array.isArray(history)) history = [];
    return { loadedHistory: history.length };
  }

  function publicView(rec) {
    return {
      id: rec.id, kind: rec.kind, title: rec.title, body: rec.body,
      goalId: rec.goalId, projectId: rec.projectId, connectionId: rec.connectionId,
      status: rec.status, createdAt: rec.createdAt, resolvedAt: rec.resolvedAt || null,
      ttlMs: rec.ttlMs,
    };
  }

  function create({ kind, title, body, goalId, projectId, connectionId, ttlMs, onApprove, onReject }) {
    if (!kind) throw new Error('checkpoint kind required');
    const rec = {
      id: 'checkpoint-' + crypto.randomUUID(), kind, title: title || kind, body: body || '',
      goalId: goalId != null ? goalId : null,
      projectId: projectId != null ? projectId : null,
      connectionId: connectionId || 'system',
      status: 'pending', createdAt: Date.now(), resolvedAt: null,
      ttlMs: ttlMs || TTL_MS,
      onApprove: typeof onApprove === 'function' ? onApprove : null,
      onReject: typeof onReject === 'function' ? onReject : null,
    };
    pending.set(rec.id, rec);
    bus.emit('checkpoint.created', publicView(rec));
    return publicView(rec);
  }

  function isExpired(rec) { return Date.now() - rec.createdAt > rec.ttlMs; }

  function writeAudit(rec, decision) {
    return auditWriter.write({
      goalId: rec.goalId, tool: 'checkpoint:' + rec.kind,
      args: { projectId: rec.projectId, title: rec.title },
      tier: 3, decision: decision === 'approved' ? 'allow' : 'deny',
      granted: decision === 'approved', outcome: decision, boundaryHit: null,
    });
  }

  function finalize(rec) {
    const clean = publicView(rec);
    if (rec.feedback) clean.feedback = rec.feedback;
    history.push(clean);
    if (history.length > MAX_HISTORY) history.shift();
    persistHistory();
  }

  async function resolve(id, decision, connectionId, feedback) {
    const rec = pending.get(id);
    if (!rec) return { ok: false, reason: 'not-found' };
    if (rec.connectionId !== 'system' && rec.connectionId !== connectionId) {
      return { ok: false, reason: 'wrong-connection' };
    }
    pending.delete(id);
    if (isExpired(rec)) {
      rec.status = 'expired'; rec.resolvedAt = Date.now();
      writeAudit(rec, 'rejected'); finalize(rec);
      bus.emit('checkpoint.resolved', { id: rec.id, status: 'expired', kind: rec.kind, projectId: rec.projectId });
      return { ok: false, reason: 'expired' };
    }
    rec.status = decision; rec.resolvedAt = Date.now();
    rec.feedback = feedback ? String(feedback).slice(0, 2000) : null;

    // Approving a build plan grants the goal a standing T3 pass for the BUILD
    // TOOLS ONLY (PLAN_APPROVAL_GRANT_TOOLS), so a revision on the same goal
    // doesn't re-prompt — and nothing else does.
    //
    // SECURITY (2026-07-31): this used to call grantTier(goalId, 3) with no tool
    // list, which leash.check() honoured tier-wide. Approving one landing-page
    // build therefore also pre-authorised gmail_send, delete_file, run_command,
    // phone_call and every other T3 tool for that goal — silently, for the life
    // of the goal record. The grant now names exactly what the plan-approval
    // modal actually disclosed to the human.
    if (decision === 'approved' && rec.kind === 'plan-approval' && rec.goalId && goals && typeof goals.grantTier === 'function') {
      try { goals.grantTier(rec.goalId, 3, PLAN_APPROVAL_GRANT_TOOLS); }
      catch (err) { bus.emit('health.anomaly', { kind: 'checkpoint-grant-failed', id: rec.id, error: err.message }); }
    }

    writeAudit(rec, decision);
    bus.emit('checkpoint.resolved', { id: rec.id, status: rec.status, kind: rec.kind, projectId: rec.projectId });
    finalize(rec);

    try {
      if (decision === 'approved' && rec.onApprove) await rec.onApprove(rec);
      if (decision === 'rejected' && rec.onReject) await rec.onReject(rec, rec.feedback);
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'checkpoint-continuation-failed', id: rec.id, error: err.message });
    }
    return { ok: true, status: rec.status };
  }

  const accept = (id, connectionId, feedback) => resolve(id, 'approved', connectionId, feedback);
  const reject = (id, connectionId, feedback) => resolve(id, 'rejected', connectionId, feedback);

  function get(id) {
    const rec = pending.get(id);
    if (rec) return publicView(rec);
    return history.find((h) => h.id === id) || null;
  }

  function list(filter) {
    filter = filter || {};
    let all = Array.from(pending.values()).map(publicView).concat(history.map(publicView));
    if (filter.status) all = all.filter((c) => c.status === filter.status);
    if (filter.projectId) all = all.filter((c) => c.projectId === filter.projectId);
    return all;
  }

  // sweep(): call on an interval (main.js wires CHECKPOINT_SWEEP_MS). Every
  // checkpoint reaches a terminal, AUDITED state — none silently vanish.
  function sweep() {
    let expiredCount = 0;
    for (const rec of Array.from(pending.values())) {
      if (!isExpired(rec)) continue;
      pending.delete(rec.id);
      rec.status = 'expired'; rec.resolvedAt = Date.now();
      writeAudit(rec, 'rejected'); finalize(rec);
      bus.emit('checkpoint.resolved', { id: rec.id, status: 'expired', kind: rec.kind, projectId: rec.projectId });
      if (rec.onReject) { try { rec.onReject(rec, 'expired'); } catch (_) {} }
      expiredCount++;
    }
    return expiredCount;
  }

  return { init, create, accept, reject, get, list, sweep };
}

module.exports = { createCheckpointRegistry };
