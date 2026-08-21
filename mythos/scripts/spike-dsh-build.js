'use strict';

// scripts/spike-dsh-build.js — W6 step 1.
//
// Answers ONE question with a number: does DeepSeek Harness (`dsh`) produce
// build artifacts at least as good as Hermes-Agent on MYTHOS's own prompts?
//
// STANDALONE BY CONSTRUCTION. It wires nothing, changes nothing, and is safe to
// delete. It does not touch src/main.js, build-engine.js, or any adapter. The
// plan (Plans/MYTHOS-IRIS-Synthesis-Plan.md, section W6) forbids writing adapter
// code before this script returns a measurement — W6-AD-2 — because this repo's
// record is that measured premises change shape on contact with evidence, and
// two of the last six items that were "obviously true" turned out to be wrong.
//
// A run that says "dsh is worse" is a SUCCESSFUL run. The point is the number,
// not a particular answer.
//
//   node mythos/scripts/spike-dsh-build.js --samples 3
//   node mythos/scripts/spike-dsh-build.js --samples 3 --engines dsh
//
// CREDENTIALS — a DeepSeek key is the DEFAULT path, not the only one.
// dsh's base bundle (which the headless profile rides on) ships
// @deepseek-ai/dsh-llm-pi-ai, a generic multi-provider adapter: a provider
// route is declared in a cordis.patch.yml layer with `apiKeyEnv` naming ANY
// environment variable, and a route pi-ai does not ship is declared outright
// with `api: openai-completions` + `baseURL`. So an OpenAI-compatible gateway
// is configuration, not a code change, and --dsh-patch below routes through
// one. Verified 2026-08-21 against packages/llm/llm-pi-ai/README.md and
// packages/bundle/base/package.json.
//
// Prefer the plain DEEPSEEK_API_KEY path when you can. Routing through a
// gateway measures dsh AND the gateway, and W6's question is about dsh.
//
// Not set on the authoring machine, so this script has NEVER BEEN RUN END TO
// END. Everything below is written against the contracts verified in W6.0 on
// 2026-08-21; the preflight exists so a wrong assumption surfaces as a named
// refusal rather than a silent bad score.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'w6-spike');

// Standalone scripts do not get main.js's env loading — main.js loads ONLY
// mythos/.env (src/main.js:118) and never the repo-root .env.local, which is
// where this machine's real provider keys live. Follow the convention the other
// verify-* scripts already use (process.loadEnvFile, no dotenv dependency).
// Without this the preflight refuses on a key that is sitting right there on
// disk, which reads as "unsupported" rather than "not loaded".
const ENV_FILES = [
  path.join(REPO_ROOT, '.env'),                  // mythos/.env — what the app reads
  path.join(REPO_ROOT, '..', '.env.local'),      // repo root — this machine's real keys
];
for (const rel of ENV_FILES) {
  try { process.loadEnvFile(rel); } catch { /* optional */ }
}

// ---------------------------------------------------------------------------
// The prompts. Deliberately the three shapes that have actually broken builds
// in this repo's history rather than three pleasant ones: an interactive
// artifact (the 2026-08-14 snake games auto-started and were sitting on a Game
// Over overlay before anyone looked), a dated/factual page (the fabricated
// "Week of November 20, 2023" landing page that started the single-engine rule),
// and a data-rendering page (the pieces drawn at 0.5% of canvas pixels).
const PROMPTS = [
  {
    id: 'interactive-snake',
    text: 'Build a single-file HTML snake game. Arrow keys to steer, score in the corner.',
  },
  {
    id: 'dated-landing',
    text: 'Build a single-file HTML landing page for a weekly AI news digest, '
      + 'covering the current week. Do not invent headlines you are not sure of.',
  },
  {
    id: 'data-dashboard',
    text: 'Build a single-file HTML page charting seven days of CPU temperature '
      + 'readings between 40 and 85 degrees on a canvas, with axis labels.',
  },
];

// ---------------------------------------------------------------------------
// Argument parsing. Deliberately strict: an unknown flag is a usage error, not
// a silently ignored token. A spike that quietly ran with samples=1 because
// `--sample` was mistyped would produce exactly the one-sample result this
// repo has already been burned by.
function parseArgs(argv) {
  const out = { samples: 3, engines: ['hermes', 'dsh'], timeoutMs: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--samples') { out.samples = Number(argv[++i]); continue; }
    if (a === '--engines') { out.engines = String(argv[++i] || '').split(',').filter(Boolean); continue; }
    if (a === '--timeout-ms') { out.timeoutMs = Number(argv[++i]); continue; }
    if (a === '--dsh-patch') { out.dshPatch = String(argv[++i] || ''); continue; }
    if (a === '--forge') { out.forge = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    throw new Error('unknown argument: ' + a + ' (see --help)');
  }
  if (!Number.isInteger(out.samples) || out.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  // ONE SAMPLE HIDES MODEL FLAKINESS. Recorded on this repo after a generated
  // artifact passed once and failed the next two times on the same prompt.
  if (out.samples < 3) {
    console.warn('WARNING: --samples ' + out.samples + ' is below 3. Generated output varies '
      + 'run to run; a single sample measures luck, not the engine.');
  }
  for (const e of out.engines) {
    if (e !== 'hermes' && e !== 'dsh') throw new Error('unknown engine: ' + e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AD-1: the output contract is READ FROM THE MODULE THAT OWNS IT, never
// retyped here. A copy would drift from build-engine.js silently, and the
// spike would then measure a prompt production never sends.
//
// createBuildEngine demands an adapter with runTask() and throws without one,
// so it gets a stub that is never called — the constant is on the returned
// object and reading it runs nothing.
function readOutputContract() {
  const { createBuildEngine } = require('../src/core/effectors/build-engine');
  const engine = createBuildEngine({ hermes: { runTask: function () { throw new Error('spike: stub adapter must never run'); } } });
  const contract = engine && engine.OUTPUT_CONTRACT;
  if (!contract || typeof contract !== 'string' || !contract.trim()) {
    throw new Error('spike: build-engine.js no longer exposes OUTPUT_CONTRACT — '
      + 'the spike cannot measure the prompt production actually sends. Fix this '
      + 'rather than pasting a copy of the contract into this file.');
  }
  return contract;
}

// ---------------------------------------------------------------------------
// The scoring oracle, and the reason this function is longer than it looks
// like it needs to be.
//
// createVerifier({ brain }) returns a DEGENERATE STUB when brain has no
// think(): `verify()` resolves { pass: true } for every input, unconditionally
// (src/core/design/verify.js:88-91). A spike that scored against that stub
// would print 100% PASS for both engines and prove nothing — the same failure
// this repo already recorded once, where a gate reported 0% on a metric it
// could not read. So the stub is detected and refused rather than used.
async function makeVerifier() {
  const { loadConfig } = require('../src/core/config');
  const { createBrain } = require('../src/core/brain');
  const { createVerifier } = require('../src/core/design/verify');

  const configResult = loadConfig({});
  const config = configResult && configResult.config;
  if (!config) throw new Error('spike: loadConfig() returned no config');

  const bus = { emit: function () {}, on: function () {} };
  const brain = createBrain({ config: config, bus: bus });
  if (!brain || typeof brain.think !== 'function') {
    throw new Error(
      'spike: no usable brain, so verify() would degrade to a stub that returns '
      + 'pass:true for EVERY input and the comparison would be meaningless. '
      + 'Set a brain provider key (see mythos/.env.example) before scoring.'
    );
  }
  return createVerifier({ brain: brain });
}

// ---------------------------------------------------------------------------
// A throwaway workspace per attempt.
//
// It lives under os.tmpdir() and contains NO AGENTS.md and NO CLAUDE.md. That
// is not tidiness — it is the whole reason W6-AD-3 exists. dsh treats its
// invoking directory as the workspace root, grants it workspace-write, and
// loads that directory's AGENTS.md or CLAUDE.md as agent instructions under a
// 65,536-byte budget. This repo's two files total 41,412 bytes and would both
// load IN FULL, so a build run from the repo root would inherit MYTHOS's own
// operating rules as its task instructions while holding write access here.
//
// Long-form tmpdir matters on Windows: a short (8.3) TEMP hands spawned
// children a path that trips a libuv assertion, and the symptom is an
// unrelated-looking connection error. Recorded on this repo.
function makeWorkspace(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-spike-'));
  const dir = path.join(base, tag.replace(/[^A-Za-z0-9._-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const forbidden of ['AGENTS.md', 'CLAUDE.md']) {
    if (fs.existsSync(path.join(dir, forbidden))) {
      throw new Error('spike: fresh workspace already contains ' + forbidden);
    }
  }
  return { dir: dir, base: base };
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Resolve the PROJECT-LOCAL dsh entry point, and refuse rather than reach for a
// global one.
//
// WHERE IT LIVES, and why not in mythos/node_modules. Measured 2026-08-21:
// `npm install --no-save @deepseek-ai/dsh` inside mythos/ made npm re-resolve
// mythos's entire 191-package tree alongside dsh's own 30+ @deepseek-ai/*
// packages. It burned 24 minutes of CPU and 2.8 GB of RSS and had not extracted
// a single file when it was killed. dsh therefore gets its OWN install root at
// the repo root, exactly the convention /Hermes Agent/ and
// /Android Platform Tools/ already follow — a third-party tree with its own
// package.json, gitignored, nothing to re-resolve:
//
//   cd "DeepSeek Harness" && npm install --save-exact @deepseek-ai/dsh@0.1.1-rc.2
//
// Kept as a second location: mythos/node_modules, so a contributor who installs
// it as an ordinary dependency is not told it is missing.
//
// The version is asserted, not assumed. A number measured against an unknown
// version of a package whose own README promises breaking changes cannot be
// attributed to anything later.
const DSH_PINNED_VERSION = '0.1.1-rc.2';

// Derived from __dirname, never a machine path (AD-7). REPO_ROOT is mythos/.
const DSH_INSTALL_ROOTS = [
  path.join(REPO_ROOT, '..', 'DeepSeek Harness', 'node_modules', '@deepseek-ai', 'dsh'),
  path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh'),
];

function resolveDshEntry() {
  const pkgDir = DSH_INSTALL_ROOTS.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!pkgDir) {
    throw new Error('dsh is not installed project-local. From the repo root, run:\n'
      + '  cd "DeepSeek Harness" && npm install --save-exact @deepseek-ai/dsh@' + DSH_PINNED_VERSION + '\n'
      + 'Looked in:\n'
      + DSH_INSTALL_ROOTS.map((d) => '  ' + d).join('\n') + '\n'
      + 'This spike deliberately does NOT fall back to `npx --yes`: that caches '
      + 'outside the project (root CLAUDE.md forbids it) and floats the version '
      + 'under measurement.');
  }
  const pkgJson = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  if (pkg.version !== DSH_PINNED_VERSION) {
    throw new Error('dsh version mismatch: installed ' + pkg.version + ', this spike '
      + 'is pinned to ' + DSH_PINNED_VERSION + '. dsh is a developer preview whose README '
      + 'says there WILL be compatibility-breaking changes, so a measurement taken '
      + 'against an unexpected version is not attributable. Reinstall the pin, or '
      + 'update DSH_PINNED_VERSION deliberately and say so in the progress log.');
  }
  // `bin` is either a string or a map; take the dsh entry from either shape
  // rather than guessing a file name.
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : (bin && (bin.dsh || bin[Object.keys(bin)[0]]));
  if (!rel) {
    throw new Error('dsh package.json declares no `bin` entry — the CLI contract moved. '
      + 'Read the installed package before assuming a file name.');
  }
  const entry = path.join(pkgDir, rel);
  if (!fs.existsSync(entry)) {
    throw new Error('dsh `bin` points at ' + rel + ', which does not exist inside the '
      + 'installed package. Reinstall rather than guessing another path.');
  }
  return entry;
}

// ---------------------------------------------------------------------------
// dsh, driven exactly as its own reference documents it.
//
// Verified 2026-08-21 against apps/cli/reference/README.md and
// packages/bundle/headless/README.md at deepseek-ai/deepseek-harness@master:
//   * `dsh --profile headless "<task>"` runs one fresh session and exits.
//   * stdout carries the last non-empty assistant text.
//   * exit 0 iff the final turn/end reason is `completed`, else 1.
//   * stderr is EMPTY on success; a terminal error writes its code + message.
//   * no listening port is opened.
// dsh is in developer preview and its README states there WILL be
// compatibility-breaking changes, so none of that is trusted — each property is
// asserted at the call site below.
function runDsh(prompt, opts) {
  return new Promise((resolve) => {
    // Launcher flags FIRST. The reference is explicit that the launcher's own
    // flags end at the first token it does not recognize, and that a first app
    // argument equal to `web` or `plugin` selects that subcommand — so the task
    // is passed as one positional argument and never as loose words.
    // CHANGED 2026-08-21 (was `npx --yes @deepseek-ai/dsh …`). Three reasons,
    // in order of weight:
    //   1. Root CLAUDE.md binds every install, package and cache to the opened
    //      project directory. `npx --yes` writes a package cache under the
    //      user profile, outside it.
    //   2. `--yes` floats on whatever the registry currently calls `latest`.
    //      Against an 8-day-old developer preview that says there WILL be
    //      breaking changes, the version under measurement must be pinned or
    //      the number this spike prints is not attributable to a version.
    //   3. It removes per-call npx resolution from the latency figure, which
    //      W6.0 lists as NOT VERIFIED precisely because npx confounded it.
    // The entry is spawned with process.execPath directly rather than through
    // the .bin shim: this repo's path contains a space, and a shell-quoted
    // .cmd shim is one more thing that can fail for a reason unrelated to dsh.
    let entry;
    try {
      entry = resolveDshEntry();
    } catch (err) {
      return resolve({ ok: false, ms: 0, error: String((err && err.message) || err) });
    }
    const args = [entry, '--profile', 'headless'];
    // A --patch overlay is a LAUNCHER flag, so it must come before the task or
    // it would be swallowed as part of the app's arguments.
    if (opts.dshPatch) args.push('--patch', opts.dshPatch);
    args.push(prompt);
    const started = Date.now();
    execFile(process.execPath, args, {
      cwd: opts.cwd,                       // AD-3: always explicit, never inherited
      timeout: opts.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: dshEnv(),
    }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      const out = String(stdout || '');
      const errText = String(stderr || '').trim();
      if (err) {
        // A TIMEOUT IS NOT AN EXIT CODE, and conflating the two would hide the
        // exact failure W6.11 risk 2 predicts: dsh's default preset is
        // workspace-write + ASK, and the headless runner has no interactive
        // follow-up surface, so a task that triggers an approval has nowhere to
        // answer and simply runs to the wall. execFile marks that with
        // killed:true, so it is reported as its own class rather than as
        // "dsh exit ?".
        const timedOut = Boolean(err.killed) || err.signal === 'SIGTERM';
        if (timedOut) {
          return resolve({ ok: false, ms: ms, timedOut: true,
            error: 'dsh produced no terminal turn within ' + opts.timeoutMs + 'ms and was killed'
              + ' (signal ' + String(err.signal) + '). This is the shape an unanswerable approval'
              + ' prompt takes in headless mode — see W6.11 risk 2. Partial stdout: '
              + (out.trim() ? JSON.stringify(out.trim().slice(0, 300)) : '(none)')
              + (errText ? ' | stderr: ' + errText.slice(0, 300) : ' | stderr empty') });
        }
        // The exit code IS the success oracle. Keep stderr verbatim — a wrong
        // classification that also swallows the diagnosis is worse than the
        // original failure.
        return resolve({ ok: false, ms: ms, error: 'dsh exit ' + (err.code == null ? '?' : err.code)
          + (errText ? ': ' + errText.slice(0, 600) : ' (stderr empty)') });
      }
      if (errText) {
        // Documented as empty on success. If it is not, the contract moved —
        // say so loudly rather than scoring an artifact produced under unknown
        // conditions.
        return resolve({ ok: false, ms: ms, error: 'dsh exited 0 but wrote to stderr, which its '
          + 'reference says is empty on success. The CLI contract may have changed: ' + errText.slice(0, 600) });
      }
      if (!out.trim()) {
        return resolve({ ok: false, ms: ms, error: 'dsh exited 0 with empty stdout' });
      }
      resolve({ ok: true, ms: ms, content: out });
    });
  });
}

// Telemetry is local by default, but the shipped base bundle has NO redaction
// rule, so an enabled export can carry message text, tool arguments and results,
// and workspace paths. Any non-empty DSH_TELEMETRY_DISABLED is documented as an
// authoritative hard opt-out, so it is set explicitly rather than assumed.
// DSH_HOME is pinned away from the operator's personal profiles so a spike can
// never mutate them.
function dshEnv() {
  const env = Object.assign({}, process.env);
  env.DSH_TELEMETRY_DISABLED = '1';
  delete env.DSH_TELEMETRY_MODE;
  delete env.DSH_TELEMETRY_OTLP_URL;
  env.DSH_HOME = path.join(os.tmpdir(), 'w6-spike-dsh-home');
  return env;
}

// Hermes, through the adapter production already uses — not a reimplementation,
// so the comparison is against what actually ships.
async function runHermes(prompt, opts) {
  const hermes = require('../adapters/hermes-agent');
  const started = Date.now();
  try {
    const reply = await hermes.runTask(prompt, {
      requireCli: true,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxPromptChars: 24000,
    });
    const ms = Date.now() - started;
    if (!reply || !String(reply).trim()) return { ok: false, ms: ms, error: 'Hermes returned an empty reply' };
    // Hermes reports provider failures on stdout WITH EXIT CODE 0 (BUG-058 /
    // BUG-245), which is why this regex exists in the adapter at all. Reuse it
    // rather than trusting the exit status.
    if (hermes.HERMES_ERROR_REPLY_RE.test(String(reply))) {
      return { ok: false, ms: ms, error: 'Hermes provider error (exit 0, error on stdout): ' + String(reply).trim().slice(0, 300) };
    }
    return { ok: true, ms: ms, content: String(reply) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------
async function attempt(engine, prompt, contract, verifier, opts) {
  const ws = makeWorkspace(engine + '-' + prompt.id);
  const before = countFiles(ws.dir);
  const full = contract + '\n\n' + prompt.text;
  try {
    const run = engine === 'dsh'
      ? await runDsh(full, { cwd: ws.dir, timeoutMs: opts.timeoutMs, dshPatch: opts.dshPatch })
      : await runHermes(full, { cwd: ws.dir, timeoutMs: opts.timeoutMs });

    // The no-write oracle. OUTPUT_CONTRACT says "Do NOT create, write or modify
    // any files. Your reply IS the deliverable." Both engines are agentic and
    // can disobey; measuring it is the point, not assuming it.
    const wrote = countFiles(ws.dir) - before;

    if (!run.ok) return { engine, prompt: prompt.id, ok: false, ms: run.ms, wrote, error: run.error };

    // FIXED 2026-08-21. This passed `{ title: prompt.id }`, an OBJECT, where
    // verify(raw, spec) wants the spec TEXT — `String(spec)` therefore produced
    // the literal '[object Object]', and the title-relevance rule compared every
    // artifact against it. Result: verifier-pass 0/9 for Hermes on artifacts
    // that were, on inspection, complete and working. Production calls
    // `verifier.verify(raw, job.spec || prompt)` (build-runner.js:228) — a
    // string — so the spike was measuring a call shape production never makes.
    // The fixture must be built from what the caller actually sends.
    const verdict = await verifier.verify(run.content, prompt.text);
    return {
      engine, prompt: prompt.id, ok: true, ms: run.ms, wrote,
      bytes: run.content.length,
      pass: Boolean(verdict && verdict.pass),
      issues: (verdict && verdict.issues) || [],
      warnings: (verdict && verdict.warnings) || [],
      content: run.content,
    };
  } finally {
    try { fs.rmSync(ws.base, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// THE FORGE VARIANT — added 2026-08-21, W6.8 step 1's second checkbox.
//
// Everything above measures the single-artifact path, where the reply IS the
// deliverable and writing files is a CONTRACT VIOLATION. Forge is the opposite
// job: `runBuild` (hermes-runner.js:216) hands the engine a directory and the
// oracle is files appearing on disk. Porting that path on the strength of a
// no-write measurement would be measuring the wrong thing, so this variant
// measures the write path on its own terms:
//
//   1. Does dsh write files at all when told to?  (the file-appearance oracle)
//   2. Does it STALL instead?                      (W6.11 risk 2 — approvals
//      have no answering surface in headless mode; the symptom is a kill at the
//      timeout, which runDsh now reports as its own class)
//   3. Does anything land OUTSIDE the workspace?   (the confinement question
//      `writeRoot` has to answer once HERMES_WRITE_SAFE_ROOT is deleted)
//
// dsh only. Hermes is not run here on purpose: the operator has already decided
// to remove it, so a Hermes column on this table would cost money and change
// no decision. What is still open is whether dsh can drive Forge AT ALL.
const FORGE_PROMPT = 'Create a small static web project in the current directory. '
  + 'Write exactly three files: index.html, styles.css and app.js. index.html must link '
  + 'both of the others. app.js must render the current time into an element in index.html. '
  + 'Write the files to disk — do not print them in your reply.';

// Confinement oracle. The workspace `base` from makeWorkspace() contains exactly
// one child, the tagged run directory. Anything else appearing beside it means
// dsh wrote above its workspace root, which is the failure `writeRoot` exists to
// prevent — and the reason a passing no-write test on the single-artifact path
// says nothing about this one.
function strayEntries(base, tagDirName) {
  return fs.readdirSync(base).filter((n) => n !== tagDirName);
}

async function forgeAttempt(opts) {
  const ws = makeWorkspace('dsh-forge');
  const tagDirName = path.basename(ws.dir);
  try {
    const run = await runDsh(FORGE_PROMPT, {
      cwd: ws.dir,
      timeoutMs: opts.timeoutMs,
      dshPatch: opts.dshPatch,
    });
    // Paths are recorded RELATIVE TO THE WORKSPACE, not as bare basenames.
    // Forge cares where a file landed, and two `index.html` in different
    // subdirectories are not the same result — a basename-only list would read
    // as a duplicate rather than as a directory structure.
    const files = [];
    for (const entry of fs.readdirSync(ws.dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        files.push(path.relative(ws.dir, path.join(entry.parentPath || entry.path || ws.dir, entry.name)).replace(/\\/g, '/'));
      }
    }
    return {
      ok: run.ok,
      timedOut: Boolean(run.timedOut),
      ms: run.ms,
      files: files.sort(),
      wrote: files.length,
      strays: strayEntries(ws.base, tagDirName),
      error: run.error || null,
      content: run.ok ? run.content : null,
    };
  } finally {
    try { fs.rmSync(ws.base, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

function reportForge(records) {
  console.log('\n=== W6 step 1 — Forge variant (dsh only, write path) ===');
  console.log('sample  exit      files-written  strays  ms      names');
  records.forEach((r, i) => {
    const state = r.timedOut ? 'STALLED' : (r.ok ? 'ok' : 'failed');
    console.log([
      String(i + 1).padEnd(8),
      state.padEnd(10),
      String(r.wrote).padEnd(15),
      String(r.strays.length).padEnd(8),
      String(r.ms).padEnd(8),
      r.files.join(',') || '(none)',
    ].join(''));
  });

  const stalled = records.filter((r) => r.timedOut).length;
  const wroteNothing = records.filter((r) => r.ok && r.wrote === 0).length;
  const escaped = records.filter((r) => r.strays.length > 0);

  // A CONCLUSION NEEDS A RUN THAT GOT PAST BOOT. Added 2026-08-21 after this
  // function printed "W6.11 risk 2 did NOT reproduce" and "Confinement held"
  // across three runs that had died in dsh's overlay loader 380ms in, before the
  // agent existed. Both lines were true statements about nothing, and both read
  // as evidence. A run reached the agent iff it produced a terminal turn (ok) or
  // was killed at the wall (timedOut); a fast non-zero exit is a boot failure.
  const reachedAgent = records.filter((r) => r.ok || r.timedOut).length;
  console.log('');
  if (reachedAgent === 0) {
    console.log('UNMEASURED: 0 of ' + records.length + ' runs got past dsh boot, so this table says '
      + 'NOTHING about the write path. The approval-stall question (W6.11 risk 2), the '
      + 'file-appearance oracle and the confinement check are all unanswered — not passed. '
      + 'Read the verbatim failures below, fix the cause, and re-run before quoting any of this.');
    const failures0 = records.filter((r) => !r.ok);
    if (failures0.length) {
      console.log('\nForge failures, verbatim:');
      for (const f of failures0) console.log('  ' + f.error);
    }
    return;
  }
  console.log('Conclusions below rest on ' + reachedAgent + ' of ' + records.length
    + ' runs that got past boot.');
  if (stalled) {
    console.log('W6.11 RISK 2 IS REAL: ' + stalled + ' of ' + records.length + ' runs were killed at the '
      + 'timeout with no terminal turn. Read the verbatim failures below before choosing a '
      + 'DSH_PERMISSION_MODE — `danger-full-access` removes the sandbox and is not the casual answer.');
  } else {
    console.log('W6.11 risk 2 did NOT reproduce in ' + records.length + ' runs: no run stalled. That is '
      + 'evidence about THIS prompt under THIS profile, not a general guarantee — a build that '
      + 'touches something outside the workspace can still hit an approval with nowhere to answer.');
  }
  if (wroteNothing) {
    console.log('WARNING: ' + wroteNothing + ' run(s) exited 0 while writing NOTHING. Forge would '
      + 'report a successful build with an empty project tree — exactly the exit-0-but-failed '
      + 'class W6.8 step 3 asks the spike to settle.');
  }
  if (escaped.length) {
    console.log('CONFINEMENT BREACH: ' + escaped.length + ' run(s) created entries beside the workspace '
      + 'root, not inside it:');
    for (const r of escaped) console.log('  ' + r.strays.join(', '));
  } else {
    console.log('Confinement held: nothing appeared beside the workspace root in any run.');
  }

  const failures = records.filter((r) => !r.ok);
  if (failures.length) {
    console.log('\nForge failures, verbatim:');
    for (const f of failures) console.log('  ' + f.error);
  }
}

function writeFixture(rec, sampleIndex) {
  if (!rec.ok || !rec.content) return;
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  // Committed raw, not summarized. A number in prose rots; a committed artifact
  // can be re-scored by whoever disagrees with this run's verdict.
  const name = rec.engine + '--' + rec.prompt + '--' + String(sampleIndex).padStart(2, '0') + '.txt';
  fs.writeFileSync(path.join(FIXTURE_DIR, name), rec.content);
}

function report(records, opts) {
  const rows = [];
  for (const engine of opts.engines) {
    const mine = records.filter((r) => r.engine === engine);
    if (!mine.length) continue;
    const ran = mine.filter((r) => r.ok);
    const passed = ran.filter((r) => r.pass);
    const wrote = mine.filter((r) => r.wrote > 0);
    const times = ran.map((r) => r.ms).sort((a, b) => a - b);
    rows.push({
      engine,
      attempts: mine.length,
      produced: ran.length,
      verified: passed.length,
      // Only runs that PRODUCED something can be said to have obeyed the
      // no-write contract. Added 2026-08-21: this column printed 9/9 for an
      // engine whose every attempt died in its own boot loader, which reads as
      // perfect compliance and is really "it never got the chance to disobey".
      obeyedNoWrite: ran.length ? (ran.length - ran.filter((r) => r.wrote > 0).length) : null,
      medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    });
  }

  console.log('\n=== W6 step 1 — spike result ===');
  console.log('engine  attempts  produced  verifier-pass  obeyed-no-write  median-ms');
  for (const r of rows) {
    console.log([
      r.engine.padEnd(7),
      String(r.attempts).padEnd(9),
      String(r.produced).padEnd(9),
      String(r.verified).padEnd(14),
      (r.obeyedNoWrite == null ? 'n/a (0 produced)' : String(r.obeyedNoWrite)).padEnd(16),
      r.medianMs == null ? 'n/a' : String(r.medianMs),
    ].join(''));
  }

  // WHY a run failed the verifier, not just how many did. Added 2026-08-21:
  // this table printed `verifier-pass 0` for an engine whose artifacts were
  // complete and working, and the reason — a spec argument of the wrong TYPE —
  // was invisible because only the boolean was reported. A bare 0 is
  // uninterpretable and invites the wrong conclusion about the engine.
  const rejected = records.filter((r) => r.ok && !r.pass);
  if (rejected.length) {
    console.log('\nVerifier rejections, with the rule that fired (check these are about the '
      + 'ARTIFACT and not about how this spike called verify()):');
    const tally = new Map();
    for (const r of rejected) {
      for (const issue of r.issues) tally.set(issue, (tally.get(issue) || 0) + 1);
      console.log('  ' + r.engine + ' / ' + r.prompt + ': ' + (r.issues.join(' | ') || '(no issues listed)'));
    }
    console.log('\n  Rule frequency across ' + rejected.length + ' rejections:');
    for (const [issue, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('    ' + String(n).padStart(3) + '  ' + issue);
    }
  }

  const failures = records.filter((r) => !r.ok);
  if (failures.length) {
    console.log('\nFailures, verbatim (the diagnosis is the point — do not summarize these away):');
    for (const f of failures) console.log('  ' + f.engine + ' / ' + f.prompt + ': ' + f.error);
  }

  const wrote = records.filter((r) => r.wrote > 0);
  if (wrote.length) {
    console.log('\nCONTRACT VIOLATIONS — these runs wrote files despite being told not to:');
    for (const w of wrote) console.log('  ' + w.engine + ' / ' + w.prompt + ': ' + w.wrote + ' file(s)');
  }

  console.log('\nRaw replies written to test/fixtures/w6-spike/ — commit them.');
  console.log('Record this table in the W6 progress log with today\'s date and the commit SHA.');
  // CORRECTED 2026-08-21: this line used to point at W6.1's "cheap rollback"
  // (repoint Hermes at DeepSeek and keep the harness). The operator's
  // full-removal instruction of the same date WITHDREW that option — once Hermes
  // is deleted the only rollback is a git revert (W6.11 risk 1). Leaving the old
  // sentence would have offered a way out that no longer exists.
  console.log('A result of "dsh is worse" is still a real result and closes W6 honestly.');
  console.log('Note: repointing Hermes is NO LONGER the rollback — full removal was ordered');
  console.log('2026-08-21, so after step 6 the only way back is a revert (W6.11 risk 1).\n');
}

// ---------------------------------------------------------------------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  if (opts.help) {
    console.log('spike-dsh-build.js — W6 step 1. Measures dsh against Hermes on MYTHOS\'s own prompts.\n');
    console.log('  --samples N       samples per prompt per engine (default 3, below 3 warns)');
    console.log('  --engines a,b     subset of: hermes, dsh (default both)');
    console.log('  --timeout-ms N    per attempt (default 300000)');
    console.log('  --dsh-patch F     cordis.patch.yml declaring a non-DeepSeek provider route,');
    console.log('                    so no DEEPSEEK_API_KEY is needed (measures dsh + that provider)');
    console.log('  --forge           also measure the dsh WRITE path (Forge runBuild): file-appearance');
    console.log('                    oracle, approval-stall detection, and workspace confinement');
    return;
  }

  // Preflight. Every refusal below names the exact thing to set, because a
  // spike that runs half-configured produces a number nobody can trust and
  // everybody quotes.
  if (opts.engines.includes('dsh')) {
    if (opts.dshPatch) {
      // An explicit provider patch replaces the default DeepSeek route, so a
      // DeepSeek key is not required. Fail loud if the file is missing rather
      // than letting dsh boot on the default route and silently measure the
      // wrong provider — the whole point of the flag is that the operator knows
      // which model answered.
      if (!fs.existsSync(opts.dshPatch)) {
        console.error('spike: --dsh-patch names a file that does not exist: ' + opts.dshPatch);
        process.exit(2);
      }
      // FIXED 2026-08-21, and it silently voided the first real run of this
      // spike. The overlay path was forwarded to dsh EXACTLY as typed, i.e.
      // relative. This preflight resolves it against the spike's own cwd (the
      // repo root, where the operator typed it) and passed; dsh then resolved
      // the same relative string against ITS cwd — the throwaway temp workspace
      // AD-3 hands it — and died at boot with ENOENT on
      // <tmp>/<workspace>/mythos/scripts/fixtures/… . All 9 dsh attempts and
      // all 3 Forge attempts failed before a single model call, so the run
      // measured nothing about dsh while printing a table that looked like it
      // had. Resolve to absolute HERE, at the boundary, because the two
      // processes do not share a working directory.
      opts.dshPatch = path.resolve(opts.dshPatch);
      console.warn('NOTE: routing dsh through ' + opts.dshPatch + '. This measures dsh AND that '
        + 'provider; W6\'s question is about dsh, so prefer a direct DEEPSEEK_API_KEY run when comparing.');
    } else if (!process.env.DEEPSEEK_API_KEY) {
      console.error('spike: DEEPSEEK_API_KEY is not set, and no --dsh-patch was given.');
      console.error('  Checked: the inherited environment, then ' + ENV_FILES.join(', ') + '.');
      console.error('  dsh itself then resolves from the inherited environment, then');
      console.error('  $DSH_HOME/.credentials.yaml, then the invoking directory\'s .env, then $DSH_HOME/.env.');
      console.error('');
      console.error('  Two ways forward:');
      console.error('    1. Set DEEPSEEK_API_KEY in mythos/.env  (the clean measurement).');
      console.error('    2. Route through a key you already hold:');
      console.error('       --dsh-patch mythos/scripts/fixtures/dsh-openai-compatible.patch.yml');
      if (process.env.OPENROUTER_API_KEY) {
        console.error('       OPENROUTER_API_KEY is present, so route 2 will work as shipped.');
      } else {
        console.error('       That overlay wants OPENROUTER_API_KEY, which is also unset.');
      }
      console.error('  Nothing is measured without one of the two.');
      process.exit(2);
    }
  }

  const contract = readOutputContract();
  const verifier = await makeVerifier();

  const records = [];
  for (const engine of opts.engines) {
    for (const prompt of PROMPTS) {
      for (let i = 0; i < opts.samples; i++) {
        process.stderr.write('running ' + engine + ' / ' + prompt.id + ' / sample ' + (i + 1) + '\n');
        const rec = await attempt(engine, prompt, contract, verifier, opts);
        writeFixture(rec, i + 1);
        delete rec.content;   // keep the in-memory report small; the fixture holds the text
        records.push(rec);
      }
    }
  }

  report(records, opts);

  // The Forge variant runs AFTER the table above, and only when asked. It is a
  // different oracle on a different path, so it prints its own table rather
  // than being averaged into one number that describes neither.
  if (opts.forge) {
    if (!opts.engines.includes('dsh')) {
      console.log('\n--forge measures the dsh write path and --engines excluded dsh; skipped.');
    } else {
      const forgeRecords = [];
      for (let i = 0; i < opts.samples; i++) {
        process.stderr.write('running dsh / forge-write / sample ' + (i + 1) + '\n');
        const rec = await forgeAttempt(opts);
        if (rec.content) {
          fs.mkdirSync(FIXTURE_DIR, { recursive: true });
          fs.writeFileSync(path.join(FIXTURE_DIR, 'dsh--forge-write--' + String(i + 1).padStart(2, '0') + '.txt'), rec.content);
        }
        delete rec.content;
        forgeRecords.push(rec);
      }
      reportForge(forgeRecords);
    }
  }
}

main().catch((err) => {
  console.error('spike failed: ' + String((err && err.stack) || err));
  process.exit(1);
});
