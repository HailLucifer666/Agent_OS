'use strict';

// effectors/forge.js — multi-file agentic build pipeline (P22). Phase 3 of the
// Hermes orchestration change: Forge now drives the Hermes-Agent CLI (via
// hermes-runner.js) instead of calling brain.think({lane:'build'}) per file.
// Checkpoints (P21 sibling module, connectionId:'system' so a voice-started
// build stays HUD-approvable) gate the plan and the final review. Pending
// checkpoints hold live closures and cannot survive a restart — init() re-arms
// them from persisted state (honest-inert). State machine:
//   planning → awaiting-plan-approval →(approve) generating →(all done)
//   awaiting-final-review →(approve) done. Partial build → awaiting-mid-
//   build-decision; final-review reject → applyRevision(feedback). Crash
//   mid-flight → interrupted.

const crypto = require('crypto');
const validate = require('./forge-validate');

const FILE = 'Checkpoints/forge-projects.json';
const MAX_PERSISTED = 100;

function createForge({ config, runner, bus, vault, checkpoints }) {
  if (!runner || typeof runner.runPlan !== 'function' || typeof runner.runBuild !== 'function') {
    throw new Error('createForge requires a hermes runner');
  }
  if (!vault || typeof vault.writeText !== 'function' || typeof vault.readJSON !== 'function') {
    throw new Error('createForge requires a vault fs-store');
  }
  if (!bus) throw new Error('createForge requires bus');
  if (!checkpoints || typeof checkpoints.create !== 'function') throw new Error('createForge requires checkpoints');

  const projects = new Map();
  // Latched by init() when the persisted state could not be READ. See init().
  let persistSuspended = false;

  // ---- persistence + views ----
  function persist() {
    // Refuse to write over state we failed to read: persist() serializes only
    // the projects held in memory, so a single write after a failed load would
    // replace the whole file with just the projects created since — destroying
    // all build history. Stays latched for the process lifetime; a restart
    // retries the read.
    if (persistSuspended) return;
    try { vault.writeJSON(FILE, Array.from(projects.values()).slice(-MAX_PERSISTED)); }
    catch (err) { bus.emit('health.anomaly', { kind: 'forge-persist-failed', error: err.message }); }
  }

  function publicView(p) {
    return {
      id: p.id, name: p.name, kind: p.kind, spec: p.spec, status: p.status,
      slug: p.slug, previewUrl: p.previewUrl, error: p.error || null,
      goalId: p.goalId, feedback: p.feedback || null,
      files: p.files.map(function (f) {
        return { path: f.path, purpose: f.purpose, status: f.status, attempts: f.attempts, error: f.error || null };
      }),
      filesDone: countDone(p), filesTotal: p.files.length,
      createdAt: p.createdAt, finishedAt: p.finishedAt,
    };
  }

  function countDone(p) { return p.files.filter(function (f) { return f.status === 'done'; }).length; }

  // Bus 'forge.update' maps internal `status` → emitted `stage`.
  function notify(p, currentFile) {
    bus.emit('forge.update', {
      projectId: p.id, name: p.name, stage: p.status,
      filesDone: countDone(p), filesTotal: p.files.length,
      currentFile: currentFile || null, error: p.error || null, previewUrl: p.previewUrl || null,
    });
    persist();
  }

  function slugTaken(slug) {
    for (const other of projects.values()) { if (other.slug === slug) return true; }
    return vault.exists(validate.PROJECTS_REL + '/' + slug);
  }

  function applyManifest(p, manifest) {
    p.manifest = manifest;
    p.name = manifest.name || p.name;
    p.kind = manifest.kind || p.kind;
    p.files = manifest.files;
    if (!p.slug) p.slug = validate.uniqueSlug(validate.slugify(p.name), slugTaken);
    p.previewUrl = validate.computePreviewUrl(p.slug, p.files);
  }

  function projectDirRel(p) { return validate.PROJECTS_REL + '/' + p.slug; }

  function planBody(p) {
    const lines = p.files.map(function (f) { return '- ' + f.path + (f.purpose ? ': ' + f.purpose : ''); });
    return 'Plan for ' + p.name + ' (' + p.kind + '), ' + p.files.length + ' files:\n' + lines.join('\n');
  }

  // ---- checkpoint arming ----
  function armPlanCheckpoint(p) {
    const view = checkpoints.create({
      kind: 'plan-approval', title: 'Build plan for "' + p.name + '"', body: planBody(p),
      goalId: p.goalId, projectId: p.id, connectionId: 'system',
      onApprove: function () { return runBuildStage(p); },
      onReject: function () { p.status = 'plan-rejected'; p.finishedAt = Date.now(); notify(p); },
    });
    p.checkpointId = view.id;
  }

  function armFinalCheckpoint(p) {
    const view = checkpoints.create({
      kind: 'final-review', title: 'Review the finished "' + p.name + '"', body: p.previewUrl || '',
      goalId: p.goalId, projectId: p.id, connectionId: 'system',
      onApprove: function () { p.status = 'done'; p.finishedAt = Date.now(); notify(p); },
      onReject: function (rec, feedback) { return applyRevision(p.id, feedback || (rec && rec.feedback)); },
    });
    p.checkpointId = view.id;
  }

  // A 'partial' build (some but not all planned files produced) still left
  // something reviewable — let the operator decide whether to keep it
  // (final-review, same as a clean build) or abandon it, rather than
  // silently discarding partial work.
  function armMidBuildCheckpoint(p) {
    const missing = p.files.filter(function (f) { return f.status !== 'done'; }).map(function (f) { return f.path; });
    const view = checkpoints.create({
      kind: 'mid-build', title: 'Build incomplete for "' + p.name + '"',
      body: (p.error || 'Some planned files were not produced') + (missing.length ? ('. Missing: ' + missing.join(', ')) : '') + '. Approve to keep what built, or reject to abandon.',
      goalId: p.goalId, projectId: p.id, connectionId: 'system',
      onApprove: function () { p.status = 'awaiting-final-review'; notify(p); armFinalCheckpoint(p); },
      onReject: function () { p.status = 'failed'; p.error = 'abandoned after partial build'; p.finishedAt = Date.now(); notify(p); },
    });
    p.checkpointId = view.id;
  }

  // ---- plan stage ----
  async function runPlanStage(p) {
    p.status = 'planning'; notify(p);
    const res = await runner.runPlan(p.spec, p.kind);
    if (!res.ok) {
      p.status = 'failed'; p.error = res.error || res.reason; p.finishedAt = Date.now();
      notify(p); return;
    }
    applyManifest(p, res.manifest);
    p.status = 'awaiting-plan-approval'; notify(p);
    armPlanCheckpoint(p);
  }

  // ---- build stage ----
  // Replaces the old per-file generate pump: ONE Hermes run does the whole
  // build (or revision); progress comes from directory polling inside
  // hermes-runner.js, not from per-file LLM calls.
  async function runBuildStage(p, feedback) {
    p.status = feedback ? 'revising' : 'generating'; notify(p);
    const dirRel = projectDirRel(p);

    const res = await runner.runBuild({
      dirRel: dirRel,
      manifest: p.manifest,
      spec: p.spec,
      feedback: feedback || null,
      onProgress: function (paths) {
        markFilesFromDisk(p, paths);
        notify(p, paths.length ? paths[paths.length - 1] : null);
      },
    });

    markFilesFromDisk(p, res.files || []);
    p.previewUrl = validate.computePreviewUrl(p.slug, p.files) || p.previewUrl;

    if (res.ok) {
      p.status = 'awaiting-final-review'; p.error = null; notify(p); armFinalCheckpoint(p);
      return;
    }
    // 'partial' still produced something reviewable → let the operator decide.
    // Everything else (timeout, hermes-error, no-output) is a hard failure —
    // Invariant 9: fail honestly, never fabricate success.
    if (res.reason === 'partial') {
      p.status = 'awaiting-mid-build-decision'; p.error = res.error; notify(p); armMidBuildCheckpoint(p);
      return;
    }
    p.status = 'failed'; p.error = res.error || res.reason; p.finishedAt = Date.now(); notify(p);
  }

  // p.files is now derived from disk rather than driven by a generator.
  // Planned-but-absent files stay 'pending' (an honest "not produced yet/at
  // all" signal); unplanned files Hermes chose to add are appended as 'done'
  // so the HUD reflects the real contents.
  function markFilesFromDisk(p, paths) {
    const seen = new Set(paths);
    p.files.forEach(function (f) { if (seen.has(f.path)) { f.status = 'done'; f.error = null; } });
    const known = new Set(p.files.map(function (f) { return f.path; }));
    paths.forEach(function (rel) {
      if (!known.has(rel)) p.files.push({ path: rel, purpose: '', status: 'done', attempts: 1, error: null, summary: null });
    });
  }

  // ---- revision ----
  async function applyRevision(id, feedback) {
    const p = projects.get(id);
    if (!p) return { ok: false, error: 'project not found' };
    if (!p.manifest) return { ok: false, error: 'nothing to revise yet' };
    p.feedback = String(feedback || '').slice(0, 2000);
    await runBuildStage(p, p.feedback);
    return { ok: true, status: p.status };
  }

  // ---- public API ----
  function createProject(spec, kind, opts) {
    opts = opts || {};
    const p = {
      id: 'forge-' + crypto.randomUUID(),
      spec: String(spec || ''), kind: kind === 'website' ? 'website' : 'app',
      name: 'project', slug: null, previewUrl: null, status: 'planning',
      files: [], manifest: null, error: null,
      goalId: opts.goalId != null ? opts.goalId : null, feedback: null,
      checkpointId: null, createdAt: Date.now(), finishedAt: null,
    };
    projects.set(p.id, p);
    persist();
    queueMicrotask(function () {
      runPlanStage(p).catch(function (err) {
        p.status = 'failed'; p.error = (err && err.message) || 'plan error'; p.finishedAt = Date.now(); notify(p);
      });
    });
    return { id: p.id, status: p.status };
  }

  // Resuming a crashed build re-runs the SAME stage: with no manifest, that
  // means replanning; with a manifest, runBuildStage re-runs against the
  // same project dir — Hermes reads back whatever partial output it left
  // behind rather than starting cold.
  function resumeProject(id) {
    const p = projects.get(id);
    if (!p) return { ok: false, error: 'project not found' };
    if (p.status !== 'interrupted') return { ok: false, error: 'project is not interrupted (status: ' + p.status + ')' };
    if (!p.manifest) {
      p.status = 'planning'; notify(p);
      queueMicrotask(function () { runPlanStage(p).catch(function () {}); });
      return { ok: true, status: 'planning' };
    }
    runBuildStage(p).catch(function (err) {
      p.status = 'failed'; p.error = (err && err.message) || 'resume error'; p.finishedAt = Date.now(); notify(p);
    });
    return { ok: true, status: 'generating' };
  }

  function lastProject() { let last = null; for (const p of projects.values()) last = p; return last; }
  function getProject(id) { const p = id ? projects.get(id) : lastProject(); return p ? publicView(p) : null; }
  function listProjects() { return Array.from(projects.values()).map(publicView); }

  function normalizeLoaded(p) {
    return Object.assign({ files: [], manifest: null, checkpointId: null, error: null, goalId: null, feedback: null }, p);
  }

  function init() {
    let saved;
    // SILENT DATA LOSS FIX: this used to be `catch (_) { saved = []; }`. fs-store's
    // readJSON already absorbs both legitimate empty cases itself (missing file →
    // fallback; unparseable JSON → 'json-corrupt' anomaly + fallback), so anything
    // that throws out of it is a real read failure — typically a transient Windows
    // EBUSY/EPERM lock. Treating that as "no projects yet" meant the next
    // persist() (the first createProject, or any notify()) rewrote the file with
    // only the new project and every past build vanished, unreported. Now: report
    // it, load nothing, and suspend persistence so nothing can truncate the file.
    try {
      // Strict: a corrupt projects file must reach the catch below and suspend
      // persistence, not load as zero projects that the next persist() commits.
      saved = vault.readJSONStrict(FILE, []);
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'forge-state-read-failed', path: FILE, error: err.message });
      persistSuspended = true;
      return { loaded: 0, degraded: true };
    }
    if (!Array.isArray(saved)) saved = [];
    for (let i = 0; i < saved.length; i += 1) { const p = normalizeLoaded(saved[i]); projects.set(p.id, p); }
    let changed = false;
    for (const p of projects.values()) {
      if (p.status === 'planning' || p.status === 'generating' || p.status === 'revising') {
        p.status = 'interrupted'; p.error = 'entity restarted mid-build'; p.finishedAt = p.finishedAt || Date.now(); changed = true;
      } else if (p.status === 'awaiting-mid-build-decision') {
        p.status = 'interrupted'; p.error = 'entity restarted awaiting a mid-build decision'; p.finishedAt = p.finishedAt || Date.now(); changed = true;
      } else if (p.status === 'awaiting-plan-approval') {
        armPlanCheckpoint(p); changed = true;
      } else if (p.status === 'awaiting-final-review') {
        armFinalCheckpoint(p); changed = true;
      }
    }
    if (changed) persist();
    return { loaded: projects.size };
  }

  return { init, createProject, getProject, listProjects, resumeProject, applyRevision };
}

module.exports = { createForge };
