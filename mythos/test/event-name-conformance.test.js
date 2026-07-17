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

  // mission.* (P11 — mission orchestrator)
  'mission.update',

  // conversation.* + cortex.thought (conversational brain — proactive speech + idle reasoning)
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

  // ui.close-panel — emitted when close_panel effector succeeds, relayed to clients
  'ui.close-panel',

  // ui.open-web — emitted when open_web/spawn_widget effectors succeed (dispatch-action.js,
  // from-widgets.js), relayed to clients as the 'open-web' broadcast. Was shipping
  // unregistered — the long-standing known failure of this test, registered deliberately.
  'ui.open-web',

  // ui.widget-command — emitted by manage_widget (from-widgets.js), relayed as the
  // 'widget-command' broadcast; widget-host.js hides/shows boot HUD widgets.
  'ui.widget-command',

  // reminder.* (P21 — calendar/reminder effector)
  'reminder.due',

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
