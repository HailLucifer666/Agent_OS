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
    const args = ['--yes', '@deepseek-ai/dsh', '--profile', 'headless'];
    // A --patch overlay is a LAUNCHER flag, so it must come before the task or
    // it would be swallowed as part of the app's arguments.
    if (opts.dshPatch) args.push('--patch', opts.dshPatch);
    args.push(prompt);
    const started = Date.now();
    execFile('npx', args, {
      cwd: opts.cwd,                       // AD-3: always explicit, never inherited
      timeout: opts.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32', // npx is a .cmd shim on Windows
      env: dshEnv(),
    }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      const out = String(stdout || '');
      const errText = String(stderr || '').trim();
      if (err) {
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

    const verdict = await verifier.verify(run.content, { title: prompt.id });
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
      obeyedNoWrite: mine.length - wrote.length,
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
      String(r.obeyedNoWrite).padEnd(16),
      r.medianMs == null ? 'n/a' : String(r.medianMs),
    ].join(''));
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
  console.log('A result of "dsh is worse" closes W6 honestly; see W6.1 for the cheap rollback.\n');
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
}

main().catch((err) => {
  console.error('spike failed: ' + String((err && err.stack) || err));
  process.exit(1);
});
