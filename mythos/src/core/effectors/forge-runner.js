'use strict';

// effectors/forge-runner.js — drives the build-engine adapter as MYTHOS's build
// worker. The ONLY module that knows how to run a multi-file build; forge.js is
// its sole consumer for now.
//
// RENAMED from hermes-runner.js by W6 (2026-08-22). It was never "the Hermes
// runner" in any sense that survived the engine swap — it is FORGE's runner, and
// keeping "hermes" in the filename after deleting Hermes is exactly the
// contradiction this repo treats as a defect. The engine now arrives as an
// INJECTED dependency rather than a module-scope require, so the runner names a
// role instead of a vendor and a test can drive it without the real CLI.
//
// Three verbs:
//   runPlan()  — plan mode: propose a file plan, write nothing (sandboxed to
//                a throwaway scratch dir — belt-and-braces on top of the
//                "don't write" instruction, since the instruction alone is
//                not a guarantee against a disobedient run).
//   runBuild() — auto mode: actually build, cwd + write-root pinned to the
//                project dir. Polls the directory (readdir, never fs.watch —
//                Invariant 5) so the caller can stream forge.update progress
//                without this module knowing about the bus.
//   classify() — the blocker taxonomy. The engine exiting 0 is NOT success: it
//                can exit clean having written nothing, or only part of the
//                plan. Never throws for a build failure — returns a
//                classified {ok:false, reason, ...} instead (Invariant 9,
//                fail honestly, applies at this layer too: a classified
//                failure is not the same as silently fabricating success).

const path = require('path');
const prompts = require('./forge-prompts');       // Invariant 7 — reuse extractJsonObject/sanitizeManifestFiles
const validate = require('./forge-validate');
const buildPack = require('../skills/build-pack');
const widgetSpec = require('./widget-spec');       // Phase C3 — validated WIDGET SPEC build target

const PLAN_SCHEMA_HINT =
  '{"name":"short project name","kind":"app"|"website",' +
  '"files":[{"path":"relative/forward-slash/path","purpose":"what it does"}],' +
  '"techNotes":"shared conventions every file must follow"}';

function createForgeRunner({ config, vault, engine }) {
  if (!vault || typeof vault.vaultPath !== 'function' || typeof vault.ensureDir !== 'function') {
    throw new Error('createForgeRunner requires a vault fs-store');
  }
  // Injected, not required at module scope (W6). build-engine.js already takes
  // its engine this way, so the two build paths now resolve the engine
  // identically instead of one hardcoding an adapter path.
  if (!engine || typeof engine.runTask !== 'function') {
    throw new Error('createForgeRunner requires the dsh-agent adapter (engine)');
  }

  function planTimeoutMs()  { return Number(config && config.DSH_PLAN_TIMEOUT_MS)  || 300000; }
  function buildTimeoutMs() { return Number(config && config.DSH_BUILD_TIMEOUT_MS) || 1800000; }
  function pollMs()         { return Number(config && config.DSH_POLL_MS)          || 2000; }
  function terminalEnv()    { return (config && config.DSH_BUILD_TERMINAL_ENV) || 'local'; }

  // ---- plan mode -----------------------------------------------------------
  async function runPlan(spec, kind) {
    const scratchRel = path.join('builds', '_plan-scratch');
    vault.ensureDir(vault.vaultPath(scratchRel));
    const scratchAbs = vault.vaultPath(scratchRel);

    // The approved file plan must see the builder's output constraints. Without
    // this, a website planner can require logo.png while the builder is told
    // logos must be inline SVG/CSS, making the approved plan contradictory.
    const packKind = kind === 'website' ? 'ui' : buildPack.classifyDeliverable(spec || '');
    let skillBlock = '';
    try { skillBlock = buildPack.packBlockFor(packKind); } catch (_) { /* same best-effort contract as runBuild */ }

    const prompt = [
      skillBlock,
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
      reply = await engine.runTask(prompt, {
        cwd: scratchAbs,
        timeoutMs: planTimeoutMs(),
        maxPromptChars: 24000,
        // NO autoApprove, which selects dsh's read-only sandbox. Planning must
        // write nothing, and under Hermes that was a sentence in the prompt plus
        // this throwaway scratch dir to contain the damage when it disobeyed.
        // The sandbox now refuses outright; the scratch dir stays as a second
        // line of defence rather than the only one.
      });
    } catch (err) {
      return { ok: false, reason: 'plan-failed', error: String((err && err.message) || err) };
    }

    // Invariant 7: the same extractor Forge already used for brain manifests.
    const obj = prompts.extractJsonObject(reply);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {
        ok: false, reason: 'plan-unparseable',
        error: 'the build engine did not return a JSON file plan',
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

  // ---- widget-spec mode (Phase C3 — generative UI) --------------------------
  // A THIRD build target, alongside plan/build: for a "build me a widget"
  // request the engine must reply with a validated WIDGET SPEC (see widget-spec.js)
  // instead of free HTML or a file tree. No files are written — same
  // throwaway-scratch-dir belt-and-braces as runPlan, since nothing here is
  // supposed to touch disk. Server-side validation is the real gate: a spec
  // naming an unknown kind or carrying props that fail validation is REJECTED
  // here and never reaches the bus/renderer, mirroring spawn_widget's own
  // "nothing above this line reaches the bus" contract in from-widgets.js.
  async function runWidgetBuild(spec) {
    const scratchRel = path.join('builds', '_widget-scratch');
    vault.ensureDir(vault.vaultPath(scratchRel));
    const scratchAbs = vault.vaultPath(scratchRel);

    const prompt = [
      'You are generating a dashboard widget for MYTHOS\'s HUD.',
      'Do NOT create, write, or modify any files. Do NOT produce HTML, CSS, or markup of any kind.',
      'Your entire reply is DATA that a fixed renderer turns into a widget — never markup.',
      widgetSpec.WIDGET_SPEC_SCHEMA_HINT,
      '',
      'WIDGET REQUEST: ' + String(spec || ''),
    ].join('\n');

    let reply;
    try {
      reply = await engine.runTask(prompt, {
        cwd: scratchAbs,
        timeoutMs: planTimeoutMs(),
        maxPromptChars: 24000,
        // Read-only, same reasoning as runPlan: a widget spec is DATA and nothing
        // here is supposed to touch disk.
      });
    } catch (err) {
      return { ok: false, reason: 'widget-build-failed', error: String((err && err.message) || err) };
    }

    // Invariant 7: the same extractor Forge already uses for brain manifests
    // and runPlan's file plan — one JSON-extraction path for the whole module.
    const obj = prompts.extractJsonObject(reply);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {
        ok: false, reason: 'widget-unparseable',
        error: 'the build engine did not return a JSON widget spec',
        reply: String(reply || '').slice(0, 1000),
      };
    }

    const validated = widgetSpec.validateWidgetSpec(obj);
    if (!validated.ok) {
      return { ok: false, reason: 'widget-invalid', error: validated.reason, reply: String(reply || '').slice(0, 1000) };
    }
    return { ok: true, spec: validated.spec };
  }

  // ---- auto mode -----------------------------------------------------------
  // One engine run that actually builds, cwd-pinned. onProgress(paths[])
  // fires on each poll tick with the files seen so far, so the caller can
  // emit forge.update without this module knowing about the bus.
  async function runBuild({ dirRel, manifest, spec, feedback, onProgress }) {
    if (!dirRel) throw new Error('runBuild requires dirRel');
    const dirAbs = vault.vaultPath(dirRel);
    vault.ensureDir(dirAbs);

    // A website manifest is a UI build by definition; everything else is
    // classified from the brief so multi-file Forge builds pick up the finer
    // app/research/security packs instead of collapsing to the code default.
    const brief = spec || (manifest && manifest.name) || '';
    const packKind = (manifest && manifest.kind === 'website') ? 'ui' : buildPack.classifyDeliverable(brief);
    let skillBlock = '';
    try { skillBlock = buildPack.packBlockFor(packKind); } catch (_) { /* best-effort */ }

    // Real design system, merged forward from 9352a85. That commit wired
    // ui-ux-pro-max's search.py into the old per-file generate pump, which this
    // module replaced — so the feature is ported here rather than lost. One
    // resolve per BUILD (not per file, as the pump did) is strictly better:
    // The engine writes the whole project in a single run, so one system keeps it
    // coherent by construction. resolveSkillTool returns null whenever the
    // skill, its script, or Python is absent, so this can never block a build.
    //
    // The same call now also covers the research route (agent-reach): a
    // research-shaped build gets community findings injected here, or nothing
    // at all when agent-reach isn't installed. resolveSkillToolFor takes the
    // kind explicitly because packKind above is manifest-derived, not
    // text-derived.
    let toolBlock = '';
    try {
      toolBlock = (await buildPack.resolveSkillToolFor(packKind, brief)) || '';
    } catch (_) { /* best-effort, same contract as packBlockFor above */ }

    const prompt = [
      skillBlock,
      toolBlock,
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
      reply = await engine.runTask(prompt, {
        cwd: dirAbs,
        timeoutMs: buildTimeoutMs(),
        maxPromptChars: 24000,
        // INTENT, not another program's environment variables. This used to pass
        // env: { HERMES_WRITE_SAFE_ROOT, HERMES_YOLO_MODE } — a generic caller
        // naming Hermes's own env names, which would have been a lie in the code
        // the moment Hermes was deleted. dsh expresses both ideas structurally:
        // the invoking directory IS the workspace root, and the permission preset
        // decides whether writing is possible at all. The adapter asserts
        // writeRoot === cwd rather than silently dropping a root it cannot honour.
        writeRoot: dirAbs,
        autoApprove: true,
        env: { TERMINAL_ENV: terminalEnv() },
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
        // RENAMED with the engine (W6). 'hermes-error' named a program, not a
        // condition; callers switch on this string, so it is renamed here and at
        // every consumer in the same commit rather than aliased.
        ok: false, reason: /timed out/i.test(error) ? 'timeout' : 'engine-error',
        error, files: after, added,
      };
    }
    if (!after.length) {
      return {
        ok: false, reason: 'no-output',
        error: 'the build engine finished without writing any files', reply, files: [], added: [],
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

  return { runPlan, runBuild, runWidgetBuild, _classify: classify };
}

module.exports = { createForgeRunner, PLAN_SCHEMA_HINT };
