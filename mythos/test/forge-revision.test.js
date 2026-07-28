'use strict';

// Phase 3 of the Hermes orchestration change: applyRevision no longer asks a
// brain to pick a revision-target subset — it re-runs the SAME hermes-runner
// build in the same project directory with `feedback` set, and Hermes reads
// back whatever it wrote before. This file covers that plumbing; the actual
// Hermes-driving logic lives in hermes-runner.js (tested separately).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createForge } = require('../src/core/effectors/forge');

const MANIFEST = { name: 'App', kind: 'app', techNotes: '', files: [{ path: 'index.html', purpose: 'shell' }, { path: 'app.js', purpose: 'logic' }] };

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

// Fake runner: first runBuild (initial build) writes the full manifest;
// subsequent runBuild calls (revisions) are recorded so the test can assert
// feedback was threaded through, and can simulate Hermes touching only the
// file that actually needs to change.
function fakeRunner(vault, onRevisionBuild) {
  const buildCalls = [];
  return {
    _buildCalls: buildCalls,
    async runPlan() { return { ok: true, manifest: MANIFEST }; },
    async runBuild(args) {
      buildCalls.push(args);
      if (args.feedback && typeof onRevisionBuild === 'function') return onRevisionBuild(args);
      for (const f of MANIFEST.files) vault.writeText(args.dirRel + '/' + f.path, 'v1\n');
      return { ok: true, files: MANIFEST.files.map((f) => f.path), added: [] };
    },
  };
}

describe('forge — revision loop (Hermes-driven)', () => {
  let dir, bus, fs, cps;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); cps = fakeCheckpoints(); });
  afterEach(() => cleanupVaultDir(dir));

  async function toFinalReview(forge, id) {
    await waitFor(() => forge.getProject(id).status === 'awaiting-plan-approval');
    await cps._approve(0);
    await waitFor(() => forge.getProject(id).status === 'awaiting-final-review');
  }

  it('applyRevision re-runs runBuild in the same dir with feedback set', async () => {
    const runner = fakeRunner(fs, (args) => {
      fs.writeText(args.dirRel + '/app.js', 'v2 — bigger button\n');
      return { ok: true, files: ['index.html', 'app.js'], added: [] };
    });
    const forge = createForge({ config: {}, runner, bus, vault: fs, checkpoints: cps });
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);

    const res = await forge.applyRevision(id, 'make the button bigger');
    assert.equal(res.ok, true);
    assert.equal(forge.getProject(id).status, 'awaiting-final-review');

    const revisionCall = runner._buildCalls[runner._buildCalls.length - 1];
    assert.equal(revisionCall.feedback, 'make the button bigger');
    assert.equal(revisionCall.dirRel, 'builds/projects/app'); // same directory as the initial build
    assert.equal(fs.readText('builds/projects/app/app.js'), 'v2 — bigger button\n');
  });

  it('applyRevision with no prior manifest → honest refusal, not a throw', async () => {
    const runner = fakeRunner(fs);
    const forge = createForge({ config: {}, runner, bus, vault: fs, checkpoints: cps });
    const res = await forge.applyRevision('nonexistent-id', 'change something');
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/);
  });

  it("a revision build that classifies as 'partial' routes to a mid-build decision, same as an initial build", async () => {
    const runner = fakeRunner(fs, (args) => {
      fs.writeText(args.dirRel + '/index.html', '<html></html>');
      return { ok: false, reason: 'partial', missing: ['app.js'], error: 'planned files not produced: app.js', files: ['index.html'], added: [] };
    });
    const forge = createForge({ config: {}, runner, bus, vault: fs, checkpoints: cps });
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);
    await forge.applyRevision(id, 'add validation');
    assert.equal(forge.getProject(id).status, 'awaiting-mid-build-decision');
  });

  it('a new file the revision adds is reflected in the project file list', async () => {
    const runner = fakeRunner(fs, (args) => {
      fs.writeText(args.dirRel + '/index.html', 'v1\n');
      fs.writeText(args.dirRel + '/app.js', 'v1\n');
      fs.writeText(args.dirRel + '/extra.js', 'a new helper\n');
      return { ok: true, files: ['index.html', 'app.js', 'extra.js'], added: ['extra.js'] };
    });
    const forge = createForge({ config: {}, runner, bus, vault: fs, checkpoints: cps });
    const { id } = forge.createProject('an app', 'app');
    await toFinalReview(forge, id);
    await forge.applyRevision(id, 'add a helper module');
    const paths = forge.getProject(id).files.map((f) => f.path);
    assert.ok(paths.includes('extra.js'));
    assert.ok(fs.exists('builds/projects/app/extra.js'));
  });
});
