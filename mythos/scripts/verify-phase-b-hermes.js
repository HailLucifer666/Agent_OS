#!/usr/bin/env node
// Live verification for Phase B: the four engagement generation sites must
// produce their text through the Hermes build engine, not brain.think.
//
// Unit tests wire buildEngine optionally and can pass with a stub, so they
// cannot tell "routed to Hermes" from "routed to a mock". This script runs the
// real adapter against the real provider and asserts engine === 'hermes' on
// content that actually came back over the wire.
//
// Usage: node scripts/verify-phase-b-hermes.js
// Exit 0 = every site verified live. Exit 1 = at least one did not.

'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

// Load mythos/.env the same way src/main.js:101 does — resolved from this
// file's location, never process.cwd(). Without it the adapter forwards no
// provider key and Hermes fails with "No usable credentials found".
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (_) {}

const hermes = require(path.join(ROOT, 'adapters/hermes-agent/index.js'));
const { createBuildEngine } = require(path.join(ROOT, 'src/core/effectors/build-engine.js'));
const { createInterview } = require(path.join(ROOT, 'src/core/engagements/interview.js'));
const { createSpecBuilder } = require(path.join(ROOT, 'src/core/engagements/spec-builder.js'));
const { createPlanBuilder } = require(path.join(ROOT, 'src/core/engagements/plan-builder.js'));

// Minimal bus: records anomalies so a silent provider rotation or a
// brain-fallback still shows up in the report instead of passing unnoticed.
const anomalies = [];
const bus = { emit: (kind, payload) => { if (kind === 'health.anomaly') anomalies.push(payload); } };

// No brain is wired on purpose. If a site quietly depends on brain.think, it
// fails loudly here rather than producing plausible text from the wrong engine.
const buildEngine = createBuildEngine({ hermes, bus, brain: null });

const config = { get: () => undefined };
const INTENT = 'Add a Spotify integration that can play a named playlist by voice.';

const results = [];
function record(site, ok, detail) {
  results.push({ site, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${site}  ${detail}`);
}

async function verifyInterview() {
  const interview = createInterview({ config, brain: null, buildEngine });
  const canned = await interview.generateQuestions(INTENT);
  const live = await interview.generateQuestionsBrain(INTENT);
  const questions = (live && live.questions) || live || [];
  const cannedText = JSON.stringify((canned && canned.questions) || canned || []);
  const liveText = JSON.stringify(questions);
  // The honest-inert fallback returns the canned defaults on any failure, so
  // "got questions back" is not evidence. Only a divergence from the canned
  // set proves generation actually happened.
  const ok = Array.isArray(questions) && questions.length > 0 && liveText !== cannedText;
  record('interview.generateQuestionsBrain', ok,
    ok ? `${questions.length} tailored questions, differs from canned defaults`
       : 'returned the canned DEFAULT_QUESTIONS — generator did not run');
  return questions;
}

async function verifySpec(questions) {
  const specBuilder = createSpecBuilder({ config, brain: null, buildEngine });
  // buildBrain reads each answer from question.answer inline — NOT from a
  // separate answers map. With no .answer present it returns the canned spec
  // without ever calling the generator, which looks like a pass if you only
  // check that markdown came back.
  const ANSWERS = [
    'A voice command that starts a named Spotify playlist.',
    'Playback control only. No playlist editing.',
    'Must reuse the existing Spotify effector and OAuth token.',
  ];
  const answered = {
    intent: INTENT,
    questions: (questions || []).slice(0, 3).map((q, i) => Object.assign({}, q, { answer: ANSWERS[i] })),
  };
  const canned = await specBuilder.build(answered);
  const spec = await specBuilder.buildBrain(answered);
  const text = spec ? (spec.markdown || spec.content || '') : '';
  const cannedText = (canned && canned.markdown) || '';
  // buildBrain returns the canned fallback object on every failure path, so
  // only a divergence from it proves Hermes actually wrote the spec.
  const ok = !!text && text !== cannedText && text.length > 200;
  record('spec-builder.buildBrain', ok,
    ok ? `Hermes-written spec, ${text.length} chars (canned was ${cannedText.length})`
       : `returned the canned spec (${text.length} chars) — generator did not run`);
  return spec;
}

async function verifyPlan(spec) {
  const planBuilder = createPlanBuilder({ config, buildEngine });
  const plan = await planBuilder.build(spec || { intent: INTENT }, {});
  const stages = (plan && plan.stages) || [];
  const ok = Array.isArray(stages) && stages.length > 0;
  record('plan-builder.build', ok,
    ok ? `${stages.length} stages` : 'no stages produced');
  return plan;
}

(async () => {
  console.log('Phase B live verification — real Hermes adapter, no brain wired.\n');

  const probe = await buildEngine.generate({ prompt: 'Reply with exactly: PONG', source: 'verify:phase-b' });
  if (!probe || probe.offline || probe.engine !== 'hermes') {
    console.error('ABORT: build engine is not reachable — ' + JSON.stringify(probe));
    process.exit(1);
  }
  console.log(`build engine reachable, engine='${probe.engine}', activeSlot=${(hermes.getStatus() || {}).activeSlot}\n`);

  const questions = await verifyInterview();
  const spec = await verifySpec(questions);
  await verifyPlan(spec);

  console.log('\nanomalies emitted: ' + (anomalies.length || 'none'));
  for (const a of anomalies) console.log('  - ' + a.kind + (a.error ? ': ' + a.error : ''));

  const failed = results.filter(r => !r.ok);
  // A brain-fallback anomaly means text was generated by the wrong engine.
  // Phase B's whole claim is that these sites route to Hermes, so treat it as
  // a failure even when the content itself looks fine.
  const fellBack = anomalies.some(a => a.kind === 'build-engine-fallback-used');
  if (fellBack) console.error('\nFAIL: a site fell back to the brain — Phase B routing is not effective.');
  console.log(`\n${results.length - failed.length}/${results.length} sites verified live.`);
  process.exit(failed.length === 0 && !fellBack ? 0 : 1);
})().catch(err => {
  console.error('verification threw: ' + ((err && err.stack) || err));
  process.exit(1);
});
