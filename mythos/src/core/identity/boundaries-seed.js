'use strict';

// boundaries-seed.js — create vault/Identity/boundaries.md when a brand-new
// vault has none.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the freshly installed
// MYTHOS.exe asked for Tier-1/Tier-2 approval on everything, while the dev run
// with the same code never did. Cause chain, measured end to end:
//
//   1. electron/main.js had no app.setName, so the install's userData (and
//      therefore its vault) was a DIFFERENT directory from dev's — a second,
//      empty brain with no Identity/boundaries.md in it.
//   2. identity/index.js loadBoundaries() read '' from the missing file, so
//      max_autonomous_tier parsed as undefined.
//   3. init() treated undefined as MALFORMED and applied the §11 fail-safe:
//      clamp to tier 1 + a critical anomaly.
//   4. leash/index.js takes Math.min(config.AUTONOMOUS_MAX_TIER,
//      identity.getMaxAutonomousTier()), so the ceiling was 1 no matter what the
//      operator had configured, and every Tier-2 tool asked.
//
// Steps 2-4 are all correct behaviour for a CORRUPT file. They are the wrong
// answer for a file that was never written, which is a fresh install — not
// evidence of tampering. So: seed the file here, from the operator's own
// configured ceiling, and let identity/index.js keep its fail-safe for the
// genuinely malformed case.
//
// WHY THIS IS ITS OWN MODULE, and not a few lines in an existing one. Two
// contract tests (test/identity-boundaries-contract.test.js) hold the write path
// shut, deliberately and correctly:
//   - src/core/identity/index.js may contain NO write-family call against a
//     boundaries path — statically scanned AND spied at runtime.
//   - src/core/memory/identity.js may not so much as mention "boundaries".
// boundaries.md is human-editable-only: nothing that can be influenced by the
// entity's own learning loop may write it. A separate module called ONCE from
// the boot sequence (src/main.js, at vault init) keeps that property intact and
// keeps the one writer easy to find.
//
// It writes ONLY when the file does not exist. It never rewrites, never merges,
// and never touches a file the operator has edited.

const CANONICAL_TIER = 2;

// The seeded content is deliberately the same shape identity/index.js parses
// (loadBoundaries' three regexes) and is commented FOR THE OPERATOR, because
// this file is the one piece of the vault they are expected to edit by hand.
function renderBoundaries(tier) {
  return `# MYTHOS Boundaries

# This file is yours. MYTHOS reads it and never writes it.
# It was created automatically on first boot because no boundaries file existed;
# everything below is a starting point you are meant to change.

## Max Autonomous Tier
# The highest tool tier MYTHOS may run WITHOUT asking you first (0-4).
# The effective ceiling is the MOST RESTRICTIVE of this value and
# AUTONOMOUS_MAX_TIER in your configuration — this file can tighten that ceiling
# but never widen it. Lower it to 1 to be asked about anything that touches the
# outside world; raise it to 3 to stop being asked about sends and deletes.
max_autonomous_tier: ${tier}

## Deny Rules (absolute blocks)
# One tool name per line, each on its own "deny:" line. A denied tool is refused
# outright — not escalated, not confirmable, not overridable by a grant.
# Example:
# deny: kill_session

## Allowed Directories
# File tools are confined to these paths. An empty list means the built-in
# default applies.
allowed_dirs:
`;
}

// seedBoundaries({fs, config, logger}) ->
//   {status:'exists'|'seeded'|'failed', tier?, error?}
//
// `fs` is a memory/fs-store instance (vault-relative paths). Never throws: a
// read-only vault is a degraded install, not a reason to refuse to boot — and
// identity/index.js's absent-file branch covers exactly that outcome.
function seedBoundaries({ fs, config, logger } = {}) {
  const log = logger || { info() {}, warn() {} };
  const relPath = 'Identity/boundaries.md';

  try {
    if (fs.exists(relPath)) return { status: 'exists' };
  } catch (err) {
    return { status: 'failed', error: `could not check for ${relPath}: ${err.message}` };
  }

  // Seed AT the operator's configured ceiling, not at some invented default.
  // Seeding lower would recreate the incident this module exists to end (a
  // silently narrower ceiling than the configuration says); seeding higher would
  // widen it, which a file MYTHOS wrote itself must never do. Matching the
  // config makes the Math.min in leash/index.js a no-op, which is the honest
  // outcome: the operator's configuration is the only ceiling in play.
  const configured = Number(config && config.AUTONOMOUS_MAX_TIER);
  const tier = Number.isInteger(configured) && configured >= 0 && configured <= 4
    ? configured
    : CANONICAL_TIER;

  try {
    fs.ensureDir(fs.vaultPath('Identity'));
    fs.writeText(relPath, renderBoundaries(tier));
  } catch (err) {
    log.warn('identity.boundaries.seed-failed', { path: relPath, error: err.message });
    return { status: 'failed', error: err.message };
  }

  log.info('identity.boundaries.seeded', { path: relPath, max_autonomous_tier: tier });
  return { status: 'seeded', tier };
}

module.exports = { seedBoundaries, renderBoundaries, CANONICAL_TIER };
