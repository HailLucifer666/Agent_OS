'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

const { TOOLS: COMPUTER_TOOLS } = require('../src/core/effectors/from-computer');
const { TOOLS: PC_TOOLS } = require('../src/core/effectors/from-pc');
const { TOOLS: BROWSER_TOOLS } = require('../src/core/effectors/from-browser');
const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromCua } = require('../src/core/effectors/from-cua');
const { registerFromBrowser } = require('../src/core/effectors/from-browser');
const { registerFromDashboard, buildTools: buildDashboardTools } = require('../src/core/effectors/from-dashboard');
const { registerFromProject, buildTools: buildProjectTools } = require('../src/core/effectors/from-project');
const { registerFromGmail } = require('../src/core/effectors/from-gmail');
const { registerFromDocs } = require('../src/core/effectors/from-docs');
const { registerFromRunner } = require('../src/core/effectors/from-runner');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');

describe('effectors/hub: createEffectorHub', () => {
  it('register() requires {id, invoke()} and throws otherwise', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    assert.throws(() => hub.register({}));
    assert.throws(() => hub.register({ id: 'x' })); // missing invoke()
  });

  it('invoke("unknown", ...) fails with an "unknown-effector" reason naming the tool', async () => {
    // WAVE 6 widened this deliberately. The bare string was a dead end: MYTHOS
    // called status({}) in the 2026-07-31 session, got exactly 'unknown-effector'
    // back, and had nothing pointing at read_status. The prefix is still exact —
    // cortex/index.js matches that literal — but the message now names the tool
    // and, when there is a near match, suggests it (see
    // test/open-folder-and-suggestions.test.js). Asserting the whole object by
    // deepEqual pinned the dead end in place.
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a', invoke: async () => ({ ok: true, result: 1 }) });
    hub.register({ id: 'b', invoke: async () => ({ ok: true, result: 2 }) });
    hub.register({ id: 'c', invoke: async () => ({ ok: true, result: 3 }) });
    const result = await hub.invoke('unknown', {}, {});
    assert.equal(result.ok, false);
    assert.match(String(result.result), /^unknown-effector/);
    assert.match(String(result.result), /unknown/);
    assert.deepEqual(result.suggestions, [], 'a, b, c are nothing like "unknown" — no bad guesses');
  });

  it('three failures trip the breaker -> circuit-open, and hub.breakers.allow(name) works directly', async () => {
    const bus = fakeBus();
    const config = { BREAKER_FAIL_THRESHOLD: 3, BREAKER_WINDOW_MS: 30000, BREAKER_RESET_MS: 15000 };
    const hub = createEffectorHub({ bus, config });
    hub.register({ id: 'flaky', invoke: async () => ({ ok: false, result: 'nope' }) });

    await hub.invoke('flaky', {}, {});
    await hub.invoke('flaky', {}, {});
    await hub.invoke('flaky', {}, {});

    // Regression guard for Ambiguity #4: breakers is a wrapper, not a raw Map —
    // .allow(name) must be callable directly, matching cortex/index.js's real call site.
    assert.equal(hub.breakers.allow('flaky'), false);

    const result = await hub.invoke('flaky', {}, {});
    assert.deepEqual(result, { ok: false, result: 'circuit-open' });
  });

  it('get() checks tool effectors first, then named services', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a-tool', invoke: async () => ({ ok: true }) });
    hub.registerNamed('goals-effector', { sync: () => {} });
    assert.equal(hub.get('a-tool').id, 'a-tool');
    assert.equal(typeof hub.get('goals-effector').sync, 'function');
    assert.equal(hub.get('nope'), undefined);
  });

  it('registerNamed() services are never counted by count() (the 45 gate)', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a-tool', invoke: async () => ({ ok: true }) });
    hub.registerNamed('goals-effector', { sync: () => {} });
    hub.registerNamed('kanban-effector', { listBoard: () => {} });
    assert.equal(hub.count(), 1);
  });
});

// ---------------------------------------------------------------------------
// Table-driven gate tests (Test Plan items 3 & 4) — real hub, real TOOLS arrays.
// ---------------------------------------------------------------------------

describe('gate: danger -> tier >= 3', () => {
  const ctx = buildRealCtxForGateTests();

  it('every tool marked danger:true maps to tierOf(name) >= 3', () => {
    const allTools = [].concat(COMPUTER_TOOLS, PC_TOOLS, BROWSER_TOOLS, buildDashboardTools(ctx).TOOLS, buildProjectTools(ctx));
    const dangerTools = allTools.filter((t) => t.danger === true);
    assert.ok(dangerTools.length > 0, 'sanity: at least one danger:true tool must exist');
    for (const t of dangerTools) {
      assert.ok(tierOf(t.name) >= 3, `${t.name} is danger:true but tierOf() = ${tierOf(t.name)}`);
    }
  });

  // pipeline_advance is the sole dangerWhen-only tool (danger:false, TIER_TABLE
  // pins it at T1 "approve only — dangerWhen handles reject"). Its own tier-table
  // comment documents this as a deliberate design: dangerWhen elevates the gate at
  // leash.check() time regardless of the tool's base tier, so a dangerWhen-only tool
  // is NOT required to sit at tier>=3 the way an unconditionally danger:true tool is.
  // This is a real conflict between the Test Plan's literal wording ("marked danger:true
  // OR with a dangerWhen ... maps to tierOf>=3") and tiers.js's own already-shipped,
  // out-of-scope (P5-owned) comment — resolved here the same way Ambiguity #2 was:
  // documented, not silently papered over, and tiers.js is not edited.
  it('the sole dangerWhen-only tool (pipeline_advance) exists and carries a real dangerWhen fn', () => {
    const dashboardTools = buildDashboardTools(ctx).TOOLS;
    const dangerWhenOnly = dashboardTools.filter((t) => t.danger !== true && typeof t.dangerWhen === 'function');
    assert.equal(dangerWhenOnly.length, 1);
    assert.equal(dangerWhenOnly[0].name, 'pipeline_advance');
    assert.equal(TIER_TABLE.pipeline_advance, 1);
  });
});

describe('gate: 100 registered count', () => {
  it('booting a hub with all register* functions (incl. gmail + docs + runner) against the real TOOLS arrays yields correct count', () => {
    const ctx = buildRealCtxForGateTests();
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });

    registerFromComputer(hub);
    registerFromPc(hub);
    registerFromCua(hub);
    registerFromBrowser(hub);
    registerFromDashboard(hub, ctx);
    registerFromProject(hub, ctx);
    registerFromGmail(hub, { logger: console });
    registerFromDocs(hub, { vault: ctx.vault });
    registerFromRunner(hub, { vault: ctx.vault, config: {} });

    // 54 base + open_web (from-dashboard) + send_key (from-pc) + capture_screenshot
    // (from-pc, BUG-009 — 2026-07-16) = 57, + click_at (from-pc, Item 12 —
    // 2026-07-16) = 58, + browser_launch_debug (from-browser, Phase 6 on-demand
    // launcher) = 59, + ambient_awareness (from-pc, Phase 2 Jarvis upgrade —
    // ambient screen awareness toggle) = 60, + daily_plan (from-dashboard,
    // Phase 3 Jarvis upgrade — daily planning + accountability tool) = 61,
    // + 3 doc tools (generate_spreadsheet/deck/pdf, Phase 2 — 2026-07-17) = 64,
    // + 5 desktop tools (move_window/snap_window/scroll_at/right_click_at/drag,
    // Phase 3 — 2026-07-17) = 69, + 2 browser tools (browser_wait_for/
    // browser_fill_form, Phase 4 — 2026-07-17) = 71,
    // + 1 run_command (from-runner, Phase 3 V7 — 2026-07-19) = 72,
    // + 1 propose_goal (from-dashboard, Phase 4 V5 — 2026-07-20) = 73,
    // + 3 write_file/create_folder/delete_file (from-computer, folder read-write
    // feature — 2026-07-23 bug sweep) = 76, + show_desktop (from-pc, 2026-07-24
    // typing/wrong-app fix sweep — FIX 5) = 77, + media_status (from-pc —
    // registers the previously hub-less pseudo-tool so invoke() no longer
    // returns unknown-effector) = 78, - 2 monitor_snapshot/kill_session
    // (dead abtop-backed tools removed — Wave 1 mechanical dead-code pass,
    // abtop.start() had zero callers) = 76, + get_volume/set_volume (from-pc,
    // REMEDIATION P1-8 2026-07-29 — spotify_volume's level:0-100 param routes
    // through these two new real-master-volume tools) = 78,
    // + move_file/copy_file/rename_file/search_files (from-computer, Task 4,
    // step 5 desktop gaps) = 82, + clipboard_read/clipboard_write
    // (from-computer, Task 3, step 5 desktop gaps) = 84, + screen_read_text
    // (from-pc, §7.1, step 5 desktop gaps) = 85, + set_wallpaper (from-pc,
    // §7.7, step 5 desktop gaps) = 86,
    // + 4 cua_* tools (cua_list_windows/cua_bring_to_front/cua_get_window_state/
    // cua_click from from-cua — the Chromium-capable click path that complements
    // pc-child's ui_click, un-breaking Spotify-native search-then-play and general
    // click-inside-rendered-content — Slice 2, 2026-07-31) = 90,
    // + see_and_click (from-pc, 2026-08-02) = 91 — OCRs the screen and clicks a
    // visible label by its bounding box, for the case that defeated ui_click on
    // WhatsApp Desktop: a UIA tree that enumerates to zero children, so no valid
    // elementPath exists to pass and the model was inventing them.
    // spawn_widget (Item 11) lives in from-widgets.js, wired via a separate
    // registerFromWidgets() this gate test does not call, so it is NOT
    // counted here. use_skill is registered separately via registerFromSkills
    // (not called here). whatsapp_* likewise: registerFromWhatsapp is not called
    // here, so whatsapp_contact_save (2026-08-02) does not move this number.
    // + browser_switch (from-browser, BUG-107 2026-08-05 — the remedy for a
    // wrong-browser refusal: disconnect + relaunch the requested browser) = 92,
    // + browser_snapshot (from-browser, snapshot-and-refs 2026-08-06 — reads the
    // page as an accessibility tree with per-element refs so the model acts on an
    // element it actually saw instead of a guessed CSS selector) = 93,
    // + browser_upload_file/browser_select_option/browser_press_key/browser_hover
    // (from-browser, snapshot-and-refs Phase 5 2026-08-06 — the rest of what a
    // browser can do: resume upload for job applications, native dropdowns,
    // Enter/Tab/Escape for form flows, and hover to reveal menus) = 97,
    // + browser_dismiss_overlays/browser_check_captcha (from-browser,
    // snapshot-and-refs Phase 6 2026-08-06 — clearing cookie walls and skip-ad
    // buttons, and detecting a human-verification challenge so MYTHOS STOPS and
    // asks the operator rather than trying to work around it) = 99,
    // + set_app_volume (from-pc, BUG-127 2026-08-06 — per-application volume via
    // the Windows Volume Mixer sessions, so turning Spotify down no longer takes
    // MYTHOS's own voice down with the system master) = 100,
    // + get_app_volume/set_app_mute (from-pc, BUG-161 2026-08-07 — the read
    // oracle and the mute flag for that same per-app audio session, so a
    // relative step ("turn Spotify down a bit") reads the real level first
    // instead of firing global media keys and claiming success) = 102,
    // + camera_on (from-dashboard, 2026-08-10 — the confirm-gated opener for the
    // webcam camera_look reads from. With the camera off and no way to ask for it,
    // "can you see me?" had no honest path at all, and the model substituted a
    // desktop screenshot and described that instead) = 103,
    // + read_system_specs (from-dashboard, E5 2026-08-12 — CPU/RAM already
    // existed at GET /api/system and the dashboard widget rendered them, but
    // NO tool exposed any of it, so screen_look was the model's only option
    // and it screenshotted a screen that happened to be showing MYTHOS's own
    // dashboard) = 104.
    assert.equal(hub.count(), 104);
  });
});

describe('media_status: registered on the hub, invoke() no longer returns unknown-effector', () => {
  const pcChildPath = require.resolve('../adapters/pc-child');
  const realPcChild = require(pcChildPath);
  let originalSend, originalGetStatus;

  beforeEach(() => {
    originalSend = realPcChild.sendCommand;
    originalGetStatus = realPcChild.getStatus;
    realPcChild.getStatus = () => ({ state: 'ONLINE', hint: null });
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  afterEach(() => {
    realPcChild.sendCommand = originalSend;
    realPcChild.getStatus = originalGetStatus;
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  it('hub.invoke("media_status", {}, {}) delegates to pc-child and passes SMTC fields through unchanged', async () => {
    const smtcPayload = { title: 'Track Name', artist: 'Some Artist', album: 'Some Album', position: 42, duration: 210 };
    realPcChild.sendCommand = (cmdObj) => {
      assert.deepEqual(cmdObj, { cmd: 'media_status' });
      return Promise.resolve({ ok: true, result: smtcPayload });
    };

    const { registerFromPc: registerFromPcFresh } = require('../src/core/effectors/from-pc');
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    registerFromPcFresh(hub);

    const result = await hub.invoke('media_status', {}, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, smtcPayload);
  });
});

function buildRealCtxForGateTests() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const pipeline = createPipelineEffector({ fs });
  const kanban = createKanbanEffector({ fs });
  const fakeBrain = { think: async () => ({ content: '{}', offline: false }) };
  const buildRunner = createBuildRunner({ config: {}, brain: fakeBrain, bus: fakeBus(), vault: fs });
  const agentActions = createAgentActions({ fs, pipeline, kanban, buildRunner });
  const fakeGoalSystem = {
    create: (opts) => ({ id: 'goal-1', createdAt: Date.now(), status: opts.status || 'active', title: opts.title }),
    get: () => null,
    update: () => {},
    list: () => []
  };
  const goalsEffector = createGoalsMdBridge({ fs, goalSystem: fakeGoalSystem, bus: fakeBus() });
  return {
    goalsEffector, pipeline, kanban, agentActions, buildRunner,
    vault: fs,
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
    config: {}
  };
}
