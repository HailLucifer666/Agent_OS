'use strict';

// R8 regression (Risk Register): "Bus event names drift from spec silently break
// future-phase wiring ... add a lint/test that greps emitted event-name string
// literals against a spec-derived allowlist." D-28/D-36/D-37 (brain-spend,
// perception.tick, lifecycle.started/stopped) were exactly this class of bug —
// caught only by manual spec-conformance audits, never by an automated check. This
// file is that check: it statically greps every emitted event-name string literal
// across src/ and server/ and asserts it is in the allowlist below. The allowlist is
// the authoritative, currently-shipped event-name surface (MYTHOS-ARCHITECTURE.md's
// documented names plus every phase's approved, ROADMAP-documented additions) — a
// typo'd or paraphrased new event name fails this test the moment it's committed,
// instead of surviving until some future phase silently fails to receive it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// -- Spec-derived allowlist -------------------------------------------------
// Grouped by bus taxonomy channel (type.split('.')[0] per src/core/bus/event.js).
// A handful of events are deliberately channel-less (no dot) — 'tick'/'reflect'/
// 'confirm-request'/'brain-spend' are documented verbatim in
// MYTHOS-ARCHITECTURE.md's own event catalog and predate/sit outside the
// perception|action|health|memory|lifecycle|audit|identity taxonomy.
const ALLOWED_EVENTS = new Set([
  // channel-less control events (spec §-documented verbatim)
  'tick',
  'reflect',
  'confirm-request',
  'brain-spend',

  // perception.*
  'perception.tick',       // D-36 fix: was 'sensor.timer'
  'perception.file',
  'perception.ws',
  'perception.job',
  'perception.metric',
  'perception.voice',
  'perception.coalesced',
  'perception.screen',     // Phase 2 Jarvis upgrade — ambient screen awareness sensor
  'perception.calendar',   // V8 (Phase 4): upcoming-event perception (calendar-upcoming-sensor)
  'perception.window',     // V8 (Phase 4): opt-in active-window perception (window-sensor)
  'perception.aether',     // Aether-BLE proximity-focus sensor (owner-change / RSSI drift)
  // Voice Nodes Stage 5 — the conversation handoff FSM phase (§6.3), relayed to
  // phone nodes so a half-played sentence can pause, seek and resume in step with
  // the ~200ms-per-phase sequence. Deliberately NOT a perception.*: it is not an
  // observation for the cortex to reason about, it is a control signal with a
  // deadline, and the perception gate drops anything under MYTHOS_IDLE_SALIENCE.
  'aether.conversation',
  // Voice Nodes Stage 4 — the aggregator's wake arbitration verdict (§6.1
  // wakeOutcome), relayed to phone nodes so exactly one of them answers. One-shot
  // and time-critical, so it bypasses the perception dedup gate entirely.
  'aether.wake-outcome',

  // action.*
  'action.completed',
  'action.denied',
  'action.blocked',
  'action.speak-requested',

  // health.*
  'health.anomaly',
  'health.diagnosed',
  'health.healed',

  // memory.*
  'memory.decay',
  'memory.checkpoint.saved',
  'memory.merged',      // V10 (Phase 4): consolidate-* dedup/contradiction merge pass

  // lifecycle.*
  'lifecycle.started',     // D-37 fix: was 'lifecycle.cortex-started'
  'lifecycle.stopped',     // D-37 fix: was 'lifecycle.cortex-stopped'
  'lifecycle.alive',
  'lifecycle.recovered',
  'lifecycle.boot.step',
  'lifecycle.shutdown.step-failed', // D-07 (Phase 1) — a registered shutdown step threw; shutdown continues regardless

  // audit.*
  'audit.decision',

  // goal.* (P4/P6 — goal lifecycle + budget enforcement)
  'goal.created',
  'goal.updated',
  'goal.removed',
  'goal.budget-debited',
  'goal.completed',     // V3 (Phase 4): autonomous completion + distillation trigger
  'goal.tier-granted',  // 2026-07-31 security fix: records WHICH tools a T3 grant covers

  // mission.* (P11 — mission orchestrator)
  'mission.update',

  // conversation.* + cortex.thought (conversational brain — proactive speech + idle reasoning)
  'cortex.recall',      // V1 (Phase 4): orient→recallHybrid per-tick cache hydration
  'cortex.proposed',    // V8 (Phase 4): mull() → propose_goal suggestion surfaced
  'conversation.announced',
  'conversation.intent',   // Phase 5a — conversation-gateway.js's non-engagement route() fallback
  'cortex.thought',

  // engagement.* (Phase 5a — engagement layer wired end-to-end: store, state
  // machine transitions, gateway action routing, immune hooks). The two
  // trailing-dot entries are literal string-concatenation prefixes
  // (`'engagement.action.' + action`, `'engagement.progress.' + ...`) — the
  // static scanner records the quoted prefix, not the full runtime name.
  'engagement.draft',
  'engagement.interviewing',
  'engagement.spec_ready',
  'engagement.plan_ready',
  'engagement.approval_requested',
  'engagement.approved',
  'engagement.stage_started',
  'engagement.stage_completed',
  'engagement.stage_failed',
  'engagement.repairing',
  'engagement.verification_passed',
  'engagement.verification_failed',
  'engagement.blocked',
  'engagement.failed',
  'engagement.completed',
  'engagement.artifact_created',
  'engagement.deleted',
  'engagement.executing',
  'engagement.saved',
  'engagement.removed',
  'engagement.store.init',
  'engagement.immune.hooks.registered',
  'engagement.action.',    // gateway.js route(), index.js handleEngagementAction
  'engagement.progress.',  // progress.js

  // ui.navigate — emitted by dispatchAction when a navigate effector call succeeds,
  // relayed to clients so the panel actually opens (FIX 2: dashboard wiring).
  'ui.navigate',

  // ui.close-panel removed (REMEDIATION P1-5): close_panel no longer relays
  // through the bus post-hoc — it awaits a client ack directly via
  // ctx.closePanelProvider (mirrors camera_look's cameraFrameProvider), so its
  // return value can be honest about what actually closed. Deliberately not
  // re-added — see the immune-guard test below for the pattern.

  // ui.open-web — emitted when open_web/spawn_widget effectors succeed (dispatch-action.js,
  // from-widgets.js), relayed to clients as the 'open-web' broadcast. Client-side
  // routing in app.js subscribes to 'open-web'. Pre-existing shipped event, now
  // registered (was the long-standing known failure of this test).
  'ui.open-web',

  // ui.widget-command — emitted by manage_widget (from-widgets.js), relayed as the
  // 'widget-command' broadcast; widget-host.js hides/shows boot HUD widgets.
  'ui.widget-command',

  // conversation.intent — assistant/gateway emits this for cortex to handle
  // non-engagement intents after the conversation classifier routes the message.
  'conversation.intent',

  // reminder.* (P21 — calendar/reminder effector)
  'reminder.due',

  // calendar.* — F2 (2026-08-12): lets reminder-sensor's due-time wake timer
  // reschedule the instant a reminder is created, instead of waiting for its
  // safety-poll cadence to notice one added while it was idle.
  'calendar.reminder-added',

  // gmail.* (Item 7 — Gmail unread triage sensor, mirrors reminder-sensor)
  'gmail.unread-batch',

  // checkpoint.* / forge.* (P22 — Forge build pipeline + approval gates)
  'checkpoint.created',
  'checkpoint.resolved',
  'forge.update',

  // plan.* (Phase 3 Jarvis upgrade — daily planning + accountability)
  'plan.morning-brief',
  'plan.checkin',
  'plan.evening-review',

  // engagement.* (Phase 1 — Engagement Layer: interview→spec→plan→EXECUTE→verify)
  // The 16 progress events the UI subscribes to (ui/public/js/views/
  // engagements.js) + the lifecycle/persistence/bus-taxonomy events emitted by
  // the engagement subsystem. engagement.action.* / engagement.progress.* are
  // channel-prefix passthroughs (event name is built dynamically).
  'engagement.draft',
  'engagement.interviewing',
  'engagement.spec_ready',
  'engagement.plan_ready',
  'engagement.approval_requested',
  'engagement.approved',
  'engagement.stage_started',
  'engagement.stage_completed',
  'engagement.stage_failed',
  'engagement.repairing',
  'engagement.blocked',
  'engagement.failed',
  'engagement.completed',
  'engagement.artifact_created',
  'engagement.verification_passed',
  'engagement.verification_failed',
  'engagement.deleted',
  // channel-prefix passthroughs (the literal captured ends with the dot — the
  // full event name is built by string concatenation at the call site):
  'engagement.action.',
  'engagement.progress.',
  // persistence / lifecycle signals from the engagement store + boot wiring:
  'engagement.store.init',
  'engagement.saved',
  'engagement.removed',
  'engagement.immune.hooks.registered',

  // voice.live.* — Phase 1 (V2 §6, merged-order step 4): live-session.js's
  // Gemini Live bridge lifecycle/barge-in/tool-cancellation signals.
  'voice.live.state',
  'voice.live.interrupted',
  'voice.live.toolcancel',
  // 2026-08-10: a quiet room closing its own Live socket at the idle-rotation
  // ceiling. Deliberately NOT health.anomaly — it used to be, and because the
  // immune system has no playbook for it, the explainer narrated a normal
  // cost-saving close to the operator as a fault with an invented cause.
  'voice.live.idle-closed',
]);

// -- Static scan -------------------------------------------------------------
// Every *.js file under src/ and server/ (production code only — not test/).
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
}

// Matches `bus.emit(` or any `*Emit(` wrapper (safeEmit, origEmit spy wrappers,
// etc.) whose first argument is a string literal — i.e. every statically
// discoverable emitted BUS event name. Deliberately does NOT match a bare
// `emit(...)` local helper (e.g. logger.js's own unrelated internal `emit(level,
// msg, fields)` log-line formatter, which is not a bus event at all) or dynamic
// `emit(type, ...)` passthroughs with no literal to check.
const EMIT_LITERAL_RE = /\b(?:bus\.emit|[a-zA-Z_]*Emit)\(\s*(['"`])([a-zA-Z0-9_.\-]+)\1/g;

function findEmittedLiterals(srcRoot) {
  const files = [];
  walk(srcRoot, files);
  const found = []; // { file, line, name }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let m;
      EMIT_LITERAL_RE.lastIndex = 0;
      while ((m = EMIT_LITERAL_RE.exec(lines[i])) !== null) {
        found.push({ file: path.relative(srcRoot, file), line: i + 1, name: m[2] });
      }
    }
  }
  return found;
}

describe('R8 regression: emitted event-name literals conform to the spec-derived allowlist', () => {
  it('every bus.emit()-style literal under src/ is in ALLOWED_EVENTS', () => {
    const root = path.join(__dirname, '..', 'src');
    const emitted = findEmittedLiterals(root);
    assert.ok(emitted.length > 20, 'sanity: the scan should find dozens of real emit call sites, not near-zero (regex or path broke)');

    const violations = emitted.filter((e) => !ALLOWED_EVENTS.has(e.name));
    assert.deepEqual(
      violations,
      [],
      'unregistered event name(s) found — either a real typo/drift (fix the emit site) ' +
      'or a legitimate new event that must be added to ALLOWED_EVENTS deliberately: ' +
      JSON.stringify(violations, null, 2)
    );
  });

  it('every bus.emit()-style literal under server/ is in ALLOWED_EVENTS', () => {
    const root = path.join(__dirname, '..', 'server');
    const emitted = findEmittedLiterals(root);
    const violations = emitted.filter((e) => !ALLOWED_EVENTS.has(e.name));
    assert.deepEqual(violations, [], 'unregistered event name(s) found under server/: ' + JSON.stringify(violations, null, 2));
  });

  it('the historical drift regressions (D-28/D-36/D-37) stay fixed — the old paraphrased names are not in the allowlist', () => {
    const banned = ['brain.spend', 'sensor.timer', 'lifecycle.cortex-started', 'lifecycle.cortex-stopped'];
    for (const name of banned) {
      assert.equal(ALLOWED_EVENTS.has(name), false, name + ' was a fixed spec-drift bug — it must never be re-added to the allowlist');
    }
  });
});
