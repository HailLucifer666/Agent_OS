'use strict';

// Phase 2 of the Hermes orchestration change: hermes-runner.js is the only
// module that knows how to drive the Hermes CLI. These tests mock
// adapters/hermes-agent's runTask (a singleton module.exports object — the
// property is read at call time, so monkey-patching it here is observed by
// hermes-runner.js without any DI seam needing to change) so the runner's
// own logic (plan parsing, the blocker taxonomy, progress polling) can be
// exercised without a real Hermes install.

const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createHermesRunner } = require('../src/core/effectors/hermes-runner');
const validate = require('../src/core/effectors/forge-validate');
const hermes = require('../adapters/hermes-agent');

function mockRunTask(fn) {
  const original = hermes.runTask;
  hermes.runTask = fn;
  return () => { hermes.runTask = original; };
}

describe('hermes-runner — runPlan', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createHermesRunner({ config: {}, vault });
  });
  afterEach(() => cleanupVaultDir(dir));

  it('constructor requires a vault fs-store', () => {
    assert.throws(() => createHermesRunner({ config: {} }));
    assert.throws(() => createHermesRunner({ config: {}, vault: {} }));
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
      // Belt-and-braces: plan run must be sandboxed to a scratch dir, never
      // the real project dir (Hermes hasn't proposed a slug yet at plan time).
      assert.equal(seenOpts.requireCli, true);
      assert.match(seenOpts.cwd, /_plan-scratch/);
      assert.match(seenOpts.env.HERMES_WRITE_SAFE_ROOT, /_plan-scratch/);
    } finally { restore(); }
  });

  it('parse failure mode 1: hermes.runTask throws → ok:false reason plan-failed', async () => {
    const restore = mockRunTask(async () => { throw new Error('hermes-agent OFFLINE: not installed'); });
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

describe('hermes-runner — runBuild + onProgress', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createHermesRunner({ config: { HERMES_POLL_MS: 20 }, vault });
  });
  afterEach(() => cleanupVaultDir(dir));

  it('cwd + write-safe-root are pinned to the project dir, and onProgress observes files written mid-run', async () => {
    const progressSnapshots = [];
    const restore = mockRunTask(async (prompt, opts) => {
      // Simulate Hermes writing files while the runner's poll timer is ticking.
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
    } finally { restore(); }
  });
});

describe('hermes-runner — runWidgetBuild (Phase C3, validated WIDGET SPEC build target)', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createHermesRunner({ config: {}, vault });
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
      assert.equal(seenOpts.requireCli, true);
      assert.match(seenOpts.cwd, /_widget-scratch/);
      assert.match(seenOpts.env.HERMES_WRITE_SAFE_ROOT, /_widget-scratch/);
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

  it('hermes.runTask throws → ok:false reason widget-build-failed', async () => {
    const restore = mockRunTask(async () => { throw new Error('hermes-agent OFFLINE: not installed'); });
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

describe('hermes-runner — classify() blocker taxonomy (exit 0 is not success)', () => {
  let dir, vault, runner;
  beforeEach(() => {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, { emit() {} });
    runner = createHermesRunner({ config: {}, vault });
    fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  });
  afterEach(() => cleanupVaultDir(dir));

  const dirAbs = () => path.join(dir, 'proj');

  it('branch 1 — error containing "timed out" → reason timeout', () => {
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest: null, reply: null, error: 'hermes CLI timed out after 1800000ms' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'timeout');
  });

  it('branch 2 — any other error → reason hermes-error', () => {
    const res = runner._classify({ dirAbs: dirAbs(), before: [], manifest: null, reply: null, error: 'hermes CLI exit 1: traceback...' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'hermes-error');
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
