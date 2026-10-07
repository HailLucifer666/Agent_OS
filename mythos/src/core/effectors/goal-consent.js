'use strict';
// goal-consent.js — BUG-446 (2026-10-06): an ACTIVE goal is one the cortex runs on
// its own tick, and the operator's decision is that goal work runs only when they
// ask. So creating a goal, or REOPENING a done one, needs a consent token for
// exactly this call, minted from the operator's own words (voice/authority-gate.js,
// never from model arguments). Closing a goal is always allowed.
//
// Moved out of from-dashboard.js on 2026-10-07: that file is at its size cap
// (file-size-ratchet), and this code arrived together with BUG-468's in the same
// release. Each check names its tool literally, because
// bug-464's (d2) derives the consent-gated tool set by scanning effectors/ for
// verifyConsent(<token>, '<tool>', ...); a tool passed in a variable would be
// invisible to it.
// Probes 2026-10-07, each red in bug-446's suite: createGoalAsked returning true
// (4 fail), reopenGoalAsked returning true (1 fail).
const { verifyConsent } = require('../leash/consent');

function createGoalAsked(args, callCtx) {
  return verifyConsent(callCtx && callCtx.consent, 'create_goal', args).ok;
}

function reopenGoalAsked(args, callCtx) {
  return verifyConsent(callCtx && callCtx.consent, 'toggle_goal', args).ok;
}

// Without a token the goal is saved as an inert proposal, said plainly.
function proposalOnly(goalsEffector, text, category) {
  const proposals = goalsEffector.proposeGoal(text, category, { reason: 'create_goal without the operator asking for a goal' });
  return { proposed: true, proposals, message: 'Saved as a PROPOSAL only, not running: the operator has not asked for a goal in their own words. '
    + 'It starts when they say "create a goal to ..." or accept it on the dashboard.' };
}

function reopenRefusal(goalText) {
  return `Not reopened: "${goalText}" is done, and reopening starts work, which happens only when the operator asks for it in their own words. `
    + 'Ask them to say "reopen" that goal.';
}

module.exports = { createGoalAsked, reopenGoalAsked, proposalOnly, reopenRefusal };
