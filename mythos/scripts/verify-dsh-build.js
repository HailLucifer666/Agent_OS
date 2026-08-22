#!/usr/bin/env node
'use strict';

// scripts/verify-dsh-build.js — W6 step 5's LIVE half.
//
// WHY A SCRIPT AND NOT A TEST. A green suite cannot tell you the engine ran.
// Proven on this repo 2026-08-04: a slice shipped with 16 passing tests, a walked
// installer artifact and 2598 green tests, and the app would not start at all.
// The unit tests for the swap all inject a fake engine — that is what makes them
// fast and deterministic, and it is exactly why they are blind to whether dsh
// boots, authenticates, obeys its sandbox, and produces an artifact.
//
// So this drives the REAL adapter through the REAL call sites:
//
//   1. build-engine.generate()  — the single-artifact path (pipeline cards,
//      kanban cards, engagement builds). Read-only sandbox: the artifact IS the
//      reply, and nothing may be written.
//   2. forge-runner.runPlan()   — the JSON file-manifest path. Read-only.
//   3. forge-runner.runBuild()  — the multi-file WRITE path, cwd-pinned.
//
// It costs a handful of real model calls on whatever BRAIN_TABLES.build ranks
// first. Everything lands in a temp vault that is removed at the end.
//
//   node mythos/scripts/verify-dsh-build.js
//   node mythos/scripts/verify-dsh-build.js --keep     leave the vault for inspection
//
// Exit 0 iff every stage passed. A stage that fails prints WHAT it expected and
// WHAT it got, because "verification failed" with no evidence is the shape this
// repo has been bitten by more than once.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MYTHOS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');

// Standalone scripts do not get main.js's env loading, and main.js reads only
// mythos/.env — never the repo-root .env.local where this machine's real keys are.
for (const rel of [path.join(MYTHOS_DIR, '.env'), path.join(REPO_ROOT, '.env.local')]) {
  try { process.loadEnvFile(rel); } catch { /* optional */ }
}

const KEEP = process.argv.includes('--keep');

const engine = require('../adapters/dsh-agent');
const { createBuildEngine } = require('../src/core/effectors/build-engine');
const { createForgeRunner } = require('../src/core/effectors/forge-runner');
const { createFsStore } = require('../src/core/memory/fs-store');

// A long-form temp root. A short (8.3) TEMP hands a spawned child a path that
// trips a libuv assertion, and the symptom is an unrelated-looking connection
// error — recorded on this repo.
function longTmp() {
  let base = os.tmpdir();
  try { base = fs.realpathSync.native(base); } catch { /* best effort */ }
  return base;
}

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + stage);
  if (detail) console.log('      ' + String(detail).replace(/\n/g, '\n      '));
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch { return 0; }
}

async function main() {
  const online = await engine.probe(true);
  const status = engine.getStatus();
  if (!online) {
    console.log('dsh is OFFLINE — nothing below can be verified.');
    console.log('  ' + status.hint);
    process.exitCode = 2;
    return;
  }
  let selected;
  try {
    selected = engine.selectModel(null);
  } catch (err) {
    console.log('the build lane has no reachable model: ' + err.message);
    process.exitCode = 2;
    return;
  }
  console.log('engine  dsh ' + status.version + ' (' + status.evidence + ')');
  console.log('model   ' + selected.laneProvider + '/' + selected.model
    + '  via pi-ai route "' + selected.route + '"');
  console.log('');

  const vaultRoot = fs.mkdtempSync(path.join(longTmp(), 'w6-verify-'));
  const vault = createFsStore(() => vaultRoot, { emit() {} });

  try {
    // -- 1. single-artifact path -------------------------------------------
    const anomalies = [];
    const bus = { emit: (t, p) => anomalies.push({ t, p }), subscribe: () => () => {} };
    const buildEngine = createBuildEngine({ engine, vault, bus });

    const t1 = Date.now();
    const gen = await buildEngine.generate({
      prompt: 'Build a single-file HTML page showing a large digital clock that updates every '
        + 'second. Include a @media query so it works on a phone.',
      source: 'w6-verify:artifact',
    });
    const ms1 = Date.now() - t1;

    if (gen.offline) {
      record('1 build-engine.generate — single artifact', false,
        'offline: ' + gen.error + ' [' + ms1 + 'ms]');
    } else {
      const body = String(gen.content || '');
      const problems = [];
      if (gen.engine !== 'dsh') problems.push('engine tag is ' + JSON.stringify(gen.engine) + ', expected "dsh"');
      if (body.length < 200) problems.push('artifact is only ' + body.length + ' bytes');
      if (!/<html|<!doctype/i.test(body)) problems.push('artifact does not look like HTML');
      // OUTPUT_CONTRACT forbids wrapping the whole reply in a fence, and
      // stripWholeReplyFence is supposed to remove one if the model adds it.
      if (/^\s*```/.test(body)) problems.push('artifact still starts with a markdown fence');
      record('1 build-engine.generate — single artifact',
        problems.length === 0,
        problems.length ? problems.join('; ') : body.length + ' bytes in ' + ms1 + 'ms, engine=' + gen.engine);

      // The scratch dir is cleaned up by generate(), so the oracle for
      // "wrote nothing" is that no engine-scratch tree survives with content.
      const scratchRoot = path.join(vaultRoot, 'builds', '.engine-scratch');
      record('1b read-only sandbox left nothing behind',
        countFiles(scratchRoot) === 0,
        countFiles(scratchRoot) + ' file(s) under builds/.engine-scratch');
    }
    if (anomalies.length) {
      console.log('      bus anomalies: ' + anomalies.map((a) => a.p && a.p.kind).join(', '));
    }

    // -- 2 + 3. Forge plan then build --------------------------------------
    const runner = createForgeRunner({ config: {}, vault, engine });

    const t2 = Date.now();
    const plan = await runner.runPlan('a tiny two-page static site about tide charts', 'website');
    const ms2 = Date.now() - t2;
    if (!plan.ok) {
      record('2 forge-runner.runPlan — JSON manifest', false,
        plan.reason + ': ' + (plan.error || '') + ' [' + ms2 + 'ms]');
    } else {
      const paths = plan.manifest.files.map((f) => f.path);
      const problems = [];
      if (!paths.length) problems.push('manifest has no files');
      if (plan.manifest.kind !== 'website') problems.push('kind is ' + plan.manifest.kind + ', expected website');
      if (paths[0] !== 'index.html') problems.push('index.html must be first for a website, got ' + paths[0]);
      record('2 forge-runner.runPlan — JSON manifest', problems.length === 0,
        problems.length ? problems.join('; ') : paths.join(', ') + ' in ' + ms2 + 'ms');
    }

    if (plan.ok) {
      const dirRel = path.join('builds', 'projects', 'w6-verify');
      vault.ensureDir(vault.vaultPath(dirRel));
      const progress = [];
      const t3 = Date.now();
      const built = await runner.runBuild({
        dirRel,
        manifest: plan.manifest,
        spec: 'a tiny two-page static site about tide charts',
        onProgress: (paths) => progress.push(paths.length),
      });
      const ms3 = Date.now() - t3;
      const problems = [];
      if (!built.ok) problems.push(built.reason + ': ' + (built.error || ''));
      if (built.ok && !built.files.includes('index.html')) problems.push('index.html was not written');
      record('3 forge-runner.runBuild — multi-file WRITE path', problems.length === 0,
        problems.length ? problems.join('; ') + ' [' + ms3 + 'ms]'
          : (built.files || []).join(', ') + ' in ' + ms3 + 'ms'
            + (progress.length ? ' (onProgress saw ' + progress.join('->') + ')' : ' (no progress ticks)'));

      // Confinement: nothing may appear beside the project directory.
      const projectsRoot = vault.vaultPath(path.join('builds', 'projects'));
      let strays = [];
      try {
        strays = fs.readdirSync(projectsRoot).filter((n) => n !== 'w6-verify');
      } catch { /* nothing there */ }
      record('3b writes stayed inside the project directory', strays.length === 0,
        strays.length ? 'strays: ' + strays.join(', ') : 'none beside builds/projects/w6-verify');
    }
  } finally {
    if (KEEP) {
      console.log('\nvault kept at ' + vaultRoot);
    } else {
      try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(results.length - failed.length + '/' + results.length + ' stages passed');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('verify-dsh-build failed: ' + String((err && err.stack) || err));
  process.exitCode = 1;
});
