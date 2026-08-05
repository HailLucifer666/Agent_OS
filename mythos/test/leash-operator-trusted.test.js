'use strict';

// leash-operator-trusted.test.js — operator-present auto-allow for local,
// reversible T3 tools.
//
// WHY THIS EXISTS (2026-08-06, operator decision). The operator was being asked
// to approve clicking a video, playing a song and closing a window. Approval
// fatigue is a safety problem, not a cosmetic one: someone who clicks Approve
// fifty times a day stops reading the prompt, and the gate becomes a rubber
// stamp. BUG-119 fixed the *mechanism* (session grants were inert because
// accept() read `.tool` off an envelope), but two tools — see_and_click and
// cua_click, the latter being what "play a song in the Spotify app" actually
// uses — were never session-grantable at all, so they confirmed every time
// regardless.
//
// The fix is NOT a tier change and NOT a ceiling raise. leash.check() receives a
// connectionId from exactly two call sites, both human-driven:
//
//   voice-agent.js:495          { connectionId }                  human present
//   live-tool-adapter.js:271    { connectionId, goalId: null }    human present
//   cortex/index.js:278         { goalId }                        NO — autonomous
//   engagements/executor.js:272/:422  { goalId: record.goalId }   NO — LLM-authored
//   sensors/reminder-sensor.js:37     { goalId }                  NO — unattended
//
// So a curated list of local, reversible T3 tools auto-allows ONLY when a real
// connection is driving. cortex, engagements and the reminder sensor gain
// nothing — which is the whole safety claim, and is why the containment tests
// below assert one test per real call shape rather than one generic case.
//
// Re-tiering these to T2 would have handed the same capability to the
// autonomous loop — the exact mistake that let a build launch itself unasked
// mid-conversation on 2026-07-29 (tiers.js:168-176), and BUGS.md:368 records
// raising AUTONOMOUS_MAX_TIER globally as evaluated and rejected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { TIER_TABLE } = require('../src/core/leash/tiers');

function realBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 200 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
    CHECKPOINT_TTL_MS: 1800000,
    TRUSTED_TOOLS: '',
    TRUSTED_TOOLS_DISABLED: false
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter(result) {
  const writes = [];
  return {
    write: function(e) { writes.push(e); return result || { ok: true }; },
    _writes: function() { return writes; }
  };
}

// One real Leash. No mocks of the thing under test — same real-instance
// discipline as test/leash-grant-scope.test.js, whose helpers this mirrors.
function harness(opts) {
  const o = opts || {};
  const { createLeash } = require('../src/core/leash');
  const bus = realBus();
  const audit = recordingAuditWriter(o.auditResult);
  const leash = createLeash({
    bus: bus,
    config: fakeConfig(o.config),
    identity: o.identity || noopIdentity(),
    auditWriter: audit,
    goals: { get: function() { return null; } },
    effectors: noopEffectors(),
    scanner: o.scanner
  });
  return { bus: bus, leash: leash, audit: audit };
}

const CONN = 'conn-operator';

// The built-in trusted list, mirrored here deliberately rather than imported:
// if someone widens the list in leash/index.js this fixture does not silently
// widen with it, and the "sample every group the operator named" tests below
// keep meaning what they say.
const TRUSTED = [
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option',
  'browser_press_key', 'browser_upload_file',
  'ui_click', 'ui_type', 'click_at', 'see_and_click', 'cua_click',
  'close_window'
];

describe('leash operator-present trust — the permission', function() {
  it('every trusted tool is T3, so none of them is a re-tier in disguise', function() {
    for (const tool of TRUSTED) {
      assert.equal(TIER_TABLE[tool], 3,
        tool + ' must be T3 — the trust path is deliberately T3-only, so a T2/T4 entry would be dead or unsafe');
    }
  });

  it('a trusted T3 tool with a connectionId is allowed, with its own audit reason', function() {
    const h = harness();
    const res = h.leash.check({ tool: 'cua_click', args: { x: 10, y: 20 } }, { connectionId: CONN });

    assert.equal(res.allow, true, 'cua_click is what "play a song in the Spotify app" uses — it must not prompt');
    assert.equal(res.requireConfirm, false);
    assert.equal(res.reason, 'operator-present-trusted');
    assert.equal(res.tier, 3, 'the tier itself is unchanged — this is a gate decision, not a re-tier');
  });

  it('the allow needs NO prior confirm — this is the whole point, distinct from a session grant', function() {
    // A session grant requires an accepted confirm first. Trust does not: the
    // very first cua_click of a fresh session must go through silently.
    const h = harness();
    const first = h.leash.check({ tool: 'see_and_click', args: {} }, { connectionId: CONN });
    assert.equal(first.allow, true, 'the FIRST use must already be allowed');
    assert.notEqual(first.reason, 'session-granted', 'this must not be reported as a session grant');
    assert.equal(first.reason, 'operator-present-trusted');
  });

  it('every tool on the trusted list is allowed with a connectionId', function() {
    for (const tool of TRUSTED) {
      const h = harness();
      const res = h.leash.check({ tool: tool, args: {} }, { connectionId: CONN });
      assert.equal(res.allow, true, tool + ' must be allowed when the operator is driving');
      assert.equal(res.reason, 'operator-present-trusted', tool + ' must report the trust reason');
    }
  });

  it('AD-2 holds — exactly one audit line, granted:true, reason operator-present-trusted', function() {
    const h = harness();
    h.leash.check({ tool: 'browser_click', args: { ref: 'e12' } }, { connectionId: CONN });

    const writes = h.audit._writes();
    assert.equal(writes.length, 1, 'the leash must still write exactly one audit line per check (AD-2)');
    assert.equal(writes[0].decision, 'allow');
    assert.equal(writes[0].granted, true, 'a trusted allow is a granted allow — it must be visible as one');
    assert.equal(writes[0].reason, 'operator-present-trusted',
      'the reason must be its own string, not blended into within-autonomous-max or session-granted');
    assert.equal(writes[0].tool, 'browser_click');
  });

  it('the trust reason is distinct from the two pre-existing allow reasons', function() {
    const h = harness();
    const trusted = h.leash.check({ tool: 'ui_click', args: {} }, { connectionId: CONN });
    const belowMax = h.leash.check({ tool: 'launch_app', args: {} }, { connectionId: CONN });

    assert.equal(belowMax.reason, 'within-autonomous-max', 'fixture: launch_app is T2 and auto-allows the old way');
    assert.notEqual(trusted.reason, belowMax.reason,
      'the new path must be greppable in the Audit view, not hidden behind an existing reason');
  });
});

describe('leash operator-present trust — the containment', function() {
  // One test per REAL call shape. This is the safety claim, so it is asserted
  // against the shapes production actually passes, not a generic stand-in.

  it('cortex/index.js\'s { goalId } shape still requires confirm', function() {
    const h = harness();
    const res = h.leash.check({ tool: 'cua_click', args: {} }, { goalId: 'goal-123' });
    assert.equal(res.allow, false, 'the autonomous loop must gain nothing from this change');
    assert.equal(res.requireConfirm, true);
    assert.equal(res.reason, 'tier-3-requires-confirm');
  });

  it('an engagement stage\'s { goalId: record.goalId } shape still requires confirm', function() {
    // executor.js runs LLM-authored {tool,args} stages. Untrusted text reaching
    // the spec must never reach a trusted tool unattended.
    const h = harness();
    const res = h.leash.check({ tool: 'browser_upload_file', args: { path: 'x' } }, { goalId: 'eng-goal' });
    assert.equal(res.requireConfirm, true, 'an LLM-authored stage is not an operator');
    assert.equal(res.reason, 'tier-3-requires-confirm');
  });

  it('the reminder sensor\'s shape still requires confirm', function() {
    // reminder-sensor.js:37 passes { goalId: rem.goalId || null } and fires
    // unattended, so BOTH of its shapes must stay gated.
    const h = harness();
    for (const ctx of [{ goalId: 'rem-goal' }, { goalId: null }]) {
      const res = h.leash.check({ tool: 'close_window', args: {} }, ctx);
      assert.equal(res.requireConfirm, true, 'an unattended reminder must not close windows silently');
    }
  });

  it('connectionId "system" is not an operator', function() {
    // voice-agent.js:499 passes `connectionId || 'system'` into confirm.create,
    // so the sentinel is real in this codebase. Cheap insurance against it ever
    // reaching check() and reading as a human.
    const h = harness();
    const res = h.leash.check({ tool: 'cua_click', args: {} }, { connectionId: 'system' });
    assert.equal(res.allow, false, 'the "system" sentinel must never satisfy operator-presence');
    assert.equal(res.requireConfirm, true);
  });

  it('a null, undefined, empty or absent connectionId is not an operator', function() {
    const h = harness();
    const contexts = [{ connectionId: null }, { connectionId: undefined }, { connectionId: '' }, {}, null, undefined];
    for (const ctx of contexts) {
      const res = h.leash.check({ tool: 'ui_type', args: { text: 'hi' } }, ctx);
      assert.equal(res.allow, false, 'ctx ' + JSON.stringify(ctx) + ' must not be treated as operator-present');
      assert.equal(res.requireConfirm, true);
    }
  });
});

describe('leash operator-present trust — the hard line', function() {
  it('sending, running, installing and deleting still confirm with a valid connectionId', function() {
    const mustStillConfirm = [
      'gmail_send', 'compose_email', 'whatsapp_send',
      'phone_call', 'phone_sms_send', 'phone_whatsapp_send', 'phone_file_push',
      'run_command', 'install_from_github', 'mcp_call_tool', 'hermes_task', 'security_scan',
      'build_project', 'revise_project', 'pipeline_execute', 'kanban_assemble',
      'kanban_build_card', 'start_project', 'run_mission',
      'delete_file', 'delete_goal', 'delete_artifact', 'reminder_approve_action'
    ];
    const h = harness();
    for (const tool of mustStillConfirm) {
      assert.equal(TIER_TABLE[tool], 3, tool + ' must be T3 for this assertion to mean anything');
      const res = h.leash.check({ tool: tool, args: {} }, { connectionId: CONN });
      assert.equal(res.allow, false, tool + ' must NEVER be trusted, operator present or not');
      assert.equal(res.requireConfirm, true);
      assert.equal(res.reason, 'tier-3-requires-confirm');
    }
  });

  it('browser_evaluate and kill_session are T4 and still confirm with a valid connectionId', function() {
    const h = harness();
    for (const tool of ['browser_evaluate', 'kill_session']) {
      assert.equal(TIER_TABLE[tool], 4, tool + ' must stay T4');
      const res = h.leash.check({ tool: tool, args: {} }, { connectionId: CONN });
      assert.equal(res.requireConfirm, true, tool + ' must always confirm');
      assert.equal(res.reason, 'tier-4-always-confirm', 'T4 must not even reach the T3 trust branch');
    }
  });

  it('an unknown/hallucinated tool name is not trusted (T3 fail-safe is not a trust grant)', function() {
    const h = harness();
    const res = h.leash.check({ tool: 'totally_made_up_tool', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, false, 'the unknown-tool T3 fail-safe must not inherit trust');
    assert.equal(res.requireConfirm, true);
  });
});

describe('leash operator-present trust — the earlier gates still win', function() {
  it('a boundaries.md DENY on a trusted tool denies, it does not allow', function() {
    const denyingIdentity = {
      checkBoundary: function(tool) { return tool === 'cua_click' ? 'boundary:no-clicking' : null; },
      getMaxAutonomousTier: function() { return 4; }
    };
    const h = harness({ identity: denyingIdentity });
    const res = h.leash.check({ tool: 'cua_click', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, false, 'boundaries are absolute — trust must not override them');
    assert.equal(res.requireConfirm, false, 'a boundary deny is a deny, not a confirm');
    assert.equal(res.reason, 'boundary:no-clicking');
  });

  it('MYTHOS_DRY_RUN turns a trusted tool into a logged no-op, not an allow', function() {
    const h = harness({ config: { MYTHOS_DRY_RUN: true } });
    const res = h.leash.check({ tool: 'browser_click', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, false);
    assert.equal(res.reason, 'dry-run');
  });

  it('the credential scanner still denies a trusted tool carrying a secret', function() {
    const scanner = {
      scan: function() { return { found: true, matches: [{ name: 'aws-key', sample: 'AKIA…' }] }; }
    };
    const h = harness({ scanner: scanner });
    const res = h.leash.check({ tool: 'browser_type', args: { text: 'AKIAIOSFODNN7EXAMPLE' } }, { connectionId: CONN });
    assert.equal(res.allow, false, 'a credential in the args must deny regardless of trust');
    assert.match(res.reason, /^credential-detected:/);
  });

  it('an unwritable audit at T3 denies a trusted tool (failClosedIfUnwritable)', function() {
    const h = harness({ auditResult: { ok: false } });
    const res = h.leash.check({ tool: 'ui_click', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, false, 'an action MYTHOS cannot record is an action it must not take');
    assert.equal(res.reason, 'audit-unwritable-fail-closed');
  });
});

describe('leash operator-present trust — the operator knob', function() {
  it('TRUSTED_TOOLS adds a T3 tool that is not on the built-in list', function() {
    assert.equal(TIER_TABLE['right_click_at'], 3, 'fixture: right_click_at must be T3');
    assert.equal(TRUSTED.indexOf('right_click_at'), -1, 'fixture: right_click_at must not already be trusted');

    const before = harness().leash.check({ tool: 'right_click_at', args: {} }, { connectionId: CONN });
    assert.equal(before.requireConfirm, true, 'fixture: it must confirm without the env override');

    const h = harness({ config: { TRUSTED_TOOLS: 'right_click_at' } });
    const res = h.leash.check({ tool: 'right_click_at', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, true, 'the operator must be able to add their own T3 tool');
    assert.equal(res.reason, 'operator-present-trusted');
  });

  it('TRUSTED_TOOLS parses whitespace, extra commas and casing-as-written', function() {
    const h = harness({ config: { TRUSTED_TOOLS: ' right_click_at , , drag ' } });
    for (const tool of ['right_click_at', 'drag']) {
      assert.equal(TIER_TABLE[tool], 3, 'fixture: ' + tool + ' must be T3');
      assert.equal(h.leash.check({ tool: tool, args: {} }, { connectionId: CONN }).allow, true,
        tool + ' must be added despite the sloppy list formatting');
    }
  });

  it('TRUSTED_TOOLS cannot add a NEVER_TRUSTABLE tool, and says so by name', function() {
    const h = harness({ config: { TRUSTED_TOOLS: 'gmail_send' } });

    const res = h.leash.check({ tool: 'gmail_send', args: {} }, { connectionId: CONN });
    assert.equal(res.allow, false, 'the never-trustable set must be un-overridable from env');
    assert.equal(res.requireConfirm, true);

    const refusals = h.bus.history(function(e) {
      return e.type === 'health.anomaly' && e.payload && e.payload.kind === 'leash-trusted-tool-ignored';
    });
    assert.equal(refusals.length, 1, 'silently ignoring the entry is how a config lies to its operator');
    assert.equal(refusals[0].payload.evidence.tool, 'gmail_send', 'the refusal must name the tool');
    assert.match(refusals[0].payload.evidence.reason, /never-trustable/);
  });

  it('TRUSTED_TOOLS cannot add a T4 tool, and says so by name', function() {
    const h = harness({ config: { TRUSTED_TOOLS: 'browser_evaluate' } });
    const res = h.leash.check({ tool: 'browser_evaluate', args: {} }, { connectionId: CONN });
    assert.equal(res.requireConfirm, true, 'T4 must stay structurally ineligible');

    const refusals = h.bus.history(function(e) {
      return e.type === 'health.anomaly' && e.payload && e.payload.kind === 'leash-trusted-tool-ignored';
    });
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].payload.evidence.tool, 'browser_evaluate');
  });

  it('TRUSTED_TOOLS with an unknown tool name is ignored and reported by name', function() {
    const h = harness({ config: { TRUSTED_TOOLS: 'not_a_real_tool' } });
    const res = h.leash.check({ tool: 'not_a_real_tool', args: {} }, { connectionId: CONN });
    assert.equal(res.requireConfirm, true, 'an unknown name resolves to the T3 fail-safe, not to trust');

    const refusals = h.bus.history(function(e) {
      return e.type === 'health.anomaly' && e.payload && e.payload.kind === 'leash-trusted-tool-ignored';
    });
    assert.equal(refusals.length, 1, 'a typo in the env must be reported, not swallowed');
    assert.equal(refusals[0].payload.evidence.tool, 'not_a_real_tool');
  });

  it('a valid TRUSTED_TOOLS entry reports no refusal', function() {
    const h = harness({ config: { TRUSTED_TOOLS: 'right_click_at' } });
    const refusals = h.bus.history(function(e) {
      return e.type === 'health.anomaly' && e.payload && e.payload.kind === 'leash-trusted-tool-ignored';
    });
    assert.equal(refusals.length, 0, 'a good entry must not produce noise');
  });

  it('TRUSTED_TOOLS_DISABLED=true makes every trusted tool confirm again', function() {
    const h = harness({ config: { TRUSTED_TOOLS_DISABLED: true } });
    for (const tool of TRUSTED) {
      const res = h.leash.check({ tool: tool, args: {} }, { connectionId: CONN });
      assert.equal(res.allow, false, tool + ' must confirm again with the kill switch on');
      assert.equal(res.reason, 'tier-3-requires-confirm');
    }
  });

  it('TRUSTED_TOOLS_DISABLED is read per call, not cached at construction', function() {
    // Same discipline as AUTONOMOUS_MAX_TIER — the leash must never hold a stale
    // copy of the switch. This is NOT a claim that an .env edit applies without a
    // restart: the real config object is frozen at boot (config/index.js), so it
    // does need one. What this pins is that the value is re-read, so a future
    // config reload works and a test can flip it.
    const { createLeash } = require('../src/core/leash');
    const config = fakeConfig();
    const leash = createLeash({
      bus: realBus(), config: config, identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });

    assert.equal(leash.check({ tool: 'ui_click', args: {} }, { connectionId: CONN }).allow, true);
    config.TRUSTED_TOOLS_DISABLED = true;
    assert.equal(leash.check({ tool: 'ui_click', args: {} }, { connectionId: CONN }).requireConfirm, true,
      'flipping the switch must take effect on the next call');
  });

  it('an absent TRUSTED_TOOLS config does not throw (schema default is empty string)', function() {
    const { createLeash } = require('../src/core/leash');
    const bare = {
      AUTONOMOUS_MAX_TIER: 2, MYTHOS_DRY_RUN: false,
      LEASH_CONFIRM_TTL_MS: 30000, CHECKPOINT_TTL_MS: 1800000
    };
    const leash = createLeash({
      bus: realBus(), config: bare, identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
    assert.equal(leash.check({ tool: 'ui_click', args: {} }, { connectionId: CONN }).allow, true,
      'the built-in list must work with no env keys set at all');
  });
});

describe('leash operator-present trust — the session-grant path is untouched', function() {
  it('a NON-trusted session-grantable tool still needs an accepted confirm first', function() {
    // focus_window is T1 now, so pick the real remaining case: SESSION_GRANTABLE
    // still serves any T3 tool that trust does not cover. right_click_at is not
    // on either list, so it must behave exactly as it did before this change.
    const h = harness();
    const res = h.leash.check({ tool: 'right_click_at', args: {} }, { connectionId: CONN });
    assert.equal(res.requireConfirm, true, 'trust must not have widened the session-grant list');
  });

  it('trust supersedes the session grant for tools on both lists (one audit reason, not two)', function() {
    // browser_click is on SESSION_GRANTABLE (BUG-119) and on the trusted list.
    // Trust is checked first, so the reason must be the trust reason — a stale
    // session-granted reason here would mean the ordering silently changed.
    const h = harness();
    const res = h.leash.check({ tool: 'browser_click', args: {} }, { connectionId: CONN });
    assert.equal(res.reason, 'operator-present-trusted',
      'trust is checked before the session grant and supersedes it');
  });
});
