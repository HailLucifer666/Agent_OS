'use strict';

// test/bug-446-goal-work-runs-only-on-the-operators-request.test.js
//
// OPERATOR DECISION, 2026-10-06 (verbatim): background goal work should run
// "When i ask it to. And when the app is running!".
//
// BUG-446's execution gate (goals/execution-gate.js) already refuses autonomous
// work for any goal that is not ACTIVE with budget left. That makes "active" the
// whole question: who can make a goal active, and does each one amount to the
// operator asking? This file pins the answer as a matrix derived from the code.
//
// FINDING (measured 2026-10-06 by reading every writer): the HUD's REST routes,
// the Goals.md checkbox and crash recovery are the operator's own acts or restore
// what the operator had already activated. Two MODEL-callable tools were not:
// `create_goal` minted an ACTIVE goal and `toggle_goal` reopened a done one, for
// any caller, with no check that the operator's words asked for it. In the Live
// adapter they sit in the allowlist; the authority gate (BUG-461/464) covered
// only trusted clicks and `remember`. The BUG-461 background-noise incident
// shows the model acting in turns where the operator said nothing; with these
// two tools that meant a goal the cortex would then run on its own tick.
//
// THE REPAIR is at the trusted boundary, in the shape BUG-464 used for `remember`:
// the effector needs a consent token minted server-side (leash/consent.js) only
// after the operator's own words asked for the goal (voice/goal-authority.js,
// called from voice/authority-gate.js on both the Live and the typed route).
// Without a token `create_goal` saves an inert PROPOSAL (the operator accepts it
// on the dashboard, or asks for it in words) and `toggle_goal` will not reopen a
// done goal. The model's arguments cannot carry the token.
//
// RED FIRST, 2026-10-06, against 323fba62: (1a) (1b) (1c) (1d) (1e) failed because
// create_goal / toggle_goal activated a goal with no consent, and (3x) because
// voice/goal-authority.js did not exist. Each failed for the reason named.
//
// MUTATIONS, 2026-10-06: table at the bottom of this file.
//
// ATTACK RECORD (rules/core.md §11):
//  1 What else matches? The judge reads only this turn's words. "Add a goal"
//    inside a quote, a hypothetical ("what if I said add a goal"), a negation
//    ("don't add a goal") and a bare four-word command all fail to mint (3c-3f).
//  2 Hides evidence? An unconsented create_goal is not a silent drop: it saves a
//    proposal and says so, naming the next step, so the transcript shows it.
//  3 Who reads the token? Only verifyConsent in the effector. Nothing else.
//  4 What is beside it? toggle_goal in the same file ALSO activates (done ->
//    active); both are derived below (2a), not typed.
//  5 Constant: GOAL_TOOLS is asserted EQUAL to the set derived from from-dashboard
//    source (2a), so a third activating tool fails there.
//  8 Disposition: the goal's TEXT is not bound to the operator's words (unlike
//    `remember`). The operator asked for "a goal"; the model words the title.
//    Pinned in (3g) so it is a recorded choice, not an oversight.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsNode = require('node:fs');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { mintConsent } = require('../src/core/leash/consent');
const gate = require('../src/core/voice/authority-gate');

async function world() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const goalSystem = createGoalSystem({ fs, config: {}, bus });
  await goalSystem.init();
  const bridge = createGoalsMdBridge({ fs, goalSystem, bus });
  const tools = buildTools({ goalsEffector: bridge }).TOOLS;
  const tool = (name) => tools.find((t) => t.name === name);
  return { dir, fs, goalSystem, bridge, tool };
}
const activeIds = (w) => w.goalSystem.getActiveGoals().map((g) => g.title);
const oneGoal = (w, title) => w.goalSystem.list().find((g) => g.title === title);

// What the cortex does with a goal once it exists: the real dispatch, autonomous.
function cortexRun(w, goalId) {
  const invoked = [];
  const ctx = {
    effectors: { invoke: async (tool) => { invoked.push(tool); return { ok: true, result: 'done' }; } },
    bus: { emit() {} }, goals: w.goalSystem, memory: { audit: { write() {} } }, config: {},
    goalId, tier: 1, channel: 'cortex',
  };
  return { invoked, run: () => dispatchAction({ tool: 'web_search', args: { q: 'x' } }, ctx) };
}

// ------------------------------------------------------------------ 1 --

describe('(1) a goal the model writes on its own is never active', () => {
  test('(1a) create_goal with NO consent saves an inert proposal, and the cortex cannot run it', async () => {
    const w = await world();
    try {
      const r = await w.tool('create_goal').fn({ text: 'Rebuild the website', category: 'Work' }, {});
      assert.equal(r.ok, true, 'a proposal is a success, honestly labelled');
      assert.equal(r.result.proposed, true);
      assert.match(r.result.message, /proposal/i);
      assert.match(r.result.message, /not running/i);
      assert.deepEqual(activeIds(w), [], 'the model alone made a goal ACTIVE');
      assert.equal(oneGoal(w, 'Rebuild the website').status, 'proposed');
      const c = cortexRun(w, oneGoal(w, 'Rebuild the website').id);
      await c.run();
      assert.deepEqual(c.invoked, [], 'the autonomous loop ran work for a goal the operator never asked for');
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1b) a FORGED consent (a plain object with the right fields) is not consent', async () => {
    const w = await world();
    try {
      const real = mintConsent({ tool: 'create_goal', args: { text: 'X goal' }, basis: 'operator-request' });
      const forged = JSON.parse(JSON.stringify(real));
      await w.tool('create_goal').fn({ text: 'X goal' }, { consent: forged });
      assert.deepEqual(activeIds(w), []);
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1c) consent minted for OTHER arguments does not carry over', async () => {
    const w = await world();
    try {
      const token = mintConsent({ tool: 'create_goal', args: { text: 'Water the plants' }, basis: 'operator-request' });
      await w.tool('create_goal').fn({ text: 'Email every contact' }, { consent: token });
      assert.deepEqual(activeIds(w), []);
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1d) one consent buys ONE goal: a replay of the same token is a proposal', async () => {
    const w = await world();
    try {
      const args = { text: 'Water the plants' };
      const token = mintConsent({ tool: 'create_goal', args, basis: 'operator-request' });
      await w.tool('create_goal').fn(args, { consent: token });
      await w.tool('create_goal').fn(args, { consent: token });
      assert.equal(w.goalSystem.list().filter((g) => g.title === 'Water the plants' && g.status === 'active').length, 1);
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1e) toggle_goal will not REOPEN a done goal without consent', async () => {
    const w = await world();
    try {
      const g = w.goalSystem.create({ title: 'Finish the report', drive: 'user-service', status: 'done' });
      w.bridge.writeBack();
      const r = await w.tool('toggle_goal').fn({ query: 'Finish the report' }, {});
      assert.equal(r.ok, false);
      assert.equal(w.goalSystem.get(g.id).status, 'done', 'the model reopened a goal on its own');
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1f) ADJACENT: with a real consent, create_goal is active and the cortex runs it (budget left)', async () => {
    const w = await world();
    try {
      const args = { text: 'Water the plants' };
      const r = await w.tool('create_goal').fn(args, { consent: mintConsent({ tool: 'create_goal', args, basis: 'operator-request' }) });
      assert.equal(r.ok, true);
      assert.deepEqual(activeIds(w), ['Water the plants']);
      const c = cortexRun(w, oneGoal(w, 'Water the plants').id);
      await c.run();
      assert.deepEqual(c.invoked, ['web_search'], 'an operator-requested goal with budget must still run');
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1g) ADJACENT: with consent toggle_goal reopens a done goal; closing an ACTIVE goal never needs consent', async () => {
    const w = await world();
    try {
      const done = w.goalSystem.create({ title: 'Finish the report', drive: 'user-service', status: 'done' });
      const live = w.goalSystem.create({ title: 'Call the plumber', drive: 'user-service', status: 'active' });
      w.bridge.writeBack();
      const args = { query: 'Finish the report' };
      await w.tool('toggle_goal').fn(args, { consent: mintConsent({ tool: 'toggle_goal', args, basis: 'operator-request' }) });
      assert.equal(w.goalSystem.get(done.id).status, 'active');
      await w.tool('toggle_goal').fn({ query: 'Call the plumber' }, {});
      assert.equal(w.goalSystem.get(live.id).status, 'done', 'stopping work must always be possible');
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1h) ADJACENT: a PAUSED goal never runs, however it got there', async () => {
    const w = await world();
    try {
      const g = w.goalSystem.create({ title: 'Paused thing', drive: 'user-service', status: 'paused' });
      const c = cortexRun(w, g.id);
      await c.run();
      assert.deepEqual(c.invoked, []);
    } finally { cleanupVaultDir(w.dir); }
  });

  test('(1i) ADJACENT: the HUD (operator surface, no tool) still adds an active goal', async () => {
    const w = await world();
    try {
      w.bridge.addGoal('Plan the trip', 'Home');
      assert.deepEqual(activeIds(w), ['Plan the trip']);
    } finally { cleanupVaultDir(w.dir); }
  });
});

// ------------------------------------------------------------------ 2 --

function walkJs(dir, visit) {
  for (const e of fsNode.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'public') walkJs(p, visit); continue; }
    if (e.name.endsWith('.js')) visit(p, fsNode.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, ''));
  }
}
const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
function scanTree(re) {
  const found = {};
  for (const sub of ['src', 'server']) {
    walkJs(path.join(ROOT, sub), (p, src) => {
      const n = (src.match(re) || []).length;
      if (n) found[rel(p)] = n;
    });
  }
  return found;
}

describe('(2) the matrix: every way a goal can become active, and every way work can start', () => {
  // ACTIVATION. Callers of the four bridge functions that set status 'active'
  // (sync() is internal and rides Goals.md; crash recovery and the desktop
  // controller are covered by the writer map in bug-446-autonomy-…).
  //   server/routes/goals.js   HUD REST, behind the /api auth gate: the operator's click.
  //   from-dashboard.js        the two MODEL tools: consent-bound since this fix.
  const ACTIVATION_CALLERS = {
    'server/routes/goals.js': 4,
    'src/core/effectors/from-dashboard.js': 2,
  };

  test('(2a) callers of addGoal/toggleGoal/resumeGoal/acceptProposal are exactly the HUD routes and the two consent-bound tools', () => {
    assert.deepEqual(scanTree(/(?<![\w])(?:goalsEffector|goalsBridge|goals)\.(?:addGoal|toggleGoal|resumeGoal|acceptProposal)\(/g), ACTIVATION_CALLERS,
      'a new caller of a goal-activating function: decide whether it is an operator act or needs consent, then update this map');
  });

  test('(2b) the tools that activate a goal are DERIVED from source and each is in the authority gate\'s GOAL_TOOLS', () => {
    const src = fsNode.readFileSync(path.join(ROOT, 'src/core/effectors/from-dashboard.js'), 'utf8').replace(/\r\n/g, '\n');
    const names = [];
    for (const chunk of src.split('\n  function ').slice(1)) {
      const name = chunk.slice(0, chunk.indexOf('('));
      if (/goalsEffector\.(?:addGoal|toggleGoal|resumeGoal|acceptProposal)\(/.test(chunk.split('\n  }\n')[0])) names.push(name);
    }
    // The desktop controller's start() creates its own ACTIVE goal; the tools whose fn reaches it are derived too.
    const ctl = fsNode.readFileSync(path.join(ROOT, 'src/core/desktop/controller.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(ctl.split('function start(')[1].split('\n  }\n')[0], /goals\.create\([^)]*status: 'active'/, 'fixture check: start() still creates an active goal');
    const desk = fsNode.readFileSync(path.join(ROOT, 'src/core/effectors/from-desktop.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const chunk of desk.split("{ name: '").slice(1)) {
      if (/startWithConsent|invoke\('start'/.test(chunk.split('\n    {')[0])) names.push(chunk.slice(0, chunk.indexOf("'")));
    }
    assert.ok(names.length >= 3, 'fixture check: the scan found the three activating tools, not nothing');
    assert.deepEqual([...gate.GOAL_TOOLS].sort(), names.sort());
  });

  // START. Every call site of the one shared dispatch. Each is classed; a new one
  // fails here and is read before it ships. "gated" = BUG-446 execution gate.
  //   cortex/index.js (2)             the autonomous tick + a cortex-raised confirm: GATED
  //   server/index.js                 the dispatch wrapper, the confirm-accept route (origin forwarded: GATED),
  //                                   volume ducking, boot briefing read, hotkey, media widget: operator/UI events
  //   voice/live-tool-adapter.js, authority-gate.js   operator voice, consent-bound
  //   sensors/reminder-sensor.js      a reminder the operator set, fires while the app runs, leash-checked
  //   engagements/executor.js (2)     an engagement the operator approved (state machine 'approve'); re-armed at
  //                                   boot only from EXECUTING/AWAITING_STAGE_APPROVAL. NOT checked against goal status.
  //   desktop/runtime.js              an observed desktop task the operator's voice started
  //   effectors/from-spotify.js       a spoken Spotify action
  //   main.js                         the Gmail unread poll (a read, T1)
  const START_SITES = {
    'server/index.js': 7,
    'server/routes/media.js': 1,
    'server/test-hatch.js': 1,
    'src/core/cortex/index.js': 2,
    'src/core/desktop/runtime.js': 1,
    'src/core/effectors/from-spotify.js': 1,
    'src/core/engagements/executor.js': 2,
    'src/core/sensors/reminder-sensor.js': 1,
    'src/core/voice/authority-gate.js': 1,
    'src/core/voice/live-tool-adapter.js': 3,
    'src/main.js': 1,
  };
  test('(2c) the call sites of the shared dispatch are exactly the classified set', () => {
    assert.deepEqual(scanTree(/(?<!function\s)(?<![\w'"`.])dispatchAction\(/g), START_SITES,
      'a new place that starts work: classify it (operator, gated, or consent-bound) and update this map');
  });

  test('(2d) nothing outside the cortex tick starts work on a timer for a goal: the only OS scheduler entry launches the APP', () => {
    const hits = {};
    for (const sub of ['src', 'server', 'scripts']) {
      walkJs(path.join(ROOT, sub), (p, src) => {
        if (/schtasks|Register-ScheduledTask|crontab|RunOnce|setLoginItemSettings|openAtLogin/.test(src)) hits[rel(p)] = true;
      });
    }
    assert.deepEqual(Object.keys(hits).sort(), ['scripts/setup-autostart.js'],
      'a scheduler/login-item reference appeared: work started outside the running app breaks "when the app is running"');
    const s = fsNode.readFileSync(path.join(ROOT, 'scripts/setup-autostart.js'), 'utf8');
    assert.match(s, /Start Agent OS\.bat/, 'the registered task must run the launcher, not a goal runner');
  });
});

// ------------------------------------------------------------------ 3 --

describe('(3) the judge: only the operator\'s own words, this turn, ask for a goal', () => {
  const judge = () => require('../src/core/voice/goal-authority').judgeGoalRequest;
  const create = (said) => judge()({ tool: 'create_goal', current: said });
  const reopen = (said) => judge()({ tool: 'toggle_goal', current: said });

  test('(3a) explicit requests to create a goal proceed', () => {
    for (const said of ['Please create a goal to water the plants every morning', 'Add a new goal: finish the quarterly report',
      "I'd like you to set a goal to learn the new codebase", 'Can you add a to-do to call the plumber tomorrow']) {
      assert.equal(create(said).proceed, true, said);
    }
  });
  test('(3b) explicit requests to reopen proceed for toggle_goal only', () => {
    assert.equal(reopen('Please reopen the goal about the quarterly report').proceed, true);
    assert.equal(create('Please reopen the goal about the quarterly report').proceed, false, 'a reopen request is not a create request');
  });
  test('(3c) no words, or other words, do not', () => {
    assert.equal(create('').proceed, false);
    assert.equal(create('The weather is nice today and I am just having my coffee').proceed, false);
  });
  test('(3d) a negation, a hypothetical, a quote and a denial do not', () => {
    for (const said of ["Don't create a goal for that please", 'What if I said add a goal to clean the garage', 'He said "add a goal to buy milk" to his phone',
      "I didn't say add a goal, that was background noise"]) {
      assert.equal(create(said).proceed, false, said);
    }
  });
  test('(3e) a bare short command that leaves the title to the model does not', () => {
    assert.equal(create('Add a goal.').proceed, false);
  });
  test('(3f) ADJACENT: the same judge still lets a normal request through after those refusals', () => {
    assert.equal(create('Add a goal to call my sister on Sunday').proceed, true);
  });
  test('(3g) DISPOSITION: the goal title is not bound to the operator\'s words — they asked for a goal, the model words it', () => {
    assert.equal(judge()({ tool: 'create_goal', current: 'Please add a goal to look into the budget', args: { text: 'Review Q3 budget spreadsheet' } }).proceed, true);
  });
});

// ------------------------------------------------------------------ 4 --

describe('(4) both routes mint consent from the operator\'s words, and only from them', () => {
  const GOAL = { tool: 'create_goal', args: { text: 'Water the plants' } };
  const deps = () => ({ leash: { confirm: {} }, connectionId: 'c1', pendingConfirms: new Map(), dispatchAction: async () => ({ ok: true }) });

  test('(4a) Live route: the operator asked -> a token for exactly this call; nothing said -> none', () => {
    const g = gate.createAuthorityGate(deps());
    const asked = g.hold({ id: 'a' }, GOAL, { allow: true, reason: 'within-autonomous-max', tier: 1 }, { spoken: 'Please add a goal to water the plants every morning', typed: '' });
    assert.ok(asked.consent, 'the operator asked and no consent was minted');
    const silent = g.hold({ id: 'b' }, GOAL, { allow: true, reason: 'within-autonomous-max', tier: 1 }, { spoken: '', typed: '' });
    assert.equal(silent.consent, undefined);
    assert.equal(silent.response, undefined, 'a refusal is the effector\'s proposal, not a held turn');
  });
  test('(4b) typed route: same rule', () => {
    const t = gate.createTypedMemoryGate();
    assert.ok(t.hold(GOAL, 'Please add a goal to water the plants every morning', 'c1').consent);
    assert.equal(t.hold(GOAL, 'hmm what a day', 'c1').consent, undefined);
  });
  test('(4c) ADJACENT: a goal-tool call does not disturb the trusted-click and remember paths', () => {
    const g = gate.createAuthorityGate(deps());
    const other = g.hold({ id: 'c' }, { tool: 'web_search', args: { q: 'x' } }, { allow: true, reason: 'within-autonomous-max', tier: 1 }, { spoken: '', typed: '' });
    assert.deepEqual(other, {});
  });
});

// ------------------------------------------------------------------ 5 --
// EXTENSION, 2026-10-06 (coordinator, gate B: the operator's rule covers every tool
// that makes an active goal, not just the two found first). desktop_task_start
// creates an ACTIVE goal in controller.start() and runs it at once. Without the
// operator's words this turn nothing is created: a task runs now or not at all, so
// the fallback is a refusal that names the next step, not a proposal.
// RED FIRST, 2026-10-06: (5a) (5b) (5e) failed because start ran for any caller and
// the desktop route minted nothing; (5c)-(5d) need the new judge branch.

describe('(5) desktop_task_start needs the operator\'s words', () => {
  const { buildTools: desktopTools } = require('../src/core/effectors/from-desktop');
  const startTool = (calls) => desktopTools({ controller: { start: (args, ctx) => { calls.push({ args, ctx }); return { ok: true, started: true }; } } })
    .find((t) => t.name === 'desktop_task_start');

  test('(5a) no consent: the controller is never reached, and the refusal names the next step', async () => {
    const calls = [];
    const r = await startTool(calls).fn({ request: 'Play third on YouTube' }, { connectionId: 'c1' });
    assert.deepEqual(calls, [], 'a model-only call created an active goal');
    assert.equal(r.ok, false);
    assert.equal(r.notExecuted, true);
    assert.match(r.result, /ask|asks/i);
    // 2026-10-06: the next step is a structured remedy, not prose naming the tool
    // (remedy-prose-ratchet, BUG-425). `request` is left for the operator's words, so
    // the model cannot fill it from this refusal. Probe: put the tool name back into
    // the result text and drop the remedy -> this test and the ratchet both go red.
    assert.doesNotMatch(r.result, /desktop_task_start/);
    assert.deepEqual(r.remedy && { tool: r.remedy.tool, args: r.remedy.args, needsInput: r.remedy.needsInput }, { tool: 'desktop_task_start', args: {}, needsInput: ['request'] });
  });
  test('(5b) a forged token, a token for other arguments and a replayed token are not consent', async () => {
    const calls = [];
    const args = { request: 'Play third on YouTube' };
    const real = mintConsent({ tool: 'desktop_task_start', args, basis: 'operator-request' });
    await startTool(calls).fn(args, { connectionId: 'c1', consent: JSON.parse(JSON.stringify(real)) });
    await startTool(calls).fn({ request: 'Open YouTube' }, { connectionId: 'c1', consent: real });
    assert.deepEqual(calls, []);
    await startTool(calls).fn(args, { connectionId: 'c1', consent: real });
    await startTool(calls).fn(args, { connectionId: 'c1', consent: real });
    assert.equal(calls.length, 1, 'one consent buys one start');
  });
  test('(5c) ADJACENT: voice "start a desktop task to play result 3" still works end to end through the gate', async () => {
    const calls = [];
    const decision = { tool: 'desktop_task_start', args: { request: 'Play third on YouTube' } };
    const g = gate.createAuthorityGate({ leash: { confirm: {} }, connectionId: 'c1', pendingConfirms: new Map(), dispatchAction: async () => ({ ok: true }) });
    const held = g.hold({ id: 'a' }, decision, { allow: true, reason: 'within-autonomous-max', tier: 1 }, { spoken: 'Play the third video on YouTube', typed: '' });
    assert.ok(held.consent);
    await startTool(calls).fn(decision.args, { connectionId: 'c1', consent: held.consent });
    assert.equal(calls.length, 1);
  });
  test('(5d) the judge: asked in words proceeds; silence, noise, negation, hypothetical do not', () => {
    const j = (said) => require('../src/core/voice/goal-authority').judgeGoalRequest({ tool: 'desktop_task_start', current: said }).proceed;
    assert.equal(j('Play the third video on YouTube'), true);
    assert.equal(j('Pause the video'), true);
    for (const said of ['', 'What a lovely evening', "Don't play anything", 'What if I said play the video', 'I never said play it']) assert.equal(j(said), false, said);
  });
  test('(5e) the server\'s desktop route (the operator\'s utterance, parsed server-side) mints the consent too, and only for a request', async () => {
    const { createDesktopConnection } = require('../server/desktop-connection');
    const seen = [];
    async function run(text) {
      let conn;
      conn = createDesktopConnection({
        runtime: { bind() {}, watch() {}, unbind: async () => {}, controller: { status: () => ({ ok: false }), settled: async () => ({}) } },
        connectionId: 'c1', leash: { check: () => ({ allow: true, tier: 1 }) },
        dispatch: async (decision, ctx) => { seen.push({ decision, ctx }); return { ok: false, result: 'stub' }; },
        send() {}, historyAppend() {}, cancelSpeech() {}, speak: async () => {},
        reply: async (id, t, opts) => { conn.handle({ type: 'desktop-speech-drained', speechId: opts.desktopSpeechId }); },
      });
      conn.handle({ type: 'utterance', text, reqId: 'r-' + seen.length + text.length });
      await new Promise((r) => setTimeout(r, 30));
      await conn.close();
    }
    await run('Play the third video on YouTube');
    assert.equal(seen.length, 1);
    assert.ok(seen[0].ctx.consent, 'the operator\'s own utterance reached dispatch with no consent');
    assert.equal(require('../src/core/leash/consent').verifyConsent(seen[0].ctx.consent, 'desktop_task_start', seen[0].decision.args).ok, true);
  });
});

// ------------------------------------------------------------------ 6 --
// EXTENSION, 2026-10-06: the engagement executor ran with channel 'engagement' and
// goals:null, so pausing an engagement's goal did nothing. Now: an operator approve
// (or a stage approval) still starts it and runs its first stage; at every later
// stage boundary a goal that is not ACTIVE stops it; boot re-arms it only if the
// goal is still active. An engagement with no goalId is unchanged.
// RED FIRST, 2026-10-06: (6a) (6b) (6e) failed with goalHalt() returning null (the
// pre-change behaviour): the second stage dispatched for a paused goal.

describe('(6) an engagement stops when its goal is no longer active', () => {
  const { createEngagement } = require('../src/core/engagements/index');
  const { createEngagementExecutor } = require('../src/core/engagements/executor');
  const stateMachine = require('../src/core/engagements/state-machine');

  function eHarness(goalStatus) {
    const emitted = [];
    const bus = { emit: (type, payload) => emitted.push({ type, payload }), subscribe() {} };
    const records = new Map();
    const store = {
      write: (r) => records.set(r.id, JSON.parse(JSON.stringify(r))), read: (id) => (records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null),
      list: () => [...records.keys()], remove: (id) => records.delete(id),
    };
    const goal = { id: 'goal-abc123', status: goalStatus };
    const goals = { get: (id) => (id === goal.id ? goal : undefined) };
    const calls = [];
    const dispatch = async (decision) => { calls.push(decision.tool); if (decision.tool === 'pause_after') goal.status = 'paused'; return { ok: true, result: { ok: true } }; };
    const engagement = createEngagement({ bus, config: { ENGAGEMENT_MAX_REPAIRS: 2 }, store,
      stateMachine: stateMachine.createStateMachine({ config: {} }), interview: require('../src/core/engagements/interview').createInterview({ config: {} }) });
    const executor = createEngagementExecutor({ bus, config: { ENGAGEMENT_MAX_REPAIRS: 2, ENGAGEMENT_STAGE_TIMEOUT_MS: 5000 }, dispatchAction: dispatch,
      leash: { check: () => ({ allow: true, tier: 0, reason: 'test' }), confirm: { create: () => 'c' } }, brain: null,
      checkpoints: { create: () => ({ id: 'cp' }) }, store: engagement, engagementStore: store, goals, vault: null, logger: null });
    function seed(tools, goalId) {
      const rec = engagement.create({ initialIntent: 'intent', goalId });
      const stages = tools.map((t, i) => ({ id: 's' + i, name: 's' + i, kind: 'action', type: 'action', actions: [{ tool: t, args: {} }],
        verification: { type: 'research', claims: [] }, requiresApproval: false }));
      store.write(Object.assign({}, rec, { status: 'EXECUTING', plan: { stages, currentStageIndex: 0, approvedAt: Date.now() },
        execution: { stageResults: [], currentStageId: null, repairBudget: { used: 0, max: 2 } } }));
      return rec.id;
    }
    return { emitted, store, calls, goal, executor, seed };
  }
  const halts = (h) => h.emitted.filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'engagement-goal-not-active');

  test('(6a) the goal is paused DURING stage one: stage two never dispatches, the engagement stays EXECUTING, and the stop is recorded', async () => {
    const h = eHarness('active');
    const id = h.seed(['pause_after', 'second'], 'goal-abc123');
    await h.executor.runEngagement(id);
    assert.deepEqual(h.calls, ['pause_after'], 'work continued past a paused goal');
    assert.equal(h.store.read(id).status, 'EXECUTING');
    assert.equal(halts(h).length, 1);
    assert.equal(halts(h)[0].payload.goalStatus, 'paused');
  });
  test('(6b) an operator approve of an engagement whose goal is already paused still runs its FIRST stage, then stops', async () => {
    const h = eHarness('paused');
    const id = h.seed(['first', 'second'], 'goal-abc123');
    await h.executor.runEngagement(id);
    assert.deepEqual(h.calls, ['first']);
  });
  test('(6c) ADJACENT: an approved engagement with an ACTIVE goal runs every stage to COMPLETED', async () => {
    const h = eHarness('active');
    const id = h.seed(['one', 'two'], 'goal-abc123');
    await h.executor.runEngagement(id);
    assert.deepEqual(h.calls, ['one', 'two']);
    assert.equal(h.store.read(id).status, 'COMPLETED');
  });
  test('(6d) ADJACENT: an engagement with NO goal is untouched', async () => {
    const h = eHarness('paused');
    const id = h.seed(['one', 'two'], undefined);
    await h.executor.runEngagement(id);
    assert.deepEqual(h.calls, ['one', 'two']);
  });
  test('(6f) DISPOSITION: a goal id that cannot be read does not stop an approved engagement (nothing says the ask was withdrawn)', async () => {
    const h = eHarness('active');
    const id = h.seed(['one', 'two'], 'goal-ffffff');
    await h.executor.runEngagement(id);
    assert.deepEqual(h.calls, ['one', 'two']);
  });
  test('(6e) boot re-arm: an EXECUTING engagement whose goal is paused is NOT resumed; with an active goal it is', async () => {
    const paused = eHarness('paused');
    const pid = paused.seed(['one'], 'goal-abc123');
    paused.executor.init();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(paused.calls, [], 'boot resumed work for a paused goal');
    assert.equal(paused.store.read(pid).status, 'EXECUTING');
    assert.equal(halts(paused).length, 1);
    const live = eHarness('active');
    const lid = live.seed(['one'], 'goal-abc123');
    live.executor.init();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(live.calls, ['one']);
    assert.equal(live.store.read(lid).status, 'COMPLETED');
  });
});

// MUTATION TABLE, 2026-10-06. Twelve probes, each applied (sha256 changed), run
// against this file only, restored (sha256 equal); the tree-mutation probes add a
// line to src/core/planner/daily.js and restore it:
//   M1  create_goal ignores consent (always active)               -> (1a) (1b) (1c) (1d)
//   M2  consent check is truthiness, not verifyConsent            -> (1b) (1c) (1d)
//   M3  toggle_goal reopens a done goal without consent           -> (1e)
//   M4  the judge accepts any words                               -> (3b) (3c) (3d)
//   M5  the judge ignores negation                                -> (3d)
//   M6  the Live hold skips the goal tools                        -> (4a)
//   M7  the typed hold skips the goal tools                       -> (4b)
//   M8  GOAL_TOOLS drops toggle_goal                              -> (2b)
//   M9  a new caller of an activating bridge function appears     -> (2a)
//   M10 a scheduler/login-item reference appears outside autostart -> (2d)
//   M11 a new call site of the shared dispatch appears            -> (2c)
//   M12 the judge drops the bare-command rule                     -> (3e)
// Adjacent cases that must keep passing under every probe above: (1f) an
// operator-requested goal with budget still runs, (1g) closing a goal needs no
// consent, (1h) a paused goal never runs, (1i) the HUD still adds an active goal.
//
// EXTENSION probes, 2026-10-06 (same method; M13 is the red-first run for (6)):
//   M13 goalHalt always null (pre-change behaviour)               -> (6a) (6b) (6e)
//   M14 no boundary check between stages                          -> (6a) (6b)
//   M15 no boot re-arm check                                      -> (6e)
//   M16 desktop_task_start skips the consent check                -> (5a) (5b)
//   M17 the server's desktop route mints no consent               -> (5e)
//   M18 GOAL_TOOLS drops desktop_task_start                       -> (2b) (5c)
//   M19 the desktop judge accepts any words                       -> (5d)
//   M20 an unreadable goal halts the engagement                   -> (6a) (6f)
// Adjacent under all of them: (5c) voice still starts a task, (6c) an approved
// engagement with an active goal completes, (6d) one with no goal is untouched.
//
// NOT COVERED, on the record: the goal TITLE is not bound to the operator's words
// (3g); the judge is English only; an engagement stopped at a boundary stays
// EXECUTING until the next boot re-arm (it is not resumed the moment the goal is
// reactivated); an unreadable goal id does not stop an engagement (6f).
