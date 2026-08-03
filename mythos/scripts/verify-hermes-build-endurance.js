#!/usr/bin/env node
// Sustained-load check: does a provider survive a build-length run of calls, or
// does it rate-limit partway through?
//
// The slot table was chosen on ONE-SHOT probes. A single successful call says
// nothing about call 40 — every free tier rate-limits before it fails auth, and
// none of them expose rate-limit headers, so exhaustion only ever shows up as a
// mid-build 429. This runs N sequential calls at realistic prompt size and
// reports WHERE the first failure lands, not just a pass/fail.
//
// Honest scope note: on this machine HERMES_PROVIDER_KEY and MISTRAL_API_KEY
// are the same key, so the brain shares this rate bucket. That makes the result
// a FLOOR — a dedicated key can only do better, never worse.
//
// Usage:
//   node scripts/verify-hermes-build-endurance.js [calls] [--model <id>]
//
// Exit 0 = completed all calls. Exit 1 = rate-limited or errored before the end.

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (_) {}

const argv = process.argv.slice(2);
const CALLS = Number(argv.find(a => /^\d+$/.test(a))) || 60;
const mi = argv.indexOf('--model');
const MODEL = mi >= 0 ? argv[mi + 1] : 'mistral-medium-latest';
// --delay <ms> paces calls. Distinguishes a REQUEST-rate limit (pacing fixes
// it, a build just needs a throttle) from a TOKEN-rate limit (pacing does not
// help within the window). Measured 2026-08-03: unpaced hit 429 at call 3.
const di = argv.indexOf('--delay');
const DELAY_MS = di >= 0 ? Number(argv[di + 1]) || 0 : 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ~12K chars of COHERENT context, matching the plan's "60-call build at ~12K
// prompt tokens" shape. Deliberately not repeated filler: a previous probe pass
// showed 24K of repeated filler is a harsher instruction-following test than a
// real spec, and produced misleading no-tool results.
const CONTEXT = (() => {
  const para = [
    'The Kestrel transport multiplexes frames over a single duplex connection.',
    'Each frame carries a 4-byte length prefix, a 2-byte stream id, a 1-byte type',
    'tag and a trailing CRC32 computed over the payload only. Frames larger than',
    '64 KiB are rejected at the parser boundary before any allocation occurs, so a',
    'hostile peer cannot force a large buffer by lying in the length prefix. The',
    'handshake uses a 47-byte preamble followed by a rotating nonce; a peer that',
    'omits the preamble is dropped without a reply, and one that replays a nonce',
    'inside the replay window is dropped with a diagnostic. On a failed handshake',
    'Kestrel backs off 900 ms and doubles to a 12 s ceiling before giving up.',
  ].join(' ');
  let s = '';
  let i = 0;
  while (s.length < 12000) { s += `\n\nSection ${++i}. ` + para; }
  return s.slice(0, 12000);
})();

const PROMPT = 'Read the specification below and answer in ONE short sentence: what is the '
  + 'backoff ceiling, and what happens to an oversized frame?\n' + CONTEXT;

function classify(errText) {
  const t = String(errText || '');
  if (/\b429\b|rate.?limit/i.test(t)) return 'RATE_LIMIT';
  if (/\b401\b|unauthor/i.test(t)) return 'AUTH';
  if (/timed out|timeout/i.test(t)) return 'TIMEOUT';
  if (/\b5\d\d\b/.test(t)) return 'SERVER_5XX';
  return 'OTHER';
}

(async () => {
  const local = (() => {
    try { return fs.readFileSync(path.join(ROOT, '..', '.env.local'), 'utf8'); } catch (_) { return ''; }
  })();
  const key = (local.match(/^MISTRAL_API_KEY=(.+)$/m) || [])[1]?.trim() || process.env.HERMES_PROVIDER_KEY;
  if (!key) { console.error('ABORT: no provider key available'); process.exit(1); }

  process.env.HERMES_PROVIDER_KEY = key;
  process.env.HERMES_PROVIDER_BASE_URL = 'https://api.mistral.ai/v1';
  process.env.HERMES_INFERENCE_MODEL = MODEL;
  for (const k of ['HERMES_PROVIDER_KEY_2', 'HERMES_PROVIDER_KEY_3', 'HERMES_PROVIDER_KEY_4']) delete process.env[k];

  const hermes = require(path.join(ROOT, 'adapters/hermes-agent/index.js'));
  const { createBuildEngine } = require(path.join(ROOT, 'src/core/effectors/build-engine.js'));
  const engine = createBuildEngine({ hermes, bus: null, brain: null });

  console.log(`Build endurance: ${CALLS} sequential calls, model=${MODEL}, ~${CONTEXT.length} chars/prompt, delay=${DELAY_MS}ms`);
  console.log('Shared rate bucket with the brain on this machine — treat the result as a FLOOR.\n');

  const lat = [];
  const failures = [];
  const started = Date.now();

  for (let i = 1; i <= CALLS; i++) {
    if (DELAY_MS && i > 1) await sleep(DELAY_MS);
    const t0 = Date.now();
    let res;
    try { res = await engine.generate({ prompt: PROMPT, source: 'endurance:' + i }); }
    catch (err) { res = { offline: true, error: String((err && err.message) || err) }; }
    const ms = Date.now() - t0;

    if (!res || res.offline || !res.content) {
      const kind = classify(res && res.error);
      failures.push({ call: i, kind, error: String((res && res.error) || '').slice(0, 110) });
      console.log(`  call ${String(i).padStart(3)}  FAIL  ${kind.padEnd(11)} ${ms}ms`);
      if (kind === 'RATE_LIMIT' || kind === 'AUTH') {
        console.log(`\n  stopping early — ${kind} at call ${i} of ${CALLS}`);
        break;
      }
    } else {
      lat.push(ms);
      if (i % 10 === 0 || i === 1) console.log(`  call ${String(i).padStart(3)}  ok    ${ms}ms`);
    }
  }

  const wall = Math.round((Date.now() - started) / 1000);
  lat.sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);

  console.log('\n--- endurance result ---');
  console.log(`  completed        : ${lat.length}/${CALLS} calls`);
  console.log(`  wall clock       : ${wall}s`);
  if (lat.length) {
    console.log(`  latency p50/p90  : ${pct(0.5)}ms / ${pct(0.9)}ms   (min ${lat[0]}ms, max ${lat[lat.length - 1]}ms)`);
  }
  if (failures.length) {
    console.log(`  failures         : ${failures.length}`);
    const first = failures[0];
    console.log(`  FIRST failure at call ${first.call}: ${first.kind} — ${first.error}`);
  } else {
    console.log('  failures         : none');
  }

  const survived = lat.length === CALLS;
  console.log(survived
    ? `\nPASS: ${MODEL} sustained a ${CALLS}-call build without rate-limiting.`
    : `\nFAIL: ${MODEL} did not sustain ${CALLS} calls.`);
  process.exit(survived ? 0 : 1);
})().catch(err => { console.error('endurance threw: ' + ((err && err.stack) || err)); process.exit(1); });
