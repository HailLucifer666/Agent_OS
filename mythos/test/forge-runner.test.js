'use strict';

// forge-runner.js is the only module that knows how to drive a multi-file build.
// These tests supply a FAKE ENGINE through the runner's constructor so the
// runner's own logic (plan parsing, the blocker taxonomy, progress polling) can
// be exercised without a real engine install.
//
// RENAMED with the runner by W6 (2026-08-22), and the mocking mechanism changed
// with it. This file used to monkey-patch adapters/hermes-agent's runTask on the
// singleton module.exports object, because the runner required that adapter at
// module scope and there was no DI seam. There is one now — createForgeRunner
// takes `engine` — so the fake is injected rather than patched onto a shared
// global. That also removes a real hazard: a patch that leaked (an early return,
// a throw before the finally) would silently affect every later test in the run.

const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createForgeRunner } = require('../src/core/effectors/forge-runner');
const validate = require('../src/core/effectors/forge-validate');

// The fake engine the runner under test is constructed with. `current` is
// swapped per test; the restore function is kept so every existing
// try/finally in this file goes on reading the same way.
let currentRunTask = async () => { throw new Error('no runTask installed for this test'); };
const fakeEngine = {
  runTask: (prompt, opts) => currentRunTask(prompt, opts),
  getStatus: () => ({ state: 'ONLINE', hint: 'fake engine' }),
};

function mockRunTask(fn) {
  const original = currentRunTask;
  currentRunTask = fn;
  return () => { currentRunTask = original; };
}

describe('forge-runner — runPlan', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createForgeRunner({ config: {}, vault, engine: fakeEngine });
  });
  afterEach(() => cleanupVaultDir(dir));

  it('planning and building receive the same UI asset contract before a manifest is approved', async () => {
    const contract = require('../src/core/skills/build-pack')._OUTPUT_CONTRACTS.ui;
    const seen = [];
    const restore = mockRunTask(async (prompt) => {
      seen.push(prompt);
      return JSON.stringify({ kind: 'website', files: [{ path: 'index.html' }] });
    });
    try {
      const planned = await runner.runPlan('a tiny static tide site', 'website');
      await runner.runBuild({ dirRel: 'builds/contract-probe', manifest: planned.manifest, spec: 'a tiny static tide site' });
      assert.equal(seen.length, 2);
      assert.ok(seen[0].includes(contract), 'planner must see inline-logo rule before proposing files');
      assert.ok(seen[1].includes(contract), 'builder must retain the same output requirements');
    } finally { restore(); }
  });

  it('constructor requires a vault fs-store', () => {
    assert.throws(() => createForgeRunner({ config: {}, engine: fakeEngine }));
    assert.throws(() => createForgeRunner({ config: {}, vault: {}, engine: fakeEngine }));
  });

  it('constructor requires an engine — a runner with no engine must not construct', () => {
    // The engine used to be a module-scope require, so "no engine" was not a
    // state this could reach. Now it is a parameter, and a runner built without
    // one would fail on the first build instead of at wiring time.
    assert.throws(() => createForgeRunner({ config: {}, vault }), /requires the dsh-agent adapter/);
    assert.throws(() => createForgeRunner({ config: {}, vault, engine: {} }), /requires the dsh-agent adapter/);
  });

  it('happy path: valid JSON plan → ok:true manifest, sandboxed to a scratch dir', async () => {
    let seenOpts;
    const restore = mockRunTask(async (prompt, opts) => {
      seenOpts = opts;
      return JSON.stringify({ name: 'Todo', kind: 'app', files: [{ path: 'index.html', purpose: 'shell' }], techNotes: 'vanilla' });
    });
    try {
      const res = await runner.runPlan('a todo app', 'app');
      assert.equal(res.ok, true);
      assert.equal(res.manifest.name, 'Todo');
      assert.deepEqual(res.manifest.files.map((f) => f.path), ['index.html']);
      // Belt-and-braces: a plan run must be sandboxed to a scratch dir, never
      // the real project dir (no slug has been proposed yet at plan time).
      assert.match(seenOpts.cwd, /_plan-scratch/);
      // W6: "write nothing" is now the SANDBOX's job, not the prompt's. A falsy
      // autoApprove selects dsh's read-only preset, so the engine is refused
      // permission to write rather than merely asked not to. Asserting the
      // absence matters — passing autoApprove here would silently re-enable
      // writes on the planning path.
      assert.ok(!seenOpts.autoApprove, 'a plan run must not request write permission');
      assert.equal(seenOpts.writeRoot, undefined);
    } finally { restore(); }
  });

  it('parse failure mode 1: engine.runTask throws → ok:false reason plan-failed', async () => {
    const restore = mockRunTask(async () => { throw new Error('dsh-agent OFFLINE: not installed'); });
    try {
      const res = await runner.runPlan('spec', 'app');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'plan-failed');
      assert.match(res.error, /OFFLINE/);
    } finally { restore(); }
  });

  it('parse failure mode 2: reply has no JSON at all → ok:false reason plan-unparseable', async () => {
    const restore = mockRunTask(async () => 'Sure! Here is a great app idea, no plan though.');
    try {
      const res = await runner.runPlan('spec', 'app');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'plan-unparseable');
    } finally { restore(); }
  });

  it('parse failure mode 3: valid JSON but files sanitize to empty (all unsafe/malformed) → plan-empty', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ name: 'X', kind: 'app', files: [{ path: '../evil.js' }, { path: '/abs.js' }] }));
    try {
      const res = await runner.runPlan('spec', 'app');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'plan-empty');
    } finally { restore(); }
  });

  it('parse failure mode 4: files key missing entirely → plan-empty, not a throw', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ name: 'X', kind: 'app' }));
    try {
      const res = await runner.runPlan('spec', 'app');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'plan-empty');
    } finally { restore(); }
  });

  it('reuses the fenced/brace-scan JSON extractor (Invariant 7) — plan wrapped in prose still parses', async () => {
    const restore = mockRunTask(async () => 'Here is the plan:\n```json\n{"name":"X","kind":"website","files":[{"path":"index.html"}]}\n```\nLet me know!');
    try {
      const res = await runner.runPlan('spec', 'website');
      assert.equal(res.ok, true);
      assert.equal(res.manifest.kind, 'website');
    } finally { restore(); }
  });
});

describe('forge-runner — runBuild + onProgress', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createForgeRunner({ config: { DSH_POLL_MS: 20 }, vault, engine: fakeEngine });
  });
  afterEach(() => cleanupVaultDir(dir));

  it('cwd + write-safe-root are pinned to the project dir, and onProgress observes files written mid-run', async () => {
    const progressSnapshots = [];
    let seenOpts;
    const restore = mockRunTask(async (prompt, opts) => {
      seenOpts = opts;
      // Simulate the engine writing files while the runner's poll timer ticks.
      fs.mkdirSync(opts.cwd, { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, 'index.html'), '<html></html>');
      await new Promise((r) => setTimeout(r, 60)); // let at least one poll tick fire
      fs.writeFileSync(path.join(opts.cwd, 'app.js'), 'const x = 1;');
      return 'Built it.';
    });
    try {
      const manifest = { kind: 'website', files: [{ path: 'index.html' }, { path: 'app.js' }], techNotes: '' };
      const res = await runner.runBuild({
        dirRel: 'builds/projects/todo',
        manifest,
        spec: 'a todo site',
        onProgress: (paths) => progressSnapshots.push(paths),
      });
      assert.equal(res.ok, true);
      assert.deepEqual(res.files, ['app.js', 'index.html']);
      assert.ok(progressSnapshots.some((snap) => snap.includes('index.html')), 'onProgress must have observed the mid-run partial state');
      // W6: INTENT, not another program's env vars. This used to pass
      // env: { HERMES_WRITE_SAFE_ROOT, HERMES_YOLO_MODE }. writeRoot must equal
      // cwd — dsh confines writes to its invoking directory and the adapter
      // throws rather than silently dropping a root it cannot honour.
      assert.equal(seenOpts.writeRoot, seenOpts.cwd);
      assert.equal(seenOpts.autoApprove, true);
      assert.equal(seenOpts.env && seenOpts.env.HERMES_WRITE_SAFE_ROOT, undefined);
    } finally { restore(); }
  });
});

describe('forge-runner — runWidgetBuild (Phase C3, validated WIDGET SPEC build target)', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createForgeRunner({ config: {}, vault, engine: fakeEngine });
  });
  afterEach(() => cleanupVaultDir(dir));

  it('happy path: valid dynamic spec → ok:true, sandboxed to a scratch dir (no project write-root)', async () => {
    let seenOpts;
    const restore = mockRunTask(async (prompt, opts) => {
      seenOpts = opts;
      return JSON.stringify({ kind: 'dynamic', title: 'Deploy Status', layout: 'stat', items: [{ label: 'Uptime', value: '99.9%', tone: 'gold' }] });
    });
    try {
      const res = await runner.runWidgetBuild('a stat widget showing uptime');
      assert.equal(res.ok, true);
      assert.deepEqual(res.spec, { kind: 'dynamic', title: 'Deploy Status', layout: 'stat', items: [{ label: 'Uptime', value: '99.9%', tone: 'gold' }] });
      assert.match(seenOpts.cwd, /_widget-scratch/);
      // Read-only, same reasoning as runPlan: a widget spec is DATA and nothing
      // on this path is supposed to touch disk.
      assert.ok(!seenOpts.autoApprove, 'a widget-spec run must not request write permission');
      assert.equal(seenOpts.writeRoot, undefined);
    } finally { restore(); }
  });

  it('happy path: a known static kind with no extra props → ok:true', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ kind: 'weather' }));
    try {
      const res = await runner.runWidgetBuild('show me the weather widget');
      assert.equal(res.ok, true);
      assert.deepEqual(res.spec, { kind: 'weather' });
    } finally { restore(); }
  });

  it('rejects an unknown widget kind — never rendered, reason widget-invalid', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ kind: 'iframe-embed', src: 'https://evil.example' }));
    try {
      const res = await runner.runWidgetBuild('embed a page');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'widget-invalid');
      assert.match(res.error, /unknown widget kind/);
    } finally { restore(); }
  });

  it('rejects props smuggled onto a static kind', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ kind: 'clock', onclick: 'alert(1)' }));
    try {
      const res = await runner.runWidgetBuild('a clock widget');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'widget-invalid');
    } finally { restore(); }
  });

  it('rejects a dynamic spec with a bad layout enum', async () => {
    const restore = mockRunTask(async () => JSON.stringify({ kind: 'dynamic', title: 'X', layout: 'carousel', items: [] }));
    try {
      const res = await runner.runWidgetBuild('spec');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'widget-invalid');
      assert.match(res.error, /layout must be one of/);
    } finally { restore(); }
  });

  it('reply with no JSON at all → ok:false reason widget-unparseable', async () => {
    const restore = mockRunTask(async () => 'Sure! Here is a widget description in prose.');
    try {
      const res = await runner.runWidgetBuild('spec');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'widget-unparseable');
    } finally { restore(); }
  });

  it('engine.runTask throws → ok:false reason widget-build-failed', async () => {
    const restore = mockRunTask(async () => { throw new Error('dsh-agent OFFLINE: not installed'); });
    try {
      const res = await runner.runWidgetBuild('spec');
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'widget-build-failed');
      assert.match(res.error, /OFFLINE/);
    } finally { restore(); }
  });

  it('adversarial: malicious strings in title/items/footer pass shape validation as inert data, never as markup', async () => {
    const restore = mockRunTask(async () => JSON.stringify({
      kind: 'dynamic',
      title: '<script>alert(1)</script>',
      layout: 'text',
      items: [{ label: '"><img src=x onerror=alert(1)>', value: 'javascript:alert(1)' }],
      footer: '"><svg onload=alert(1)>',
    }));
    try {
      const res = await runner.runWidgetBuild('spec');
      assert.equal(res.ok, true);
      // The spec is accepted as DATA — validation only vets shape, not content.
      // Nothing here is markup: it's plain strings inside a JS object. The HUD
      // renderer (kinds/dynamic.js) is the only place these strings ever touch
      // a DOM tree, and it escapes every one of them (escapeHtml) before
      // interpolating into innerHTML — see that file's own header comment.
      assert.equal(res.spec.title, '<script>alert(1)</script>');
      assert.equal(typeof res.spec.title, 'string');
      assert.ok(res.spec.items[0].label.indexOf('<img') !== -1);
    } finally { restore(); }
  });
});

describe('forge-runner — classify() blocker taxonomy (exit 0 is not success)', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createForgeRunner({ config: {}, vault, engine: fakeEngine });
    fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  });
  afterEach(() => cleanupVaultDir(dir));

  const dirAbs = () => path.join(dir, 'proj');

  it('branch 1 — error containing "timed out" → reason timeout', () => {
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest: null, reply: null, error: 'hermes CLI timed out after 1800000ms' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'timeout');
  });

  it('branch 2 — any other error → reason engine-error', () => {
    // RENAMED from 'hermes-error' with the engine (W6): the string named a
    // program, not a condition. forge.js switches on it, so both moved in one
    // commit rather than one being aliased.
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest: null, reply: null, error: 'dsh exit 1: traceback...' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'engine-error');
  });

  it('branch 3 — clean exit, zero files on disk → reason no-output (exit 0 is NOT success)', () => {
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest: { files: [{ path: 'index.html' }] }, reply: 'Done!', error: null });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'no-output');
  });

  it('branch 4 — some but not all planned files produced → reason partial, missing lists the gap', () => {
    fs.writeFileSync(path.join(dirAbs(), 'index.html'), '<html></html>');
    const manifest = { files: [{ path: 'index.html' }, { path: 'app.js' }] };
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest, reply: 'Done!', error: null });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'partial');
    assert.deepEqual(res.missing, ['app.js']);
  });

  it('branch 5 — every planned file present → ok:true', () => {
    fs.writeFileSync(path.join(dirAbs(), 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dirAbs(), 'app.js'), 'x');
    const manifest = { files: [{ path: 'index.html' }, { path: 'app.js' }] };
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest, reply: 'Done!', error: null });
    assert.equal(res.ok, true);
    assert.deepEqual(res.files, ['app.js', 'index.html']);
  });

  it('an unplanned extra file Hermes chose to add is reported in "added", not treated as missing', () => {
    fs.writeFileSync(path.join(dirAbs(), 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dirAbs(), 'README.md'), 'notes');
    const manifest = { files: [{ path: 'index.html' }] };
    const res = runner._classify({ dirAbs: dirAbs(), before: ['index.html'], manifest, reply: 'Done!', error: null });
    assert.equal(res.ok, true);
    assert.deepEqual(res.added, ['README.md']);
  });
});

describe('forge-validate — walkProjectFiles', () => {
  let dir;
  beforeEach(() => { dir = tempVaultDir(); });
  afterEach(() => cleanupVaultDir(dir));

  it('missing directory → empty list, never throws', () => {
    assert.deepEqual(validate.walkProjectFiles(path.join(dir, 'does-not-exist')), []);
  });

  it('walks nested directories, returns forward-slash relative paths, sorted', () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(proj, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'index.html'), 'x');
    fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'x');
    fs.writeFileSync(path.join(proj, 'src', 'nested', 'deep.js'), 'x');
    const out = validate.walkProjectFiles(proj);
    assert.deepEqual(out, ['index.html', 'src/app.js', 'src/nested/deep.js']);
  });

  it('skips node_modules, .git, .venv, __pycache__, dist, build, .next', () => {
    const proj = path.join(dir, 'proj');
    const skipDirs = ['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.next'];
    for (const d of skipDirs) {
      fs.mkdirSync(path.join(proj, d), { recursive: true });
      fs.writeFileSync(path.join(proj, d, 'noise.txt'), 'x');
    }
    fs.writeFileSync(path.join(proj, 'index.html'), 'x');
    assert.deepEqual(validate.walkProjectFiles(proj), ['index.html']);
  });
});
