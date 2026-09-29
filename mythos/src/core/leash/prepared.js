'use strict';

// leash/prepared.js — the server-owned record a tool's prepare() step produced
// for ONE decision object (2026-09-29 audit, B2a).
//
// Resolution is separate from authorization: leash.prepare(decision) resolves
// (asynchronously — launch_app asks pc-child which program a name means), and
// leash.check(decision) authorizes on what was resolved. The record lives in
// this WeakMap, keyed by the decision object itself, because every other place
// is reachable by someone who should not write it: a field on the decision
// could arrive in the model's own arguments, and survives any JSON round trip
// that would otherwise launder it. A WeakMap entry cannot be forged from JSON,
// is lost by a copy (so a copied decision is simply "not prepared" and is
// refused), and dies with the decision.
//
// The confirm registry stores the decision object verbatim and hands the SAME
// object back on accept (leash/confirm.js), so what the operator approved is
// exactly what dispatch-action.js later passes to the effector as ctx.prepared.

const records = new WeakMap();

function remember(decision, entry) {
  if (!decision || typeof decision !== 'object') throw new Error('prepared: a decision object is required');
  records.set(decision, Object.freeze({ ...entry }));
}

function preparedOf(decision) {
  return decision && typeof decision === 'object' ? records.get(decision) : undefined;
}

// The reason leash.prepare() records when a tool's prepare() did not answer in
// time — a tool's approvalFor() can then say "try again", not "not found".
const PREPARE_TIMEOUT = 'prepare-timeout';

module.exports = { remember, preparedOf, PREPARE_TIMEOUT };
