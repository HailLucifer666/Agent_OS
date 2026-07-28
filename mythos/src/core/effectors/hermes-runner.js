'use strict';

// effectors/hermes-runner.js — drives the Hermes-Agent CLI as MYTHOS's build
// worker (Phase 2 of the Hermes orchestration change). The ONLY module that
// knows how to run Hermes; forge.js (multi-file builds) is its sole consumer
// for now. Three verbs:
//   runPlan()  — plan mode: propose a file plan, write nothing (sandboxed to
//                a throwaway scratch dir — belt-and-braces on top of the
//                "don't write" instruction, since the instruction alone is
//                not a guarantee against a disobedient run).
//   runBuild() — auto mode: actually build, cwd + write-root pinned to the
//                project dir. Polls the directory (readdir, never fs.watch —
//                Invariant 5) so the caller can stream forge.update progress
//                without this module knowing about the bus.
//   classify() — the blocker taxonomy. Hermes exiting 0 is NOT success: it
//                can exit clean having written nothing, or only part of the
//                plan. Never throws for a build failure — returns a
//                classified {ok:false, reason, ...} instead (Invariant 9,
//                fail honestly, applies at this layer too: a classified
//                failure is not the same as silently fabricating success).

const path = require('path');
const hermes = require('../../../adapters/hermes-agent');
const prompts = require('./forge-prompts');       // Invariant 7 — reuse extractJsonObject/sanitizeManifestFiles
const validate = require('./forge-validate');
const buildPack = require('../skills/build-pack');

const PLAN_SCHEMA_HINT =
  '{"name":"short project name","kind":"app"|"website",' +
  '"files":[{"path":"relative/forward-slash/path","purpose":"what it does"}],' +
  '"techNotes":"shared conventions every file must follow"}';

function createHermesRunner({ config, vault }) {
  if (!vault || typeof vault.vaultPath !== 'function' || typeof vault.ensureDir !== 'function') {
    throw new Error('createHermesRunner requires a vault fs-store');
  }

  function planTimeoutMs()  { return Number(config && config.HERMES_PLAN_TIMEOUT_MS)  || 300000; }
  function buildTimeoutMs() { return Number(config && config.HERMES_BUILD_TIMEOUT_MS) || 1800000; }
  function pollMs()         { return Number(config && config.HERMES_POLL_MS)          || 2000; }
  function terminalEnv()    { return (config && config.HERMES_BUILD_TERMINAL_ENV) || 'local'; }

  // ---- plan mode -----------------------------------------------------------
  async function runPlan(spec, kind) {
    const scratchRel = path.join('builds', '_plan-scratch');
    vault.ensureDir(vault.vaultPath(scratchRel));
    const scratchAbs = vault.vaultPath(scratchRel);

    const prompt = [
      'You are planning a build. Do NOT create, write, or modify any files — planning only.',
      kind === 'website'
        ? 'This is a WEBSITE. index.html MUST be the entry point and listed FIRST.'
        : 'This is an APP.',
      'Every path must be RELATIVE with forward slashes: no leading slash, no drive letter, no "..".',
      'Keep the plan minimal but complete — only the files a working deliverable needs.',
      'Reply with ONE JSON object and NOTHING else. Schema: ' + PLAN_SCHEMA_HINT,
      '',
      'BUILD REQUEST: ' + String(spec || ''),
    ].join('\n');

    let reply;
    try {
      reply = await hermes.runTask(prompt, {
        requireCli: true,
        cwd: scratchAbs,
        timeoutMs: planTimeoutMs(),
        maxPromptChars: 24000,
        env: { HERMES_WRITE_SAFE_ROOT: scratchAbs, HERMES_YOLO_MODE: '1' },
      });
    } catch (err) {
      return { ok: false, reason: 'plan-failed', error: String((err && err.message) || err) };
    }

    // Invariant 7: the same extractor Forge already used for brain manifests.
    const obj = prompts.extractJsonObject(reply);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {
        ok: false, reason: 'plan-unparseable',
        error: 'Hermes did not return a JSON file plan',
        reply: String(reply || '').slice(0, 1000),
      };
    }
    const files = prompts.sanitizeManifestFiles(obj.files, Number(config && config.FORGE_MAX_FILES) || 12);
    if (!files.length) return { ok: false, reason: 'plan-empty', error: 'file plan contained no usable paths' };

    return {
      ok: true,
      manifest: {
        name: (typeof obj.name === 'string' && obj.name.trim()) ? obj.name.trim().slice(0, 80) : 'project',
        kind: obj.kind === 'website' ? 'website' : (kind === 'website' ? 'website' : 'app'),
        files,
        techNotes: typeof obj.techNotes === 'string' ? obj.techNotes.slice(0, 600) : '',
      },
    };
  }

  // ---- auto mode -----------------------------------------------------------
  // One Hermes run that actually builds, cwd-pinned. onProgress(paths[])
  // fires on each poll tick with the files seen so far, so the caller can
  // emit forge.update without this module knowing about the bus.
  async function runBuild({ dirRel, manifest, spec, feedback, onProgress }) {
    if (!dirRel) throw new Error('runBuild requires dirRel');
    const dirAbs = vault.vaultPath(dirRel);
    vault.ensureDir(dirAbs);

    const packKind = (manifest && manifest.kind === 'website') ? 'ui' : 'code';
    let skillBlock = '';
    try { skillBlock = buildPack.packBlockFor(packKind); } catch (_) { /* best-effort */ }

    const prompt = [
      skillBlock,
      feedback
        ? 'You previously built this project in the current directory. Apply this change: ' + feedback
        : 'Build the project described below in the CURRENT DIRECTORY.',
      'You are already inside the project directory — create files here with relative paths.',
      'Do NOT write anything outside this directory.',
      manifest && manifest.kind === 'website' ? 'index.html MUST be the entry point.' : '',
      manifest && manifest.files && manifest.files.length
        ? 'Approved file plan:\n' + manifest.files.map((f) => '- ' + f.path + (f.purpose ? ' — ' + f.purpose : '')).join('\n')
        : '',
      manifest && manifest.techNotes ? 'Shared conventions: ' + manifest.techNotes : '',
      'Verify your own work before finishing. When done, reply with a one-paragraph summary.',
      '',
      spec ? 'ORIGINAL REQUEST: ' + spec : '',
    ].filter(Boolean).join('\n\n');

    const before = validate.walkProjectFiles(dirAbs);
    let timer = null;
    if (typeof onProgress === 'function') {
      timer = setInterval(() => {
        try { onProgress(validate.walkProjectFiles(dirAbs)); } catch (_) { /* never let polling kill a build */ }
      }, pollMs());
      if (timer.unref) timer.unref(); // must not hold the process open on its own
    }

    let reply = null, error = null;
    try {
      reply = await hermes.runTask(prompt, {
        requireCli: true,
        cwd: dirAbs,
        timeoutMs: buildTimeoutMs(),
        maxPromptChars: 24000,
        env: {
          HERMES_WRITE_SAFE_ROOT: dirAbs,
          HERMES_YOLO_MODE: '1',
          TERMINAL_ENV: terminalEnv(),
        },
      });
    } catch (err) {
      error = String((err && err.message) || err);
    } finally {
      if (timer) clearInterval(timer);
    }

    return classify({ dirAbs, before, manifest, reply, error });
  }

  // ---- blocker taxonomy ----------------------------------------------------
  // "Exit 0" is NOT success. Each case gets a distinct reason so the caller
  // can route it (hard fail vs. a mid-build decision the operator gets to
  // make) honestly instead of collapsing everything into one outcome.
  function classify({ dirAbs, before, manifest, reply, error }) {
    const after = validate.walkProjectFiles(dirAbs);
    const added = after.filter((p) => before.indexOf(p) === -1);

    if (error) {
      return {
        ok: false, reason: /timed out/i.test(error) ? 'timeout' : 'hermes-error',
        error, files: after, added,
      };
    }
    if (!after.length) {
      return {
        ok: false, reason: 'no-output',
        error: 'Hermes finished without writing any files', reply, files: [], added: [],
      };
    }
    const planned = (manifest && manifest.files || []).map((f) => f.path);
    const missing = planned.filter((p) => after.indexOf(p) === -1);
    if (missing.length) {
      return {
        ok: false, reason: 'partial', missing,
        error: 'planned files not produced: ' + missing.join(', '),
        reply, files: after, added,
      };
    }
    return { ok: true, files: after, added, reply };
  }

  return { runPlan, runBuild, _classify: classify };
}

module.exports = { createHermesRunner, PLAN_SCHEMA_HINT };
