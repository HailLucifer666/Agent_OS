// orchestrator.js — job runner for the orchestration spine (Pipeline Execute, Kanban agents).
// Queues agent jobs and runs them through the reasoning engine (ZCode → NIM → Claude CLI),
// one at a time by default. Honest-inert: coarse REAL stages only, verbatim errors,
// jobs found mid-run after a restart are marked failed — no fake resume.
const path = require('path');
const reasoning = require('./reasoning');
const vault = require('./vault');

const CONCURRENCY = Number(process.env.ORCHESTRATOR_CONCURRENCY) || 1;
const JOBS_FILE = path.join('Pipeline', 'jobs.json');
const MAX_PERSISTED = 100;

const jobs = new Map(); // id -> job record
const queue = [];
let runningCount = 0;
let broadcast = null; // set by server.js to push {type:'job-update', job} over ws

function setBroadcast(fn) {
  broadcast = fn;
}

function persist() {
  try {
    vault.writeJSON(JOBS_FILE, { jobs: [...jobs.values()].slice(-MAX_PERSISTED) });
  } catch {
    // persistence is best-effort; in-memory state stays authoritative
  }
}

function loadPersisted() {
  const data = vault.readJSON(JOBS_FILE, { jobs: [] });
  for (const j of data.jobs || []) {
    if (j.status === 'running' || j.status === 'queued') {
      j.status = 'failed';
      j.stage = 'failed';
      j.error = 'server restarted mid-job';
      j.finishedAt = j.finishedAt || new Date().toISOString();
    }
    jobs.set(j.id, j);
  }
}
loadPersisted();

function emit(job) {
  persist();
  if (broadcast) {
    try {
      broadcast({ type: 'job-update', job });
    } catch {
      // a broken socket must never take down the runner
    }
  }
}

// enqueue({kind, cardId, prompt, run}) — `run(rawOutput, job)` is the kind-specific
// completion handler (parse output, save artifact, move card); it runs after the CLI
// call succeeds and may throw to fail the job with its message.
function enqueue({ kind, cardId, prompt, run }) {
  const job = {
    id: `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    kind,
    cardId,
    status: 'queued',
    stage: 'queued',
    artifact: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  queue.push({ job, prompt, run });
  emit(job);
  // Defer pump() to the next microtask so enqueue() always returns a job in the
  // 'queued' state, regardless of how fast the reasoning engine resolves. Without
  // this, a synchronously-resolving stub (or a near-instant provider) would let
  // pump() run its state mutations up to the first `await` before enqueue returns.
  queueMicrotask(() => { pump(); });
  return job;
}

async function pump() {
  if (runningCount >= CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  runningCount += 1;

  const { job, prompt, run } = next;
  job.status = 'running';
  job.stage = 'generating';
  emit(job);

  try {
    const raw = await reasoning.chat([{ role: 'user', content: prompt }], {});
    job.stage = 'writing-artifact';
    emit(job);
    const result = await run(raw, job);
    job.status = 'done';
    job.stage = 'done';
    if (result && result.artifact) job.artifact = result.artifact;
  } catch (err) {
    job.status = 'failed';
    job.stage = 'failed';
    job.error = err && err.message ? err.message : String(err);
  }
  job.finishedAt = new Date().toISOString();
  emit(job);

  runningCount -= 1;
  pump();
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs() {
  return [...jobs.values()];
}

function queuePosition(jobId) {
  return queue.findIndex((q) => q.job.id === jobId) + 1; // 0 = not queued
}

module.exports = { enqueue, getJob, listJobs, queuePosition, setBroadcast };
