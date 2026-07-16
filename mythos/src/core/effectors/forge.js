'use strict';

// effectors/forge.js — multi-file agentic build pipeline (P22). Does NOT route
// through build-runner (its job shape is one-prompt→one-artifact): Forge calls
// brain.think({lane:'build'}) directly with its own FORGE_CONCURRENCY pump.
// Checkpoints (P21 sibling module, connectionId:'system' so a voice-started
// build stays HUD-approvable) gate the plan and the final review. Pending
// checkpoints hold live closures and cannot survive a restart — init() re-arms
// them from persisted state (honest-inert). State machine:
//   planning → awaiting-plan-approval →(approve) generating →(all done)
//   awaiting-final-review →(approve) done. Failures → awaiting-mid-build-decision;
//   final-review reject → applyRevision(feedback). Crash mid-flight → interrupted.

const prompts = require('./forge-prompts');
const buildPack = require('../skills/build-pack');
const validate = require('./forge-validate');

const FILE = 'Checkpoints/forge-projects.json';
const MAX_PERSISTED = 100;

function createForge({ config, brain, bus, vault, checkpoints }) {
  if (!brain || typeof brain.think !== 'function') throw new Error('createForge requires brain.think');
  if (!vault || typeof vault.writeText !== 'function' || typeof vault.readJSON !== 'function') {
    throw new Error('createForge requires a vault fs-store');
  }
  if (!bus) throw new Error('createForge requires bus');
  if (!checkpoints || typeof checkpoints.create !== 'function') throw new Error('createForge requires checkpoints');

  const MAX_FILES = (config && config.FORGE_MAX_FILES) || 12;
  const FILE_RETRY = (config && config.FORGE_FILE_RETRY != null) ? config.FORGE_FILE_RETRY : 2;
  const CONCURRENCY = (config && config.FORGE_CONCURRENCY) || 2;

  const projects = new Map();

  // ---- persistence + views ----
  function persist() {
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

  function doneSummaries(p) {
    return p.files.filter(function (f) { return f.status === 'done' && f.summary; })
      .map(function (f) { return { path: f.path, summary: f.summary }; });
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

  function planBody(p) {
    const lines = p.files.map(function (f) { return '- ' + f.path + (f.purpose ? ': ' + f.purpose : ''); });
    return 'Plan for ' + p.name + ' (' + p.kind + '), ' + p.files.length + ' files:\n' + lines.join('\n');
  }

  // ---- checkpoint arming ----
  function armPlanCheckpoint(p) {
    const view = checkpoints.create({
      kind: 'plan-approval', title: 'Build plan for "' + p.name + '"', body: planBody(p),
      goalId: p.goalId, projectId: p.id, connectionId: 'system',
      onApprove: function () { return runGenerateStage(p, pendingFiles(p)); },
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

  function armMidBuildCheckpoint(p) {
    const failed = p.files.filter(function (f) { return f.status === 'failed'; }).map(function (f) { return f.path; });
    const view = checkpoints.create({
      kind: 'mid-build', title: 'Some files failed for "' + p.name + '"',
      body: 'Failed: ' + failed.join(', ') + '. Approve to keep what built, or reject to abandon.',
      goalId: p.goalId, projectId: p.id, connectionId: 'system',
      onApprove: function () { p.status = 'awaiting-final-review'; notify(p); armFinalCheckpoint(p); },
      onReject: function () { p.status = 'failed'; p.error = 'abandoned after partial build'; p.finishedAt = Date.now(); notify(p); },
    });
    p.checkpointId = view.id;
  }

  function pendingFiles(p) { return p.files.filter(function (f) { return f.status === 'pending'; }); }

  // ---- plan stage ----
  async function runPlanStage(p) {
    p.status = 'planning'; notify(p);
    let result = await think(prompts.buildManifestPrompt(p.spec, p.kind), prompts.MANIFEST_SCHEMA_HINT, 'manifest', p);
    let manifest = prompts.tryExtractManifest(result, { kind: p.kind, name: p.name }, MAX_FILES);
    if (!manifest) {
      const repair = await think(prompts.buildRepairPrompt(p.spec, p.kind, result && result.content), prompts.MANIFEST_SCHEMA_HINT, 'manifest-repair', p);
      manifest = prompts.tryExtractManifest(repair, { kind: p.kind, name: p.name }, MAX_FILES);
    }
    if (!manifest) {
      p.status = 'failed'; p.error = 'could not produce a valid file plan'; p.finishedAt = Date.now();
      notify(p); return;
    }
    applyManifest(p, manifest);
    p.status = 'awaiting-plan-approval'; notify(p);
    armPlanCheckpoint(p);
  }

  async function think(prompt, schemaHint, tag, p) {
    try {
      return await brain.think({ lane: 'build', schemaHint: schemaHint, messages: [{ role: 'user', content: prompt }], source: 'forge:' + p.id + ':' + tag });
    } catch (_) { return null; }
  }

  // ---- generate stage (own bounded concurrency pump) ----
  function runGenerateStage(p, subset) {
    p.status = 'generating'; notify(p);
    const queue = subset.slice();
    let active = 0;
    return new Promise(function (resolve) {
      function pump() {
        if (!queue.length && active === 0) { finishGenerateStage(p).then(resolve); return; }
        while (active < CONCURRENCY && queue.length) {
          const file = queue.shift();
          active += 1;
          generateOneFile(p, file).then(function () { active -= 1; pump(); });
        }
      }
      pump();
    });
  }

  async function generateOneFile(p, file) {
    file.status = 'generating'; file.error = null; notify(p, file.path);
    const attemptsAllowed = FILE_RETRY + 1;
    // Skill-pack essences (P3 Jarvis upgrade): anti-slop discipline prepended
    // to every file-generation prompt. Pack chosen from the file's own path +
    // the project kind (websites and .html/.css files get the UI pack; the
    // rest get the code pack). Best-effort — a missing essence injects nothing.
    let skillBlock = '';
    try {
      const packKind = (p.kind === 'website' || /\.(html|css)$/i.test(file.path)) ? 'ui' : 'code';
      skillBlock = buildPack.packBlockFor(packKind);
    } catch (_) { /* essence injection is best-effort */ }
    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      file.attempts = attempt;
      let prompt = attempt === 1
        ? prompts.buildFilePrompt(p.manifest, file, doneSummaries(p))
        : prompts.buildRetryPrompt(p.manifest, file, doneSummaries(p), file.error);
      if (skillBlock) prompt = skillBlock + '\n\n' + prompt;
      const result = await think(prompt, null, 'file:' + file.path, p);
      if (!result || result.offline) { file.error = 'brain offline'; continue; }
      if (result.aborted) { file.error = 'aborted'; continue; }
      const content = prompts.cleanRawOutput(result.content);
      const v = validate.validateFileContent(file.path, content);
      if (!v.ok) { file.error = v.error; continue; }
      try { validate.writeProjectFile(vault, p.slug, file.path, content); }
      catch (err) { file.error = (err && err.message) || 'write failed'; continue; }
      file.summary = validate.summarizeGeneratedFile(file.path, content);
      file.status = 'done'; file.error = null; notify(p, file.path);
      return;
    }
    file.status = 'failed'; notify(p, file.path);
  }

  async function finishGenerateStage(p) {
    const done = countDone(p);
    const failed = p.files.filter(function (f) { return f.status === 'failed'; }).length;
    if (done === 0) {
      p.status = 'failed'; p.error = 'all files failed to generate'; p.finishedAt = Date.now(); notify(p); return;
    }
    if (failed > 0) { p.status = 'awaiting-mid-build-decision'; notify(p); armMidBuildCheckpoint(p); return; }
    p.status = 'awaiting-final-review'; p.error = null; notify(p); armFinalCheckpoint(p);
  }

  // ---- revision ----
  async function applyRevision(id, feedback) {
    const p = projects.get(id);
    if (!p) return { ok: false, error: 'project not found' };
    if (!p.manifest) return { ok: false, error: 'nothing to revise yet' };
    p.feedback = String(feedback || '').slice(0, 2000);
    p.status = 'revising'; notify(p);
    const result = await think(prompts.buildRevisionPrompt(p.manifest, p.feedback), prompts.REVISION_SCHEMA_HINT, 'revision', p);
    const targets = prompts.tryExtractRevisionTargets(result);
    if (!targets) {
      p.status = 'awaiting-final-review'; p.error = 'could not determine which files to revise'; notify(p);
      armFinalCheckpoint(p);
      return { ok: false, error: 'revision targets unparseable' };
    }
    const subset = markRevisionTargets(p, targets);
    await runGenerateStage(p, subset);
    return { ok: true, status: p.status };
  }

  function markRevisionTargets(p, targets) {
    const subset = [];
    for (let i = 0; i < targets.files.length; i += 1) {
      const tp = targets.files[i];
      let file = p.files.find(function (f) { return f.path === tp; });
      if (!file) {
        file = { path: tp, purpose: '', status: 'pending', attempts: 0, error: null, summary: null };
        p.files.push(file);
      }
      file.status = 'pending'; file.attempts = 0; file.error = null; file.summary = null;
      file.purpose = (file.purpose || '') + ' [REVISION: ' + p.feedback + (targets.notes ? ' — ' + targets.notes : '') + ']';
      subset.push(file);
    }
    p.previewUrl = validate.computePreviewUrl(p.slug, p.files) || p.previewUrl;
    return subset;
  }

  // ---- public API ----
  function createProject(spec, kind, opts) {
    opts = opts || {};
    const p = {
      id: 'forge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
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

  function resumeProject(id) {
    const p = projects.get(id);
    if (!p) return { ok: false, error: 'project not found' };
    if (p.status !== 'interrupted') return { ok: false, error: 'project is not interrupted (status: ' + p.status + ')' };
    if (!p.manifest) {
      p.status = 'planning'; notify(p);
      queueMicrotask(function () { runPlanStage(p).catch(function () {}); });
      return { ok: true, status: 'planning' };
    }
    const subset = p.files.filter(function (f) { return f.status !== 'done'; });
    for (let i = 0; i < subset.length; i += 1) { subset[i].status = 'pending'; subset[i].attempts = 0; subset[i].error = null; }
    runGenerateStage(p, subset).catch(function () {});
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
    try { saved = vault.readJSON(FILE, []); } catch (_) { saved = []; }
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
