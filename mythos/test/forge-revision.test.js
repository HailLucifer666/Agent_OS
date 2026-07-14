'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createForge } = require('../src/core/effectors/forge');

const VALID_HTML = '<!DOCTYPE html><html><head><title>T</title></head><body><h1 id="title">T</h1></body></html>';
const VALID_JS = 'const app = { v: 1 };\n';

function fakeCheckpoints() {
  const created = [];
  return {
    create(o) { const r = Object.assign({ id: 'cp-' + (created.length + 1) }, o); created.push(r); return { id: r.id, kind: r.kind, projectId: r.projectId }; },
    _created: created,
    async _approve(idx) { const r = created[idx != null ? idx : created.length - 1]; return r && r.onApprove ? r.onApprove(r) : null; },
  };
}

function waitFor(cond, ms) {
  ms = ms || 2000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function loop() { let v = false; try { v = cond(); } catch (_) {} if (v) return resolve(v); if (Date.now() - start > ms) return reject(new Error('timeout')); setTimeout(loop, 5); })();
  });
}

const MANIFEST = { name: 'App', kind: 'app', techNotes: '', files: [{ path: 'index.html', purpose: 'shell' }, { path: 'app.js', purpose: 'logic' }] };

function brainWith(revisionResp) {
  return {
    fileCalls: [],
    think: async function ({ source }) {
      await Promise.resolve();
      if (/:manifest/.test(source)) return { content: JSON.stringify(MANIFEST), parsed: MANIFEST, offline: false };
      if (/:revision/.test(source)) return revisionResp;
      if (/:file:/.test(source)) { const p = source.split(':file:')[1]; this.fileCalls.push(p); return { content: /\.html$/.test(p) ? VALID_HTML : VALID_JS, parsed: null, offline: false }; }
      return { content: '', parsed: null, offline: false };
    },
  };
}

describe('forge — revision loop', () => {
  let dir, bus, fs, cps;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); cps = fakeCheckpoints(); });
  afterEach(() => cleanupVaultDir(dir));

  function make(brain) {
    return createForge({ config: { FORGE_MAX_FILES: 12, FORGE_FILE_RETRY: 1, FORGE_CONCURRENCY: 2 }, brain, bus, vault: fs, checkpoints: cps });
  }

  async function toFinalReview(forge, id) {
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._approve(0);
    await waitFor(() => forge.getProject(id).status === 'awaiting-final-review');
  }

  it('regenerates only the targeted file', async () => {
    const brain = brainWith({ content: '{"files":["app.js"],"notes":"tweak"}', parsed: { files: ['app.js'], notes: 'tweak' }, offline: false });
    const forge = make(brain);
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);
    brain.fileCalls.length = 0; // reset — count only revision regen
    await forge.applyRevision(id, 'make the button bigger');
    assert.deepEqual(brain.fileCalls, ['app.js']);
    assert.equal(forge.getProject(id).status, 'awaiting-final-review');
  });

  it('unparseable revision targets → honest return to awaiting-final-review', async () => {
    const brain = brainWith({ content: 'no idea', parsed: null, offline: false });
    const forge = make(brain);
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);
    const res = await forge.applyRevision(id, 'change something');
    assert.equal(res.ok, false);
    assert.equal(forge.getProject(id).status, 'awaiting-final-review');
    assert.match(forge.getProject(id).error, /revise/);
  });

  it('a new path in the revision targets is appended and generated', async () => {
    const brain = brainWith({ content: '{"files":["extra.js"]}', parsed: { files: ['extra.js'] }, offline: false });
    const forge = make(brain);
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);
    await forge.applyRevision(id, 'add a helper module');
    const paths = forge.getProject(id).files.map((f) => f.path);
    assert.ok(paths.includes('extra.js'));
    assert.ok(fs.exists('builds/projects/app/extra.js'));
  });
});
