'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createForge } = require('../src/core/effectors/forge');
const prompts = require('../src/core/effectors/forge-prompts');
const validate = require('../src/core/effectors/forge-validate');

// ---- test doubles ----

function fakeCheckpoints() {
  const created = [];
  return {
    create(opts) {
      const rec = Object.assign({ id: 'cp-' + (created.length + 1) }, opts);
      created.push(rec);
      return { id: rec.id, kind: rec.kind, projectId: rec.projectId };
    },
    _created: created,
    _byKind(kind) { return created.filter((c) => c.kind === kind); },
    _last() { return created[created.length - 1]; },
    async _approve(idx) { const r = created[idx != null ? idx : created.length - 1]; return r && r.onApprove ? r.onApprove(r) : null; },
    async _reject(idx, feedback) { const r = created[idx != null ? idx : created.length - 1]; return r && r.onReject ? r.onReject(r, feedback) : null; },
  };
}

const VALID_HTML = '<!DOCTYPE html><html><head><title>Todo</title></head><body><h1 id="title">Todo</h1></body></html>';
const VALID_JS = 'const app = { started: true };\nfunction run() { return app.started; }\n';

function cannedBrain(cfg) {
  cfg = cfg || {};
  return {
    calls: [],
    think: async function ({ source }) {
      this.calls.push(source);
      await Promise.resolve();
      if (/:manifest/.test(source)) {
        if (cfg.manifestGarbage) return { content: 'sorry, no plan today', parsed: null, offline: false };
        const body = cfg.manifest;
        return { content: JSON.stringify(body), parsed: cfg.manifestParsed === false ? null : body, offline: false };
      }
      if (/:revision/.test(source)) return { content: JSON.stringify(cfg.revision), parsed: cfg.revision, offline: false };
      if (/:file:/.test(source)) {
        const p = source.split(':file:')[1];
        const content = typeof cfg.fileContent === 'function' ? cfg.fileContent(p) : cfg.fileContent;
        return { content: content, parsed: null, offline: false };
      }
      return { content: '', parsed: null, offline: false };
    },
  };
}

function waitFor(cond, ms) {
  ms = ms || 2000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function loop() {
      let v = false;
      try { v = cond(); } catch (_) { v = false; }
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'));
      setTimeout(loop, 5);
    })();
  });
}

const APP_MANIFEST = {
  name: 'Todo App', kind: 'app', techNotes: 'vanilla',
  files: [{ path: 'index.html', purpose: 'shell' }, { path: 'app.js', purpose: 'logic' }],
};

function fileContentFor(p) { return /\.html$/.test(p) ? VALID_HTML : VALID_JS; }

describe('forge — multi-file build pipeline', () => {
  let dir, bus, fs, cps;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); cps = fakeCheckpoints(); });
  afterEach(() => cleanupVaultDir(dir));

  function make(brain, cfg) {
    return createForge({ config: Object.assign({ FORGE_MAX_FILES: 12, FORGE_FILE_RETRY: 2, FORGE_CONCURRENCY: 2 }, cfg), brain, bus, vault: fs, checkpoints: cps });
  }

  it('constructor requires brain, vault, bus, checkpoints', () => {
    assert.throws(() => createForge({ bus, vault: fs, checkpoints: cps }));
    assert.throws(() => createForge({ brain: cannedBrain(), vault: fs, checkpoints: cps }));
    assert.throws(() => createForge({ brain: cannedBrain(), bus, vault: fs }));
  });

  it('manifest parsed fast-path → awaiting-plan-approval + plan checkpoint armed', async () => {
    const forge = make(cannedBrain({ manifest: APP_MANIFEST, fileContent: fileContentFor }));
    const { id } = forge.createProject('a todo app', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    const p = forge.getProject(id);
    assert.equal(p.files.length, 2);
    assert.equal(cps._byKind('plan-approval').length, 1);
    assert.equal(p.previewUrl, '/vault/builds/projects/todo-app/index.html');
  });

  it('manifest content-fallback (parsed absent) still plans', async () => {
    const forge = make(cannedBrain({ manifest: APP_MANIFEST, manifestParsed: false, fileContent: fileContentFor }));
    const { id } = forge.createProject('a todo app', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    assert.equal(forge.getProject(id).files.length, 2);
  });

  it('garbage manifest (both attempts) → failed, never throws', async () => {
    const brain = cannedBrain({ manifestGarbage: true });
    const forge = make(brain);
    const { id } = forge.createProject('a todo app', 'app');
    await waitFor(() => forge.getProject(id).status === 'failed');
    assert.match(forge.getProject(id).error, /file plan/);
    assert.equal(brain.calls.filter((c) => /manifest/.test(c)).length, 2); // one repair re-prompt
  });

  it('full happy path: create → approve plan → generate → approve final → done', async () => {
    const forge = make(cannedBrain({ manifest: APP_MANIFEST, fileContent: fileContentFor }));
    const { id } = forge.createProject('a todo app', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._approve(0); // plan-approval onApprove runs generation to completion
    await waitFor(() => forge.getProject(id).status === 'awaiting-final-review');
    assert.ok(fs.exists('builds/projects/todo-app/index.html'));
    assert.ok(fs.exists('builds/projects/todo-app/app.js'));
    assert.equal(cps._byKind('final-review').length, 1);
    await cps._approve(); // final-review onApprove
    assert.equal(forge.getProject(id).status, 'done');
    assert.equal(forge.getProject(id).filesDone, 2);
  });

  it('plan reject → plan-rejected terminal', async () => {
    const forge = make(cannedBrain({ manifest: APP_MANIFEST, fileContent: fileContentFor }));
    const { id } = forge.createProject('a todo app', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._reject(0);
    assert.equal(forge.getProject(id).status, 'plan-rejected');
  });

  it('JS validation fails all attempts → file failed (retry happened) → project failed', async () => {
    const manifest = { name: 'Broken', kind: 'app', files: [{ path: 'app.js', purpose: 'x' }] };
    const forge = make(cannedBrain({ manifest, fileContent: 'function ( { syntax error' }), { FORGE_FILE_RETRY: 1 });
    const { id } = forge.createProject('broken', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._approve(0);
    await waitFor(() => forge.getProject(id).status === 'failed');
    const p = forge.getProject(id);
    assert.equal(p.files[0].status, 'failed');
    assert.equal(p.files[0].attempts, 2); // FILE_RETRY(1) + 1
  });

  it('FORGE_CONCURRENCY bounds simultaneous file generation', async () => {
    const manifest = { name: 'Many', kind: 'app', files: [1, 2, 3, 4, 5].map((n) => ({ path: 'f' + n + '.js', purpose: 'p' })) };
    let active = 0, maxActive = 0;
    const brain = {
      calls: [],
      think: async ({ source }) => {
        if (/:file:/.test(source)) {
          active += 1; maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
          return { content: VALID_JS, parsed: null, offline: false };
        }
        return { content: JSON.stringify(manifest), parsed: manifest, offline: false };
      },
    };
    const forge = make(brain, { FORGE_CONCURRENCY: 2 });
    const { id } = forge.createProject('many', 'app');
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._approve(0);
    await waitFor(() => forge.getProject(id).status === 'awaiting-final-review');
    assert.ok(maxActive <= 2, 'max concurrent was ' + maxActive);
    assert.ok(maxActive >= 2, 'expected the pump to reach the bound');
  });

  it('crash recovery: seeded generating project → interrupted at init', () => {
    fs.writeJSON('Checkpoints/forge-projects.json', [
      { id: 'forge-old', name: 'X', kind: 'app', status: 'generating', spec: 's', slug: 'x', files: [{ path: 'a.js', status: 'generating', attempts: 1 }], manifest: { name: 'X', kind: 'app', files: [] }, createdAt: 1 },
    ]);
    const forge = make(cannedBrain({ manifest: APP_MANIFEST }));
    forge.init();
    assert.equal(forge.getProject('forge-old').status, 'interrupted');
  });

  it('awaiting-plan-approval seed → init re-arms a fresh plan checkpoint', () => {
    fs.writeJSON('Checkpoints/forge-projects.json', [
      { id: 'forge-a', name: 'A', kind: 'app', status: 'awaiting-plan-approval', spec: 's', slug: 'a',
        files: [{ path: 'index.html', purpose: 'p', status: 'pending', attempts: 0 }],
        manifest: { name: 'A', kind: 'app', techNotes: '', files: [{ path: 'index.html', purpose: 'p', status: 'pending', attempts: 0 }] }, createdAt: 1 },
    ]);
    const forge = make(cannedBrain({ manifest: APP_MANIFEST }));
    forge.init();
    assert.equal(cps._byKind('plan-approval').length, 1);
    assert.equal(cps._last().projectId, 'forge-a');
  });
});

describe('forge-prompts + forge-validate — pure helpers', () => {
  let dir, bus, fs;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); });
  afterEach(() => cleanupVaultDir(dir));

  it('sanitizeManifestFiles clamps at hardCap and drops unsafe/dup', () => {
    const raw = [
      { path: 'a.js' }, { path: 'a.js' }, { path: '../evil.js' }, { path: '/abs.js' },
      { path: 'C:/win.js' }, { path: 'b.js' }, { path: 'c.js' }, { path: 'd.js' },
    ];
    const out = prompts.sanitizeManifestFiles(raw, 2);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f.path), ['a.js', 'b.js']);
  });

  it('isUnsafePath rejects traversal, absolute, drive-letter, empty', () => {
    ['', '/x', '..', 'a/../b', 'C:/x', '\\\\..\\\\y'].forEach((p) => assert.equal(prompts.isUnsafePath(p), true, p));
    assert.equal(prompts.isUnsafePath('a/b/c.js'), false);
  });

  it('extractJsonObject: direct, fenced, brace-scan; never throws', () => {
    assert.deepEqual(prompts.extractJsonObject('{"a":1}'), { a: 1 });
    assert.deepEqual(prompts.extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(prompts.extractJsonObject('noise {"a":3} tail'), { a: 3 });
    assert.equal(prompts.extractJsonObject('nothing here'), null);
    assert.equal(prompts.extractJsonObject('<think>{"x":1}</think> garbage'), null);
  });

  it('tryExtractManifest never throws on garbage / offline', () => {
    assert.equal(prompts.tryExtractManifest({ offline: true }, {}, 5), null);
    assert.equal(prompts.tryExtractManifest({ content: 'lol' }, {}, 5), null);
    const m = prompts.tryExtractManifest({ content: '{"name":"X","kind":"website","files":[{"path":"index.html"}]}' }, {}, 5);
    assert.equal(m.kind, 'website');
    assert.equal(m.files[0].path, 'index.html');
  });

  it('writeProjectFile blocks path traversal but writes safe paths', () => {
    assert.throws(() => validate.writeProjectFile(fs, 'slug', '../evil.js', 'x'));
    assert.throws(() => validate.writeProjectFile(fs, 'slug', '/etc/x', 'x'));
    const r = validate.writeProjectFile(fs, 'slug', 'sub/ok.js', 'const a=1;');
    assert.ok(fs.exists('builds/projects/slug/sub/ok.js'));
    assert.equal(r.rel, '/vault/builds/projects/slug/sub/ok.js');
  });

  it('validateFileContent: json/js/html/css/other', () => {
    assert.equal(validate.validateFileContent('a.json', '{"a":1}').ok, true);
    assert.equal(validate.validateFileContent('a.json', '{bad').ok, false);
    assert.equal(validate.validateFileContent('a.js', 'const x=1;').ok, true);
    assert.equal(validate.validateFileContent('a.js', 'function ( {').ok, false);
    assert.equal(validate.validateFileContent('a.html', '<html><body>hi</body></html>').ok, true);
    assert.equal(validate.validateFileContent('a.html', '<div>no html tag</div>').ok, false);
    assert.equal(validate.validateFileContent('a.css', '.x{color:red}').ok, true);
    assert.equal(validate.validateFileContent('a.css', '.x{color:red').ok, false);
    assert.equal(validate.validateFileContent('a.txt', 'anything').ok, true);
    assert.equal(validate.validateFileContent('a.txt', '   ').ok, false);
  });

  it('computePreviewUrl prefers index.html then any html then md', () => {
    assert.equal(validate.computePreviewUrl('s', [{ path: 'style.css' }, { path: 'index.html' }]), '/vault/builds/projects/s/index.html');
    assert.equal(validate.computePreviewUrl('s', [{ path: 'page.html' }]), '/vault/builds/projects/s/page.html');
    assert.equal(validate.computePreviewUrl('s', [{ path: 'readme.md' }]), '/vault/builds/projects/s/readme.md');
    assert.equal(validate.computePreviewUrl('s', [{ path: 'a.js' }]), null);
  });
});
