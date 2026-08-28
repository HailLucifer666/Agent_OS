'use strict';

// scripts/live-ai-digest-brief.js — LIVE verification driver (BUG-325..331 batch).
//
// Re-runs the original one-shot brief end-to-end through the REAL production
// path: real web_search chain (keys from .env), real research gate ordering
// (BUG-329), real design-archetype selection (327/331), real DeepSeek Harness
// engine, real verifier. No fakes. Prints a machine-readable evidence block:
//   EVIDENCE <search-title> | <url>          per live search hit
//   ARTIFACT <path>                          the shipped HTML
//   JOB <status> <error?>
//
// Usage: node mythos/scripts/live-ai-digest-brief.js [timeoutMs=900000]

process.loadEnvFile(require('path').join(__dirname, '..', '.env'));

const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../src/core/config');
const { createBus } = require('../src/core/bus');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBrain } = require('../src/core/brain');
const { createVerifier } = require('../src/core/design/verify');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const riskClassifier = require('../src/core/effectors/risk-classifier');
const { createBuildEngine } = require('../src/core/effectors/build-engine');
const dshAgent = require('../adapters/dsh-agent');
const webSearchMod = require('../src/core/effectors/web-search');
const webFetchMod = require('../src/core/effectors/web-fetch');

const BRIEF = "research the live web for this week's AI news, pick five, build a premium dark-theme AI-digest landing page";
const TIMEOUT_MS = Number(process.argv[2]) || 900000;

(async function main() {
  const config = loadConfig({});
  const bus = createBus({ historySize: 200 });
  const vaultRoot = process.env.MYTHOS_VAULT_ROOT || path.join(__dirname, '..', 'vault');
  fs.mkdirSync(path.join(vaultRoot, 'builds', 'pipeline'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'builds', 'kanban'), { recursive: true });
  const vaultFs = createFsStore(() => vaultRoot, bus);

  const brain = createBrain({ config, bus });
  const buildEngine = createBuildEngine({ engine: dshAgent, vault: vaultFs, bus: bus });

  const searchCalls = [];
  const webSearch = async (args) => {
    const out = await webSearchMod.web_search(args);
    const results = (out && out.result && out.result.results) || [];
    for (const r of results.slice(0, 8)) console.log('EVIDENCE ' + (r.title || '') + ' | ' + (r.url || ''));
    searchCalls.push(out);
    return out;
  };
  const webFetch = async (args) => webFetchMod.web_fetch(args);

  const buildRunner = createBuildRunner({ config, brain, bus, vault: vaultFs, verifier: createVerifier({ config }), buildEngine });
  const pipeline = createPipelineEffector({ fs: vaultFs, classifier: riskClassifier });
  const kanban = createKanbanEffector({ fs: vaultFs });
  const agentActions = createAgentActions({
    fs: vaultFs, pipeline, kanban, buildRunner, brain, buildEngine,
    webSearch, webFetch, bus, designSystem: false,
  });

  dshAgent.probe(true).then((online) => console.log('DSH online:', online));

  const card = pipeline.capture(BRIEF, 'live-verify');
  pipeline.approve(card.id);
  const started = agentActions.executePipelineCard(card.id, null);
  console.log('JOB ' + started.job.id);

  const job = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const j = buildRunner.getJob(started.job.id);
      if (j && (j.status === 'done' || j.status === 'failed')) { clearInterval(poll); resolve(j); }
      else if (Date.now() - t0 > TIMEOUT_MS) { clearInterval(poll); reject(new Error('job timeout after ' + TIMEOUT_MS + 'ms; last stage=' + (j && j.stage))); }
    }, 2000);
  });

  console.log('JOB ' + job.status + (job.error ? ' error=' + job.error : ''));
  // BUG-356. This line read `job.artifactPath || job.result?.artifactPath`, and
  // NEITHER PROPERTY EXISTS — build-runner.js declares the field as `artifact`
  // (:154) and assigns it there (:489); `artifactPath` and `result` appear
  // nowhere on a job record in this repo. So the EVIDENCE line this driver was
  // built to print was empty on every run, success and failure alike, and it
  // printed empty rather than complaining. That is where BUG-356's headline
  // "so no artifact ships" came from: a fail-open oracle reporting on itself.
  // Measured 2026-08-28 — a `done` run printed `ARTIFACT ` while
  // vault/builds/pipeline/ai-news-digest-landing-page.html sat on disk.
  //
  // `artifact` is a string OR a {path} record, exactly as announcer.js:108
  // already handles; anything else must never be stringified into the evidence
  // block as "[object Object]".
  const raw = job.artifact;
  const artifact = raw && typeof raw === 'object' ? raw.path : raw;
  if (job.status === 'done' && !artifact) {
    // A done job with nothing to point at is a finding, not a blank line.
    console.log('ARTIFACT MISSING — job is done but carries no artifact: '
      + JSON.stringify(Object.keys(job)));
  } else {
    console.log('ARTIFACT ' + (artifact || ''));
  }
  console.log('SEARCH-CALLS ' + searchCalls.length);
  process.exit(0);
})().catch((e) => { console.error('RUNNER-FAIL', e.message); process.exit(1); });
