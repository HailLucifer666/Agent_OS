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

// Content generation moved to build-engine.js — whose engine is `dsh` (DeepSeek
// Harness) since W6 2026-08-22, and was Hermes-Agent before it. This module does
// not care which: it holds an injected `buildEngine` and never names one.
// `buildEngine` is
// what production wires; when it is present brain.think is NEVER consulted for
// build content — there is deliberately no fallback, because a plausible-but-
// wrong artifact is worse than a failed job (see build-engine.js's header).
//
// `brain` remains accepted so the existing suite, which constructs this runner
// with a fake brain to exercise the queue/verify/retry/review machinery, keeps
// working without 11 test files being rewritten around an engine they aren't
// testing. Production never takes that path: main.js always passes buildEngine,
// and every job record is stamped with `engine` so a brain-generated artifact
// is visible rather than silent.
function createBuildRunner({ config, brain, bus, vault, verifier, buildEngine, refiner }) {
  var hasEngine = Boolean(buildEngine && typeof buildEngine.generate === 'function');
  if (!hasEngine && (!brain || typeof brain.think !== 'function')) {
    throw new Error('createBuildRunner requires a buildEngine with generate() (or a brain with think())');
  }
  if (!vault || typeof vault.writeJSON !== 'function' || typeof vault.readJSON !== 'function') {
    throw new Error('createBuildRunner requires a vault fs-store with readJSON/writeJSON');
  }

  var CONCURRENCY = (config && config.MYTHOS_BUILD_CONCURRENCY) || 1;
  // Refine loop (2026-08-14, the "snake game test"). The verifier reads the
  // SOURCE; this looks at the artifact RUNNING. Bounded, because each iteration
  // costs a full regeneration the operator is waiting on.
  var REFINE_MAX = (config && config.BUILD_REFINE_MAX_ITERATIONS) || 2;
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
      // Strict read (2026-08-02 audit): build-jobs.json is read-mutate-write —
      // loadPersisted() reads it, flips running/queued jobs to failed, and persist()
      // later writes the map back. A corrupt file read leniently returns { jobs: [] },
      // which the next persist() would write over the real job history, truncating it
      // behind ok:true. A corrupt store must surface, not be mistaken for "no jobs".
      data = vault.readJSONStrict(JOBS_REL_PATH, { jobs: [] });
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'jobs-load-failed', error: err.message });
      throw err;
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
    // REMEDIATION P2-12: build-jobs.json had no updatedAt at all — only
    // createdAt/finishedAt (finishedAt stays null for the entire in-progress
    // lifetime), so there was no way to tell a job that's genuinely still
    // running from one that silently stopped updating.
    job.updatedAt = Date.now();
    persist();
    listeners.forEach(function(fn) {
      try { fn(job); } catch (_) { /* a broken listener must never kill the pump */ }
    });
  }

  // BUG-310: `preparePrompt` is an optional async hook, awaited ONCE in pump()
  // before the first generation, whose return value replaces the prompt for the
  // rest of the job — first generation, verification retry, and every refine
  // regeneration.
  //
  // It exists because the caller could not do this itself. agent-actions.js
  // needs an async call (ui-ux-pro-max's search.py) to build the full prompt,
  // but executePipelineCard must stay synchronous for its own callers, which
  // read job.id off the return value. So it used to resolve the design system
  // inside run() and reassign its local — and run() is the LAST thing pump()
  // calls, so nothing it reassigned was ever generated from. One hook here fixes
  // every generation at once instead of the caller patching each one.
  function enqueue({ kind, prompt, run, goalId, persona, onFailed, preparePrompt }) {
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
    // REMEDIATION P0-2: onFailed is an optional caller hook (agent-actions.js
    // passes one for pipeline/kanban cards) invoked from pump()'s catch block
    // below when the job dies WITHOUT ever reaching `run()` — e.g. the build
    // engine itself is offline. Without it, run()'s own card bookkeeping
    // (BUG-016's reviewed/not-reviewed branches) never fires, and the card is
    // left at execute/progress:25 with no trace of failure — indistinguishable
    // from "still building" to pipeline_status forever.
    queue.push({
      job: job, prompt: prompt, run: run, persona: persona, onFailed: onFailed,
      preparePrompt: preparePrompt,
    });
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

    var job = next.job, prompt = next.prompt, run = next.run, persona = next.persona, onFailed = next.onFailed;
    job.status = 'running';
    job.stage = 'generating';
    notify(job);

    // BUG-310: complete the prompt BEFORE anything is generated from it. Every
    // later use in this function — the retry at the verification gate and each
    // refine regeneration — reads this same `prompt`, so they all inherit it.
    //
    // Failure here is never fatal: preparePrompt supplies design guidance, and a
    // build with no design guidance is worse-looking, not broken. But it is not
    // silent either. The whole reason this bug survived is that a discarded
    // design system looked identical to one that was never resolved, so the
    // degraded path says so on the bus and on the job record — lesson #8, and
    // the same shape as jobs-persist-failed above.
    if (typeof next.preparePrompt === 'function') {
      try {
        var prepared = await next.preparePrompt(prompt, job);
        if (prepared && typeof prepared === 'string' && prepared !== prompt) {
          prompt = prepared;
          job.promptPrepared = true;
        } else {
          job.promptPrepared = false;
        }
      } catch (err) {
        job.promptPrepared = false;
        job.promptPrepareError = (err && err.message) || String(err);
        if (bus) bus.emit('health.anomaly', { kind: 'prompt-prepare-failed', error: job.promptPrepareError });
      }
    }

    // One generator, resolved once. hasEngine → Hermes, exclusively.
    function generate(text, sourceTag) {
      if (hasEngine) {
        return buildEngine.generate({ prompt: text, source: sourceTag, spec: job.spec });
      }
      return brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: text }],
        source: sourceTag,
        persona: persona || undefined
      });
    }

    try {
      var result = await generate(prompt, 'build-runner:' + job.id);
      // C1 NOTE: the literal 'brain' here is NOT one of the values
      // completion-status.js treats as a fallback engine (only 'brain-fallback'
      // and the legacy 'fallback' are). That is deliberate today — it is
      // reachable only from test harnesses that construct this runner with a
      // bare `brain` and no `buildEngine` at all (main.js:415-416 always wires
      // a real buildEngine in production, so 'brain' cannot occur there), and
      // several existing tests (e.g. bug-016-failed-review-not-shipped.test.js's
      // approve case) rely on that plain-brain path reaching 'shipped' on an
      // approving review. If a future change makes 'brain' reachable in
      // production, completion-status.js's deriveCompletionPayload() must gain
      // an explicit branch for it — do not assume it is covered by the existing
      // 'brain-fallback'/'fallback' check.
      job.engine = (result && result.engine) || (hasEngine ? 'dsh' : 'brain');

      if (!result || result.offline) {
        // Carry the engine's real reason (usually the install hint) — "brain
        // offline" would be a lie once content comes from the build engine.
        throw new Error((result && result.error) || 'brain offline — chain exhausted for lane "build"');
      }
      if (result.aborted) {
        throw new Error('build aborted');
      }

      // Verification gate — check the output before saving. If it fails and we
      // haven't retried yet, regenerate once with the issues appended.
      // P22: if verification fails AFTER retry, mark the job failed — do NOT
      // save a known-defective artifact. Previously this saved anyway, shipping
      // garbage to the user silently.
      // Softening: the verifier splits findings into issues (rule-based, hard-
      // fail — genuine garbage) and warnings (LLM-judge advisory — stylistic
      // opinions like "violates Swiss Style"). Only issues block shipment;
      // warnings are recorded on the job for the review phase (ship-with-
      // warning), mirroring fullReview's existing behavior. This stops the
      // LLM-judge from vetoing legitimate stylistic variation the rules allow.
      var raw = result.content;
      if (verifier && typeof verifier.verify === 'function') {
        job.stage = 'verifying';
        notify(job);
        // FIX H: prefer job.spec (the clean topic, set by buildKanbanCard) over
        // prompt — prompt is the full builder prompt (design-system boilerplate
        // first), which made the verifier's spec.slice(0,300) see only
        // boilerplate. Jobs that don't set spec keep the old prompt fallback.
        var verification = await verifier.verify(raw, job.spec || prompt);
        if (verification.warnings && verification.warnings.length) {
          job._verifyWarnings = verification.warnings;
        }
        if (!verification.pass && !job._retried) {
          job._retried = true;
          var retryResult = await generate(
            prompt + '\n\nYour previous output had these problems: ' +
            verification.issues.join('; ') + '. Fix them and regenerate.',
            'build-runner-retry:' + job.id
          );
          if (retryResult && !retryResult.offline) {
            raw = retryResult.content;
            // Re-verify the retry — only rule-based issues block shipment.
            var reverify = await verifier.verify(raw, job.spec || prompt);
            if (reverify.warnings && reverify.warnings.length) {
              job._verifyWarnings = reverify.warnings;
            }
            if (!reverify.pass) {
              throw new Error('build failed verification after retry: ' + reverify.issues.join('; '));
            }
          }
        } else if (!verification.pass) {
          // Already retried or retry didn't help — block shipment (rule-based issues only)
          throw new Error('build failed verification: ' + verification.issues.join('; '));
        }
      }

      // ---- Refine loop (render -> look -> critique -> regenerate) ----------
      //
      // Everything above this point judged the artifact's SOURCE. This judges
      // the artifact RUNNING: real headless browser, real console/page errors,
      // real screenshot, vision-lane critique guided by the vendored hallmark +
      // webapp-testing content. That is the gap the "snake game test" exposed —
      // a build that parses, passes every rule and throws on the first
      // animation frame used to ship as done.
      //
      // Constructed-inside-the-flag is the CALLER's job (main.js only builds a
      // refiner when BUILD_REFINE_ENABLED is on — an opt-out flag protects
      // nothing that runs before it is read, per the Slice-5 lesson). Here the
      // absence of a refiner is simply "not enabled", and it is recorded on the
      // job rather than being invisible.
      if (refiner && typeof refiner.available === 'function' && refiner.looksRenderable(raw)) {
        if (!refiner.available()) {
          // Honest skip: the operator asked for refinement and did not get it.
          job.refineStatus = 'skipped';
          job.refineSkipReason = refiner.unavailableReason();
        } else {
          job.stage = 'refining';
          notify(job);
          job.refinePasses = [];
          // The artifact as it stands has already passed the verifier, so it is
          // the fallback we ship if refinement cannot improve on it. Never ship
          // an UNVERIFIED regeneration just because it was the last one tried.
          var lastGood = raw;
          // Runtime errors OBSERVED in the artifact currently held as lastGood,
          // or null when the held artifact has never been rendered (a candidate
          // accepted on the final iteration). Not the model's opinion —
          // page/console errors straight out of the browser.
          //
          // This exists because of the first real end-to-end run (2026-08-14).
          // Hermes's first snake game called an undefined function; the loop
          // caught it, regenerated, and the regeneration was rejected by the
          // SOURCE verifier over a style rule ("no @media queries"). The revert
          // branch then shipped the original — which throws — as status:done.
          // "Last verified" turned out not to mean "works": the verifier reads
          // source and cannot see a runtime error, so the one gate that CAN see
          // it has to be the one that decides. A known-broken artifact must fail
          // the job, exactly as P22 already refuses to save an artifact that
          // fails verification after a retry.
          var heldRuntimeErrors = null;
          var iteration = 0;
          while (iteration < REFINE_MAX) {
            iteration += 1;
            var rendered = await refiner.render(raw, job.id + '-' + iteration);
            heldRuntimeErrors = (rendered.pageErrors || []).concat(rendered.consoleErrors || []);
            var critique = await refiner.critique({
              screenshotB64: rendered.screenshotB64,
              renderError: rendered.error || null,
              consoleErrors: rendered.consoleErrors || [],
              pageErrors: rendered.pageErrors || [],
              // Measured DOM/canvas facts. Without them the critique denied
              // content the screenshot plainly showed — see build-refine.js's
              // observe() for the run that produced that false FAIL.
              observations: rendered.observations || null,
              spec: job.spec || prompt,
            });
            job.refinePasses.push({
              iteration: iteration,
              screenshot: rendered.screenshotPath || null,
              renderOk: !!rendered.ok,
              consoleErrors: (rendered.consoleErrors || []).slice(0, 5),
              pageErrors: (rendered.pageErrors || []).slice(0, 5),
              pass: critique.pass,
              verdict: String(critique.verdict || '').slice(0, 400),
              issues: critique.issues || [],
              model: critique.model || null,
            });
            notify(job);

            if (critique.pass === true) {
              job.refineStatus = iteration === 1 ? 'passed-first-look' : 'refined';
              lastGood = raw;
              break;
            }
            if (critique.pass === null) {
              // Blind pass: the vision lane could not answer. Keep the
              // verified artifact and say so — never silently claim refinement.
              job.refineStatus = 'blind';
              job.refineSkipReason = critique.verdict;
              break;
            }

            // Real failure. Regenerate WITH the critique, then re-verify: a
            // regeneration that fixes the visuals and breaks a rule must not
            // slip past the gate the first generation had to clear.
            var refineResult = await generate(
              prompt + '\n\nA screenshot of your previous output was reviewed and REJECTED. '
              + 'Problems found when it was actually rendered and run:\n- '
              + (critique.issues.length ? critique.issues.join('\n- ') : String(critique.verdict).slice(0, 500))
              + '\n\nFix every one of them and regenerate the complete artifact.',
              'build-runner-refine' + iteration + ':' + job.id
            );
            if (!refineResult || refineResult.offline || !refineResult.content) {
              job.refineStatus = 'exhausted';
              job.refineIssues = critique.issues;
              break;
            }
            var candidate = refineResult.content;
            if (verifier && typeof verifier.verify === 'function') {
              var refineVerify = await verifier.verify(candidate, job.spec || prompt);
              if (!refineVerify.pass) {
                // The refined version is worse by the rules. Keep the verified
                // one and stop — this is the "ships the LAST verified-passing
                // artifact" branch, recorded rather than hidden.
                job.refineStatus = 'reverted';
                job.refineIssues = refineVerify.issues || [];
                break;
              }
              if (refineVerify.warnings && refineVerify.warnings.length) {
                job._verifyWarnings = refineVerify.warnings;
              }
            }
            raw = candidate;
            lastGood = candidate;
            // The candidate has passed the SOURCE verifier but has not been
            // rendered yet. Whether it throws is unknown, and unknown must not
            // be recorded as clean — if the loop ends here, the job says
            // 'exhausted' without claiming the artifact runs.
            heldRuntimeErrors = null;
            if (iteration >= REFINE_MAX) {
              // Bound reached with the last critique still failing. The artifact
              // shipped is verified but NOT visually approved, and the job says
              // exactly that — a refine loop that runs out of iterations must
              // never report a critique failure as success.
              job.refineStatus = 'exhausted';
              job.refineIssues = critique.issues;
            }
          }
          job.refineIterations = iteration;
          raw = lastGood;
          // KNOWN-BROKEN NEVER SHIPS AS DONE. Reached when refinement ended
          // without a pass and the artifact being held is one we WATCHED throw:
          // the reverted branch (the regeneration was worse by the rules), the
          // engine-offline branch, or a blind verdict on a page that errored.
          // The runtime error is a browser observation, not a judgement, so this
          // is deterministic — and it is the one signal the source verifier
          // structurally cannot see.
          if (heldRuntimeErrors && heldRuntimeErrors.length && job.refineStatus !== 'refined'
              && job.refineStatus !== 'passed-first-look') {
            job.refineRuntimeErrors = heldRuntimeErrors.slice(0, 5);
            throw new Error('build failed: the artifact throws when it runs and refinement could not fix it ('
              + heldRuntimeErrors.slice(0, 3).join('; ') + ')');
          }
        }
      }

      job.stage = 'writing-artifact';
      notify(job);

      // BUG-310: run() receives the PREPARED prompt as a third argument. Its
      // own callers (agent-actions.js) close over the string they passed to
      // enqueue(), which is the unprepared one — without this they would rebuild
      // from a design-system-less prompt on the grounded/retry paths while the
      // first generation used the prepared one. Existing run() implementations
      // that take (raw, job) simply ignore it.
      var runResult = await run(raw, job, prompt);
      job.status = 'done';
      job.stage = 'done';
      if (runResult && runResult.artifact) job.artifact = runResult.artifact;
      // Surface verifier warnings (LLM-judge advisory — stylistic opinions that
      // didn't block shipment) on the job record so job_status/announcer can
      // flag them, mirroring how review issues are surfaced below.
      if (job._verifyWarnings && job._verifyWarnings.length) {
        job.verifyStatus = 'warn';
        job.verifyWarnings = job._verifyWarnings;
      }
      // A4: surface research provenance on the job record so job_status can
      // report whether the build was grounded in real web data or built blind.
      if (runResult && runResult.researchStatus) job.researchStatus = runResult.researchStatus;
      // BUG-016: capture review status and issues so the announcer can inform the user
      // whether the build passed review or has issues that need attention
      // BUG-316: reviewStatus/reviewRequired carry what the review ACTUALLY
      // concluded. reviewVerdict alone cannot: a skipped review is implemented
      // as a hardcoded { verdict: 'approve' }, so every reader of the job record
      // — job_status, the announcer — saw an approval that never happened.
      if (runResult && runResult.reviewStatus) job.reviewStatus = runResult.reviewStatus;
      if (runResult && typeof runResult.reviewRequired === 'boolean') {
        job.reviewRequired = runResult.reviewRequired;
      }
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
      // REMEDIATION P0-2: give the caller (agent-actions.js) a chance to mark
      // its card as failed. Best-effort — a broken hook must never mask the
      // real job failure being recorded above.
      if (typeof onFailed === 'function') {
        try { onFailed(err, job); } catch (_) { /* best-effort */ }
      }
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
