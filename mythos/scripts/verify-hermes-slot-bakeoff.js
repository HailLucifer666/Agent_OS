#!/usr/bin/env node
// Slot bake-off: run the SAME real build through each candidate provider/model
// and compare the ARTIFACTS, not the latency.
//
// Why this exists: the provider probes that chose the slot order measured
// one-shot tool-call ability on a single prompt. That does not tell you whether
// a model stays coherent across a real build, which is the only thing that
// matters for slot 1. This runs a build-shaped prompt whose output can be
// checked objectively — it must parse as JavaScript and contain the specific
// behaviours the prompt asked for — so "produced 4KB of confident prose" cannot
// be mistaken for a working artifact.
//
// Usage:
//   node scripts/verify-hermes-slot-bakeoff.js            # slot-1 model candidates
//   node scripts/verify-hermes-slot-bakeoff.js --slots    # one build per configured slot
//
// Exit 0 = at least one candidate produced a valid artifact. Exit 1 = none did.

'use strict';

const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (_) {}

// .env.local at the repo root holds this machine's real provider keys and is
// NOT loaded by the app — read it here so the bake-off can reach providers the
// running system does not currently route to.
const fs = require('fs');
function envLocal(key) {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '..', '.env.local'), 'utf8');
    const m = txt.match(new RegExp('^' + key + '=(.+)$', 'm'));
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}

const BUILD_PROMPT = [
  'Write a single self-contained CommonJS module and reply with ONLY the code —',
  'no prose, no markdown fence.',
  '',
  'It must export a function `backoff(attempt)` that returns a delay in ms for an',
  'exponential backoff with these EXACT rules:',
  '  - attempt 0 returns 900',
  '  - each subsequent attempt doubles the previous delay',
  '  - the delay is capped at 12000 and never exceeds it',
  '  - a negative or non-integer attempt throws a TypeError',
  '',
  'Export it as module.exports = { backoff }.',
].join('\n');

// Objective checks. A model that writes plausible-looking code but gets the
// cap or the throw wrong fails here, which is the entire point of comparing
// artifacts rather than eyeballing length.
function gradeArtifact(code) {
  const issues = [];
  if (!code || !code.trim()) return { score: 0, issues: ['empty reply'] };

  // Strip a markdown fence if the model added one despite being told not to.
  let src = code.trim();
  const fence = src.match(/^```(?:js|javascript)?\s*([\s\S]*?)```\s*$/);
  if (fence) { src = fence[1]; issues.push('wrapped in a markdown fence (asked not to)'); }

  let mod;
  try {
    const sandbox = { module: { exports: {} }, exports: {}, require, console };
    sandbox.module.exports = sandbox.exports;
    vm.runInNewContext(src, sandbox, { timeout: 2000 });
    mod = sandbox.module.exports;
  } catch (err) {
    return { score: 0, issues: issues.concat(['does not evaluate: ' + String(err.message).slice(0, 80)]) };
  }

  const fn = mod && (mod.backoff || (typeof mod === 'function' ? mod : null));
  if (typeof fn !== 'function') return { score: 0, issues: issues.concat(['no backoff export']) };

  let score = 1; // it runs and exports
  const check = (label, fnCheck) => {
    try { if (fnCheck()) score++; else issues.push(label); }
    catch (e) { issues.push(label + ' (threw: ' + String(e.message).slice(0, 40) + ')'); }
  };

  check('attempt 0 !== 900', () => fn(0) === 900);
  check('does not double', () => fn(1) === 1800 && fn(2) === 3600);
  check('cap not enforced at 12000', () => fn(10) === 12000 && fn(50) === 12000);
  // `instanceof TypeError` is WRONG here: runInNewContext builds a separate
  // realm with its own TypeError constructor, so a correct artifact's error is
  // never an instance of THIS realm's TypeError. Compare e.name instead.
  // (Caught only because three different models failed the same two checks
  // while the emitted code was visibly correct.)
  const isTypeError = (e) => !!e && (e.name === 'TypeError' || (e.constructor && e.constructor.name === 'TypeError'));
  check('negative attempt does not throw TypeError', () => {
    try { fn(-1); return false; } catch (e) { return isTypeError(e); }
  });
  check('non-integer attempt does not throw TypeError', () => {
    try { fn(1.5); return false; } catch (e) { return isTypeError(e); }
  });

  return { score, max: 6, issues };
}

async function runOne(label, env) {
  // Fresh adapter per candidate: the module caches its resolved slot table and
  // activeSlot, so reusing it would silently measure the first candidate twice.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('hermes-agent') || k.includes('build-engine')) delete require.cache[k];
  }
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of ['HERMES_PROVIDER_KEY_2', 'HERMES_PROVIDER_KEY_3', 'HERMES_PROVIDER_KEY_4']) {
    saved[k] = process.env[k]; delete process.env[k];
  }

  const hermes = require(path.join(ROOT, 'adapters/hermes-agent/index.js'));
  const { createBuildEngine } = require(path.join(ROOT, 'src/core/effectors/build-engine.js'));
  const engine = createBuildEngine({ hermes, bus: null, brain: null });

  const started = Date.now();
  let res;
  try {
    res = await engine.generate({ prompt: BUILD_PROMPT, source: 'bakeoff:' + label });
  } catch (err) {
    res = { offline: true, error: String((err && err.message) || err) };
  }
  const ms = Date.now() - started;

  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  if (!res || res.offline || !res.content) {
    return { label, ok: false, ms, detail: String((res && res.error) || 'no content').slice(0, 130) };
  }
  const grade = gradeArtifact(res.content);
  return { label, ok: grade.score === grade.max, ms, grade, chars: res.content.length };
}

(async () => {
  const slotMode = process.argv.includes('--slots');
  const mistralKey = envLocal('MISTRAL_API_KEY') || process.env.HERMES_PROVIDER_KEY;
  const cerebrasKey = envLocal('CEREBRAS_API_KEY');

  const candidates = slotMode
    ? [
        cerebrasKey && { label: 'slot3 cerebras/gpt-oss-120b', env: { HERMES_PROVIDER_KEY: cerebrasKey, HERMES_PROVIDER_BASE_URL: 'https://api.cerebras.ai/v1', HERMES_INFERENCE_MODEL: 'gpt-oss-120b' } },
        mistralKey && { label: 'slot1 mistral-medium-latest', env: { HERMES_PROVIDER_KEY: mistralKey, HERMES_PROVIDER_BASE_URL: 'https://api.mistral.ai/v1', HERMES_INFERENCE_MODEL: 'mistral-medium-latest' } },
      ].filter(Boolean)
    : ['mistral-medium-latest', 'mistral-large-2512', 'mistral-vibe-cli-with-tools'].map(m => ({
        label: m,
        env: { HERMES_PROVIDER_KEY: mistralKey, HERMES_PROVIDER_BASE_URL: 'https://api.mistral.ai/v1', HERMES_INFERENCE_MODEL: m },
      }));

  console.log(slotMode ? 'Slot end-to-end build\n' : 'Slot-1 model bake-off — same build, artifacts compared\n');
  if (!mistralKey) { console.error('ABORT: no Mistral key available'); process.exit(1); }
  if (slotMode && !cerebrasKey) console.log('NOTE: no Cerebras key — slot 3 skipped\n');

  const out = [];
  for (const c of candidates) {
    process.stdout.write(`  running ${c.label} ... `);
    const r = await runOne(c.label, c.env);
    out.push(r);
    if (r.grade) {
      console.log(`${r.grade.score}/${r.grade.max} correct, ${r.chars} chars, ${r.ms}ms`);
      for (const i of r.grade.issues) console.log(`      - ${i}`);
    } else {
      console.log(`FAILED (${r.ms}ms) — ${r.detail}`);
    }
  }

  console.log('\n--- result ---');
  const usable = out.filter(r => r.grade && r.grade.score === r.grade.max);
  for (const r of out) {
    const s = r.grade ? `${r.grade.score}/${r.grade.max}` : 'unreachable';
    console.log(`  ${r.label.padEnd(32)} ${s.padEnd(12)} ${r.ms}ms`);
  }
  console.log(usable.length
    ? `\n${usable.length}/${out.length} produced a fully correct artifact.`
    : `\nNONE produced a fully correct artifact.`);

  // NOTE: this measures per-call coherence on one build-shaped prompt. It does
  // NOT prove a provider survives a 60-call build loop without rate-limiting —
  // that needs sustained load and, for slot 1, a key not shared with the brain.
  console.log('Scope: single-call artifact correctness. Sustained 60-call endurance is NOT measured here.');
  process.exit(usable.length ? 0 : 1);
})().catch(err => { console.error('bake-off threw: ' + ((err && err.stack) || err)); process.exit(1); });
