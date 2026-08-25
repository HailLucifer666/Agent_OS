'use strict';
// rescore-w6-fixtures.js — re-score already-committed W6 spike fixtures.
//
// WHY THIS EXISTS. The first real run of spike-dsh-build.js called
// `verifier.verify(content, { title: prompt.id })` — an OBJECT where
// verify(raw, spec) wants the spec TEXT. `String(spec)` produced the literal
// '[object Object]', so the title-relevance rule compared every artifact
// against that and Hermes scored verifier-pass 0/9 on artifacts that were, on
// inspection, complete and working. The spike is fixed. The FIXTURES are still
// good — that is exactly why W6.7 says to commit raw replies rather than a
// summary: a number in prose rots, a committed artifact can be re-scored by
// whoever disagrees with the run that produced it.
//
// So this re-scores what is on disk instead of paying to regenerate it. It never
// calls a build engine; the only network cost is the verifier's own LLM judge.
//
//   node mythos/scripts/rescore-w6-fixtures.js
//   node mythos/scripts/rescore-w6-fixtures.js --engine hermes
//
// Output is a per-fixture verdict plus a rule-frequency tally, because a bare
// pass count is uninterpretable — that is how the [object Object] defect
// survived its first run.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'w6-spike');

// Same order the spike uses, and for the same reason: mythos/.env is what the
// app reads, the repo-root .env.local is where this machine's real keys live.
for (const rel of [path.join(REPO_ROOT, '.env'), path.join(REPO_ROOT, '..', '.env.local')]) {
  try { process.loadEnvFile(rel); } catch (_) { /* optional */ }
}

// AD-1 again: the prompts are read from the spike that generated the fixtures,
// never retyped here. A local copy would drift and the re-score would then
// measure a spec the artifact was never asked for.
function loadPromptTexts() {
  const src = fs.readFileSync(path.join(__dirname, 'spike-dsh-build.js'), 'utf8');
  const block = src.match(/const PROMPTS = \[([\s\S]*?)\n\];/);
  if (!block) {
    throw new Error('rescore: could not find PROMPTS in spike-dsh-build.js. Do not paste a copy '
      + 'here — fix the reader, or the re-score scores a spec the artifacts never saw.');
  }
  const texts = new Map();
  const entryRe = /id:\s*'([^']+)',\s*\n\s*text:\s*([\s\S]*?)(?=\n\s*\},)/g;
  let m;
  while ((m = entryRe.exec(block[1])) !== null) {
    // The text is a JS string expression, possibly concatenated across lines.
    const literal = m[2].trim().replace(/\n\s*\+\s*/g, '');
    const parts = literal.match(/'((?:[^'\\]|\\.)*)'/g) || [];
    const text = parts.map((p) => p.slice(1, -1).replace(/\\'/g, "'")).join('');
    if (!text) throw new Error('rescore: failed to read the text of prompt ' + m[1]);
    texts.set(m[1], text);
  }
  if (!texts.size) throw new Error('rescore: parsed zero prompts out of spike-dsh-build.js');
  return texts;
}

// Refuse the degenerate stub, exactly as the spike does: createVerifier({brain})
// returns a verify() that resolves pass:true for EVERY input when the brain has
// no think(), and a re-score against that would print 100% for anything.
async function makeVerifier() {
  const { loadConfig } = require('../src/core/config');
  const { createBrain } = require('../src/core/brain');
  const { createVerifier } = require('../src/core/design/verify');
  const configResult = loadConfig({});
  const config = configResult && configResult.config;
  if (!config) throw new Error('rescore: loadConfig() returned no config');
  const brain = createBrain({ config: config, bus: { emit: function () {}, on: function () {} } });
  if (!brain || typeof brain.think !== 'function') {
    throw new Error('rescore: no usable brain, so verify() would degrade to a stub that returns '
      + 'pass:true for EVERY input. Set a brain provider key before scoring.');
  }
  return createVerifier({ brain: brain });
}

async function main() {
  const argv = process.argv.slice(2);
  let engineFilter = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--engine') { engineFilter = String(argv[++i] || ''); continue; }
    throw new Error('unknown argument: ' + argv[i]);
  }

  if (!fs.existsSync(FIXTURE_DIR)) {
    console.error('rescore: no fixtures at ' + FIXTURE_DIR + ' — run the spike first.');
    process.exit(2);
  }

  const prompts = loadPromptTexts();
  const verifier = await makeVerifier();

  // Fixture names are `<engine>--<promptId>--<NN>.txt`, written by the spike.
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.txt')).sort();
  const records = [];
  for (const file of files) {
    const parts = file.replace(/\.txt$/, '').split('--');
    if (parts.length !== 3) {
      console.warn('skipping unrecognized fixture name: ' + file);
      continue;
    }
    const [engine, promptId, sample] = parts;
    if (engineFilter && engine !== engineFilter) continue;
    const spec = prompts.get(promptId);
    if (!spec) {
      // A fixture whose prompt no longer exists cannot be scored against the
      // spec it was built for. Say so rather than scoring it against something
      // else and reporting a number.
      console.warn('SKIPPED ' + file + ': no prompt named "' + promptId + '" in the spike anymore, '
        + 'so there is no spec to score it against.');
      continue;
    }
    const content = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
    process.stderr.write('scoring ' + file + '\n');
    const verdict = await verifier.verify(content, spec);
    records.push({
      engine: engine,
      prompt: promptId,
      sample: sample,
      bytes: content.length,
      pass: Boolean(verdict && verdict.pass),
      issues: (verdict && verdict.issues) || [],
      warnings: (verdict && verdict.warnings) || [],
    });
  }

  console.log('\n=== W6 fixture re-score (spec passed as TEXT, as build-runner.js:228 does) ===');
  console.log('engine  prompt              sample  bytes   pass   issues');
  for (const r of records) {
    console.log([
      r.engine.padEnd(8),
      r.prompt.padEnd(20),
      r.sample.padEnd(8),
      String(r.bytes).padEnd(8),
      (r.pass ? 'PASS' : 'fail').padEnd(7),
      r.issues.join(' | ') || '(none)',
    ].join(''));
  }

  const byEngine = new Map();
  for (const r of records) {
    if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
    byEngine.get(r.engine).push(r);
  }
  console.log('\nPer engine:');
  for (const [engine, rs] of byEngine) {
    console.log('  ' + engine + ': ' + rs.filter((r) => r.pass).length + '/' + rs.length + ' pass');
  }

  const tally = new Map();
  for (const r of records) for (const i of r.issues) tally.set(i, (tally.get(i) || 0) + 1);
  if (tally.size) {
    console.log('\nRule frequency (check each is about the ARTIFACT, not about how it was scored):');
    for (const [issue, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log('  ' + String(n).padStart(3) + '  ' + issue);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error('rescore failed: ' + String((err && err.stack) || err));
  process.exit(1);
});
