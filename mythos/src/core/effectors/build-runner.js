'use strict';

// effectors/build-runner.js — WRAPS app/lib/orchestrator.js as an effector-facing job
// runner. NOT absorbed into GoalSystem: cognition runs at 1s cadence (MYTHOS_TICK_MS) and
// must never block on a multi-minute build; build-runner owns its own queue/pump loop,
// and job progress is surfaced back into cognition via sensors/job.js (onJobUpdate ->
// perception.job), not by cortex awaiting this module directly.
//
// Uses brain.think({ lane: 'build' }) — reasoning.chat() was DELETED in Phase 2.
// enqueue() shape is exactly { kind, prompt, run } — no cardId (see Spec Ambiguities #7).
//
// [Phase 18 — NEW] enqueue() also takes an optional `goalId`, carried onto the job
// record verbatim (null when the job is goal-less, e.g. a dashboard/voice-triggered
// action with no GoalSystem goal behind it — never a fake id). Closes the gap P17
// documented but explicitly left open: "no persisted job<->goal mapping anywhere in
// shipped production code." recoveredJobs (below) surfaces goalId too, so crash
// recovery can report which goal each recovered job belonged to.

// fail() — same { ok, result } shape used throughout the effectors (see
// from-dashboard.js, from-gmail.js, etc.). enqueue() uses this only for the
// empty-prompt refusal below; the success path still returns the raw job record.
function fail(reason) { return { ok: false, result: { error: reason } }; }

function createBuildRunner({ config, brain, bus, vault, verifier }) {
  if (!brain || typeof brain.think !== 'function') {
    throw new Error('createBuildRunner requires a brain with think()');
  }
  if (!vault || typeof vault.writeJSON !== 'function' || typeof vault.readJSON !== 'function') {
    throw new Error('createBuildRunner requires a vault fs-store with readJSON/writeJSON');
  }

  var CONCURRENCY = (config && config.MYTHOS_BUILD_CONCURRENCY) || 1;
  var MAX_PERSISTED = (config && config.MYTHOS_JOBS_MAX_PERSISTED) || 100;
  var JOBS_REL_PATH = 'Checkpoints/build-jobs.json';

  var jobs = new Map();     // id -> job record
  var queue = [];           // [{ job, prompt, run }]
  var runningCount = 0;
  var listeners = new Set();

  function onJobUpdate(fn) {
    listeners.add(fn);
    return function unsubscribe() { listeners.delete(fn); };
  }

  function persist() {
    try {
      vault.writeJSON(JOBS_REL_PATH, { jobs: Array.from(jobs.values()).slice(-MAX_PERSISTED) });
    } catch (err) {
      // Never swallow silently (lesson #8) — a jobs.json write failure is a real anomaly
      // even though in-memory state stays authoritative for this process's lifetime.
      if (bus) bus.emit('health.anomaly', { kind: 'jobs-persist-failed', error: err.message });
    }
  }

  // restart marks running jobs failed (honest) — no fake resume, per Crash Invariant #2.
  // CROSS-PHASE FIX (consistency pass, P7 vs P10): P10's chaos-restart-mid-action
  // drill needs a discoverable list of what got flipped on this construction —
  // recoveredJobs, populated here and surfaced via init() below.
  var recoveredJobs = [];
  function loadPersisted() {
    var data;
    try {
      data = vault.readJSON(JOBS_REL_PATH, { jobs: [] });
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'jobs-load-failed', error: err.message });
      data = { jobs: [] };
    }
    var list = data.jobs || [];
    for (var i = 0; i < list.length; i++) {
      var j = list[i];
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'failed';
        j.stage = 'failed';
        j.error = 'entity restarted mid-job';
        j.finishedAt = j.finishedAt || Date.now();
        recoveredJobs.push({ id: j.id, error: j.error, goalId: j.goalId != null ? j.goalId : null });
      }
      jobs.set(j.id, j);
    }
  }

  // init() is async per the shared build-runner/effector-hub contract (every
  // effector construction step in main.js's boot sequence is awaited) even
  // though loadPersisted() above already ran synchronously at construction —
  // init() just surfaces what construction already computed. Callers (main.js's
  // 'recovery' boot step, P10's chaos drill) await this to learn what was
  // recovered without needing to inspect internal state.
  async function init() {
    return { recoveredJobs: recoveredJobs.slice() };
  }

  function notify(job) {
    persist();
    listeners.forEach(function(fn) {
      try { fn(job); } catch (_) { /* a broken listener must never kill the pump */ }
    });
  }

  function enqueue({ kind, prompt, run, goalId, persona }) {
    // BUG-025 defensive fallback: a build-kind job with no real prompt means the
    // upstream card lost its spec (field-name mismatch, capture bug, etc.) — refuse
    // to enqueue rather than silently sending "undefined" into brain.think().
    if (!prompt || !String(prompt).trim()) {
      return fail('No spec — card missing description');
    }
    var job = {
      id: 'job-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      kind: kind,
      goalId: goalId != null ? goalId : null,
      status: 'queued',
      stage: 'queued',
      artifact: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null
    };
    jobs.set(job.id, job);
    queue.push({ job: job, prompt: prompt, run: run, persona: persona });
    notify(job);
    // Defer pump() so enqueue() always returns a job in 'queued' state — see NOVA
    // orchestrator.js's identical queueMicrotask comment; same race exists here.
    queueMicrotask(function() { pump(); });
    return job;
  }

  async function pump() {
    if (runningCount >= CONCURRENCY) return;
    var next = queue.shift();
    if (!next) return;
    runningCount += 1;

    var job = next.job, prompt = next.prompt, run = next.run, persona = next.persona;
    job.status = 'running';
    job.stage = 'generating';
    notify(job);

    try {
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id,
        persona: persona || undefined
      });

      if (!result || result.offline) {
        throw new Error('brain offline — chain exhausted for lane "build"');
      }
      if (result.aborted) {
        throw new Error('build aborted');
      }

      // Verification gate — check the output before saving. If it fails and we
      // haven't retried yet, regenerate once with the issues appended.
      // P22: if verification fails AFTER retry, mark the job failed — do NOT
      // save a known-defective artifact. Previously this saved anyway, shipping
      // garbage to the user silently.
      var raw = result.content;
      if (verifier && typeof verifier.verify === 'function') {
        job.stage = 'verifying';
        notify(job);
        // FIX H: prefer job.spec (the clean topic, set by buildKanbanCard) over
        // prompt — prompt is the full builder prompt (design-system boilerplate
        // first), which made the verifier's spec.slice(0,300) see only
        // boilerplate. Jobs that don't set spec keep the old prompt fallback.
        var verification = await verifier.verify(raw, job.spec || prompt);
        if (!verification.pass && !job._retried) {
          job._retried = true;
          var retryResult = await brain.think({
            lane: 'build',
            messages: [{ role: 'user', content:
              prompt + '\n\nYour previous output had these problems: ' +
              verification.issues.join('; ') + '. Fix them and regenerate.'
            }],
            source: 'build-runner-retry:' + job.id
          });
          if (retryResult && !retryResult.offline) {
            raw = retryResult.content;
            // Re-verify the retry — if it still fails, block shipment
            var reverify = await verifier.verify(raw, job.spec || prompt);
            if (!reverify.pass) {
              throw new Error('build failed verification after retry: ' + reverify.issues.join('; '));
            }
          }
        } else if (!verification.pass) {
          // Already retried or retry didn't help — block shipment
          throw new Error('build failed verification: ' + verification.issues.join('; '));
        }
      }

      job.stage = 'writing-artifact';
      notify(job);

      var runResult = await run(raw, job);
      job.status = 'done';
      job.stage = 'done';
      if (runResult && runResult.artifact) job.artifact = runResult.artifact;
      // A4: surface research provenance on the job record so job_status can
      // report whether the build was grounded in real web data or built blind.
      if (runResult && runResult.researchStatus) job.researchStatus = runResult.researchStatus;
      // BUG-016: capture review status and issues so the announcer can inform the user
      // whether the build passed review or has issues that need attention
      if (runResult && runResult.review) {
        job.reviewVerdict = runResult.review.verdict;
        if (runResult.review.issues && runResult.review.issues.length) {
          job.reviewIssues = runResult.review.issues;
        }
      }
    } catch (err) {
      job.status = 'failed';
      job.stage = 'failed';
      job.error = err && err.message ? err.message : String(err);
    }
    job.finishedAt = Date.now();
    notify(job);

    runningCount -= 1;
    pump();
  }

  function getJob(id) { return jobs.get(id) || null; }
  function listJobs() { return Array.from(jobs.values()); }
  function queuePosition(jobId) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].job.id === jobId) return i + 1;
    }
    return 0;
  }

  loadPersisted();

  return {
    enqueue: enqueue,
    getJob: getJob,
    listJobs: listJobs,
    queuePosition: queuePosition,
    onJobUpdate: onJobUpdate,
    init: init
  };
}

module.exports = { createBuildRunner };
