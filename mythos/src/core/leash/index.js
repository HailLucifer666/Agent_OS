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

// BUG-142: sessionGrants (below) was only ever .set() and read — an expired entry
// (or one left behind by a connection that never reconnects: voice
// reconnects, Electron restarts, tab reloads) sat in the Map forever.
// Opportunistic sweep, not a timer: deletes ONLY entries whose expiresAt has
// already passed — the read path in check() already treats those as not-live
// (`Date.now() < sessionExpiry`), so removing them here changes nothing about
// any allow/deny/confirm outcome, only memory growth. Factored to module
// scope (taking the Map + a clock fn) so it is unit-testable without
// exercising the full createLeash() construction/accept() flow.
function sweepExpiredSessionGrants(grants, now) {
  var cutoff = typeof now === 'function' ? now() : Date.now();
  grants.forEach(function(expiresAt, key) {
    if (expiresAt < cutoff) grants.delete(key);
  });
}

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

  // Wave 1 (2026-08-13): a confirm that times out with nobody answering used
  // to vanish silently — no audit row, no anomaly, and the caller (e.g. the
  // Live session waiting to tell the model what happened) never heard about
  // it either. onExpire runs the two things this module already owns
  // (auditWriter/bus) and ALSO emits a routable bus event — 'confirm-expired'
  // — carrying the entry's connectionId, so server/index.js (which owns the
  // per-connection liveAdapter this module has no reach into) can route an
  // EXPIRED verdict back to the exact Live session that raised the confirm,
  // the same way it already routes confirm-request/confirm-resolved over the
  // bus rather than through a constructor-time callback.
  var confirmRegistry = createConfirmRegistry({
    config: config,
    onExpire: function(confirmId, entry) {
      var action = entry && entry.action;
      // BUG-119-class shape mismatch (same bug the accept() wrapper below
      // already documents and fixes): every production caller stores an
      // ENVELOPE — confirm.create(summary, {decision, goalId, tier},
      // connectionId) — not a bare {tool, args}. Reading action.tool/
      // action.tier directly is only ever non-undefined for the test
      // fixtures that pass the bare shape; in production it silently wrote
      // tool:undefined into both the audit deny row and the anomaly,
      // defeating the entire point of making expiry loud (live-verified
      // 2026-08-13 — see BUGS.md). Unwrap .decision when present, exactly
      // like confirmApi.accept() does, so the SAME shape rule holds at both
      // resolution paths of a confirm (accepted or expired).
      var decision = action && action.decision ? action.decision : action;
      var expiredTool = decision && decision.tool;
      var expiredTier = (action && action.tier !== undefined) ? action.tier : (decision && decision.tier);
      try {
        auditWriter.write({
          actor: (action && action.goalId) ? 'cortex' : 'voice',
          tool: expiredTool, tier: expiredTier,
          decision: 'deny', reason: 'confirm-ttl-expired', confirmId: confirmId,
        });
      } catch (_) { /* audit failure must not block the rest of expiry handling */ }
      // BUG-324: the audit row three lines above already records WHY this
      // expired. The anomaly — the only one of the two the operator ever hears
      // about — did not carry it, so immune/explainer.js reached its honest
      // fallback and said "I do not yet know the cause" about a timeout this
      // very function had just written down. Measured on the wired chain
      // 2026-08-23. Same class as BUG-278: the field exists one line away.
      //
      // needsOperator is the truthful flag here, not a convenience. The remedy
      // is a person answering the prompt (or re-issuing the command); every
      // mechanical remedy in the explainer's menu is a wrong answer that also
      // sounds like a right one, which is precisely what BUG-273 C2 added the
      // flag to prevent. It also spares a brain round-trip mid-conversation.
      try {
        bus.emit('health.anomaly', {
          kind: 'confirm-expired-silently', tool: expiredTool, target: expiredTool,
          needsOperator: true,
          // BUG-447 (2026-09-25): the spoken sentence; `reason` keeps the detail.
          sayToOperator: 'Your confirmation' + (expiredTool ? ' for ' + String(expiredTool).replace(/_/g, ' ') : '')
            + ' expired with no answer, so nothing ran.',
          // The TTL is read from config, not from confirmRegistry.stats(): this
          // callback is constructed as an argument to createConfirmRegistry, so
          // reaching back through the variable being assigned would work only
          // because a timer cannot fire before the assignment completes. Same
          // number, no temporal coupling.
          reason: 'A confirmation prompt' + (expiredTool ? ' for ' + expiredTool : '')
            + ' timed out' + (config.LEASH_CONFIRM_TTL_MS ? ' after ' + config.LEASH_CONFIRM_TTL_MS + 'ms' : '')
            + ' with no answer, so the action was denied and nothing ran.'
            + ' Re-issue it if you still want it.',
        });
      } catch (_) {}
      try {
        bus.emit('confirm-expired', { confirmId: confirmId, connectionId: entry && entry.connectionId, tool: expiredTool });
      } catch (_) {}
    },
  });

  // BUG-012: session-scoped T3 grants for GOAL-LESS actions. The per-goal grant
  // check below (goal.grants['3']) can never engage on the voice/conversation
  // path — those actions always carry goalId:null — so every T3 voice action
  // popped a confirm every single time. Accepting a confirm for one of the
  // tools below now also grants THAT SPECIFIC TOOL for SESSION_GRANT_TTL_MS.
  // Deliberately narrow: only repetitive local UI-interaction tools are
  // eligible. Outward-facing or destructive T3 tools (gmail_send,
  // compose_email, delete_goal, build/pipeline execution) stay
  // confirm-every-time by design — do NOT widen this list without a safety
  // review (see BUGS.md BUG-012: raising AUTONOMOUS_MAX_TIER globally was
  // evaluated and rejected as a safety regression). In-memory only.
  var SESSION_GRANT_TTL_MS = 15 * 60 * 1000;
  // spotify_play/spotify_search were re-tiered T3 -> T2 (confirmation-policy
  // pass) and now auto-allow before this branch is ever reached — pruned here
  // since they can no longer match a T3 grant check.
  //
  // BUG-119 (2026-08-06, operator-approved widening — safety-relevant change,
  // recorded here and in the commit message): the browser tools were missing,
  // so every browser_click on the voice path re-prompted. The model, seeing its
  // approved action not take effect as a standing permission, asked again and
  // again, and an approval loop trains an operator to accept without reading —
  // which is worse for safety than the grant itself. browser_click,
  // browser_type and browser_fill_form are the same class as the local UI tools
  // already here: repetitive, scoped to a browser MYTHOS drives, no outward
  // send. Each is granted independently (the key is connectionId + ':' + tool),
  // so approving a click never grants a type.
  //
  // browser_evaluate stays out and is confirm-every-time: it is T4, and T4 is
  // structurally ineligible here anyway (the accept() wrapper below requires
  // TIER_TABLE[tool] === 3). Arbitrary JS in the page is not the same class.
  var SESSION_GRANTABLE = {
    ui_click: 1, ui_type: 1,
    click_at: 1, send_key: 1, focus_window: 1,
    browser_click: 1, browser_type: 1, browser_fill_form: 1
  };
  // OPERATOR-PRESENT TRUST (2026-08-06, operator decision — safety-relevant,
  // recorded here, in src/core/CLAUDE.md and in the commit message).
  //
  // The problem the session grant above does NOT solve. Even with BUG-119 fixed,
  // the first use of every T3 tool in every connection still raises a confirm,
  // and see_and_click/cua_click were never on SESSION_GRANTABLE at all — so
  // "play a song in the Spotify app" (which routes through cua_click) confirmed
  // every single time, forever. Approval fatigue is a safety failure, not a
  // cosmetic one: an operator who clicks Approve fifty times a day stops reading
  // the prompt and the gate becomes a rubber stamp. That is the same argument
  // BUG-119 already accepted for the browser tools, applied one step further.
  //
  // The mechanism, and why it is contained. check() receives a connectionId from
  // exactly two call sites, both with a human at the other end:
  //
  //   voice/voice-agent.js:495        { connectionId }                human
  //   voice/live-tool-adapter.js:271  { connectionId, goalId: null }  human
  //   cortex/index.js:278             { goalId }                      autonomous
  //   engagements/executor.js:272/422 { goalId: record.goalId }       LLM-authored
  //   sensors/reminder-sensor.js:37   { goalId }                      unattended
  //
  // So gating on operator-presence gives the human zero prompts for local,
  // reversible actions they asked for out loud, and gives cortex, the engagement
  // executor and the reminder sensor nothing at all. connectionId is LOAD-BEARING
  // for that containment — do not start passing it from an unattended path.
  //
  // This is deliberately NOT a tier change and NOT a ceiling raise. Re-tiering
  // these to T2 would auto-allow them for the autonomous loop too — the exact
  // mistake that let a build launch itself unasked mid-conversation on
  // 2026-07-29 (see tiers.js's build-tool re-tier note), and BUGS.md records
  // raising AUTONOMOUS_MAX_TIER globally as evaluated and rejected as a safety
  // regression. That rejection stands; this routes around the fatigue instead.
  //
  // send_key is NOT here despite being an obvious member of this class: it is
  // T2 (see tiers.js) and already auto-allows before this branch is reached.
  // focus_window is T1 for the same reason.
  var OPERATOR_TRUSTED_DEFAULT = {
    browser_click: 1, browser_type: 1, browser_fill_form: 1,
    browser_select_option: 1, browser_press_key: 1, browser_upload_file: 1,
    ui_click: 1, ui_type: 1, click_at: 1,
    see_and_click: 1, cua_click: 1,
    close_window: 1
  };

  // Un-overridable. TRUSTED_TOOLS cannot add anything on this list, and neither
  // can a future edit to the default above without deleting an explicit test
  // (test/leash-operator-trusted.test.js, "the hard line"). These are the
  // categories the operator kept gated by name on 2026-08-06: sending,
  // running/installing, deleting, and arbitrary-code/session-killing.
  var NEVER_TRUSTABLE = {
    gmail_send: 1, compose_email: 1, whatsapp_send: 1,
    phone_call: 1, phone_sms_send: 1, phone_whatsapp_send: 1, phone_file_push: 1,
    run_command: 1, install_from_github: 1, mcp_call_tool: 1, dsh_task: 1,
    security_scan: 1,
    build_project: 1, revise_project: 1, pipeline_execute: 1,
    kanban_assemble: 1, kanban_build_card: 1, start_project: 1, run_mission: 1,
    delete_file: 1, delete_goal: 1, delete_artifact: 1,
    reminder_approve_action: 1,
    browser_evaluate: 1, kill_session: 1,
    // Opening the operator's camera. Not destructive, not outward-facing — but it
    // turns on a sensor pointed at a person, and the trust list exists to skip
    // confirms on things whose worst case is a wasted click. Its worst case is a
    // misheard sentence filming a room, so it stays un-trustable by construction
    // (see leash/tiers.js's camera_on entry).
    camera_on: 1
  };

  // TRUSTED_TOOLS is parsed ONCE here so a bad entry is reported at boot rather
  // than on the Nth voice command. Each rejection is emitted by name — silently
  // ignoring an entry is how a config lies to its operator (the same reasoning
  // behind reporting the legacy goal grant below instead of dropping it).
  var trustedTools = Object.assign({}, OPERATOR_TRUSTED_DEFAULT);
  String(config.TRUSTED_TOOLS || '')
    .split(',')
    .map(function(n) { return n.trim(); })
    .filter(function(n) { return n.length > 0; })
    .forEach(function(name) {
      var why = null;
      if (NEVER_TRUSTABLE[name]) why = 'never-trustable: this tool sends, runs, deletes or executes arbitrary code';
      else if (TIER_TABLE[name] !== 2 && TIER_TABLE[name] !== 3) {
        why = TIER_TABLE[name] === undefined
          ? 'not a known tool — check the spelling against leash/tiers.js'
          : 'not tier 2 or 3 (it is tier ' + TIER_TABLE[name] + ') — trust is T2/T3-only';
      }
      if (why) {
        bus.emit('health.anomaly', {
          kind: 'leash-trusted-tool-ignored',
          target: name,
          evidence: { tool: name, reason: why }
        });
        return;
      }
      trustedTools[name] = 1;
    });

  // A real human connection is driving. 'system' is excluded deliberately:
  // voice-agent.js passes `connectionId || 'system'` into confirm.create, so the
  // sentinel exists in this codebase and must never read as a human here.
  function isOperatorPresent(ctx) {
    return !!(ctx && ctx.connectionId && ctx.connectionId !== 'system');
  }

  // TIER_TABLE[name] === 2 or 3 is required (Tier 2 shares Tier 3's escape
  // hatches — see the combined grant block below). T4 stays structurally
  // ineligible, and an unknown tool that fell back to the T3 fail-safe never
  // matches because it is not in the table at all.
  function isTrusted(name) {
    return !!trustedTools[name] && !NEVER_TRUSTABLE[name] &&
      (TIER_TABLE[name] === 2 || TIER_TABLE[name] === 3);
  }

  // Keyed by connectionId + ':' + tool (BUG-012 follow-up, security HIGH):
  // was keyed by bare tool name, so an accept on one WS connection granted
  // EVERY connection (including the autonomous goal loop, which passes no
  // connectionId at all). Scoping to the accepting connection closes that.
  var sessionGrants = new Map(); // 'connectionId:tool' -> expiresAt (ms epoch)

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
    //
    // SECURITY (2026-07-31): the grant is a LIST OF TOOL NAMES and only matches
    // the tool actually named in it. It used to be a bare boolean honoured for
    // the whole tier, which meant approving a single Forge build plan gave the
    // goal a standing pass for every T3 tool that later carried the same
    // goalId — gmail_send, delete_file, run_command, phone_call, phone_sms_send,
    // browser_click, install_from_github, dsh_task. Two live consumers made
    // that reachable with no external attacker: engagements/executor.js checks
    // LLM-authored {tool,args} stages against this gate with goalId set (so any
    // untrusted text reaching the spec could steer it), and cortex/index.js
    // passes its own activeGoalId on every autonomous tick. See
    // test/leash-grant-scope.test.js.
    // Tier 2 shares Tier 3's escape hatches. Before this, tier 2 matched no
    // branch — not the ceiling allow above, not this block — and fell through
    // to the T4 tail, which refused it with reason 'tier-4-always-confirm' and
    // gave it no way to ever be granted. That is what made the media widget's
    // buttons inert and made "play a song" confirm every single time.
    if (tier === 2 || tier === 3) {
      var goal = (tier === 3 && goalCtx && goalCtx.goalId) ? goals.get(goalCtx.goalId) : null;
      var goalGrant = (goal && goal.grants) ? goal.grants['3'] : undefined;
      // A legacy pre-scoping grant (bare `true` persisted by an older build) is
      // deliberately NOT honoured: there is no way to recover which tools the
      // human originally saw, so it fails closed to a fresh confirm. Reported
      // rather than ignored silently — an operator seeing one re-prompt after
      // an upgrade should be able to find out why.
      if (goalGrant === true) {
        bus.emit('health.anomaly', {
          kind: 'goal-grant-legacy-unscoped',
          target: goalCtx.goalId,
          evidence: { tool: toolName, reason: 'tier-wide grant ignored; re-confirm required' }
        });
        goalGrant = undefined;
      }
      if (Array.isArray(goalGrant) && goalGrant.indexOf(toolName) !== -1) {
        var grantedWrite = writeAudit(action, goalCtx.goalId, tier, 'allow', { granted: true, reason: 'goal-granted' });
        return failClosedIfUnwritable(tier, grantedWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'goal-granted' });
      }
      // Operator-present trust. Placed AFTER the goal grant and BEFORE the
      // session grant, which it supersedes for any tool on both lists — so the
      // audit reason is unambiguous rather than depending on whether a confirm
      // happened to have been accepted earlier. Everything that must win over
      // trust already ran above and returned: the credential scan, the
      // boundaries.md deny and the DRY_RUN gate. TRUSTED_TOOLS_DISABLED is read
      // per call rather than cached at construction (same discipline as
      // AUTONOMOUS_MAX_TIER) — note the real config object is frozen at boot, so
      // an .env edit still needs a restart; this only guarantees the leash never
      // holds a stale copy of the switch.
      if (!config.TRUSTED_TOOLS_DISABLED && isOperatorPresent(goalCtx) && isTrusted(toolName)) {
        var trustWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'allow', { granted: true, reason: 'operator-present-trusted' });
        return failClosedIfUnwritable(tier, trustWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'operator-present-trusted' });
      }
      // BUG-012 (per-connection follow-up): session grant for eligible
      // goal-less tools, scoped to the calling connection. No connectionId
      // (autonomous/cortex calls pass none) -> never matches any grant, which
      // is the desired containment — only the WS connection that actually
      // accepted the confirm gets the session grant.
      //
      // This read sits in the tier === 2 || 3 block now, but the WRITE side
      // (confirmApi.accept() below) still requires TIER_TABLE[grantedTool] ===
      // 3 before it will ever record a grant. That is deliberate, not
      // leftover from before the tier-2 widening: session grants are staying
      // T3-only until an operator decides otherwise, the same way T2's new
      // reach into operator-present-trust was a decision, not a side effect.
      // Every current SESSION_GRANTABLE entry is T3, so this read is
      // unreachable-but-harmless for T2 today. If a T2 tool is ever added to
      // SESSION_GRANTABLE, this read will start checking a grant accept()
      // will never write — widen accept()'s tier check in the same change,
      // or the new entry silently never grants.
      if (SESSION_GRANTABLE[toolName] && goalCtx && goalCtx.connectionId) {
        var sessionExpiry = sessionGrants.get(goalCtx.connectionId + ':' + toolName);
        if (sessionExpiry && Date.now() < sessionExpiry) {
          var sessionWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'allow', { granted: true, reason: 'session-granted' });
          return failClosedIfUnwritable(tier, sessionWrite, { allow: true, requireConfirm: false, tier: tier, reason: 'session-granted' });
        }
      }
      var confirmReason = 'tier-' + tier + '-requires-confirm';
      var confirmWrite = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: confirmReason });
      return failClosedIfUnwritable(tier, confirmWrite, { allow: false, requireConfirm: true, tier: tier, reason: confirmReason });
    }

    // 5. T4 -> always confirm, never cached
    var confirm4Write = writeAudit(action, goalCtx && goalCtx.goalId, tier, 'confirm', { reason: 'tier-4-always-confirm' });
    return failClosedIfUnwritable(tier, confirm4Write, { allow: false, requireConfirm: true, tier: tier, reason: 'tier-4-always-confirm' });
  }

  // BUG-012: wrap accept() so a successful T3 confirm ALSO records a session
  // grant for eligible tools — the one place every confirm resolution flows
  // through, regardless of which surface (WS modal, gesture, cortex) accepted.
  var confirmApi = Object.assign({}, confirmRegistry, {
    accept: function(confirmId, connectionId) {
      var acceptedAction = confirmRegistry.accept(confirmId, connectionId);
      // BUG-119 root cause (2026-08-06). This read `acceptedAction.tool`
      // directly, but every production caller stores an ENVELOPE — cortex,
      // voice-agent, the Live adapter and the engagement executor all call
      // confirm.create(summary, {decision, goalId, tier}, connectionId), so
      // `.tool` was undefined and NO session grant was ever recorded on any
      // surface. The BUG-012 feature has been inert in production since it
      // shipped; only the tests, which pass a bare {tool, args}, ever exercised
      // it. That — not the missing browser tools — is why an approval never
      // held and the model kept re-prompting.
      //
      // Normalized here the same way server/index.js's handleConfirmReply
      // normalizes it before dispatch: unwrap .decision when present, accept a
      // bare {tool, args} unchanged. One shape rule, both call sites.
      var granted = acceptedAction && acceptedAction.decision ? acceptedAction.decision : acceptedAction;
      var grantedTool = granted && granted.tool;
      // TIER_TABLE[grantedTool] === 3 is deliberately NOT widened to 2 here
      // even though check()'s read side above now sits in a tier === 2 || 3
      // block. Session grants stay T3-only on purpose — that is an operator
      // safety decision, not a gap this fix is meant to close. If a T2 tool
      // is ever added to SESSION_GRANTABLE, this line must widen too, in the
      // same change, or check() will spend forever looking for a grant this
      // line will never write.
      if (grantedTool && connectionId &&
          SESSION_GRANTABLE[grantedTool] && TIER_TABLE[grantedTool] === 3) {
        // BUG-142: opportunistic eviction, piggybacked on the one path that grows
        // this Map — see sweepExpiredSessionGrants() at module scope above.
        sweepExpiredSessionGrants(sessionGrants);
        sessionGrants.set(connectionId + ':' + grantedTool, Date.now() + SESSION_GRANT_TTL_MS);
      }
      return acceptedAction;
    }
  });

  return {
    check: check,
    confirm: confirmApi
  };
}

module.exports = { createLeash, sweepExpiredSessionGrants };
