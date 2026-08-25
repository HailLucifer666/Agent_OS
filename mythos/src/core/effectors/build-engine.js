'use strict';

// effectors/build-engine.js — the single content-generation engine for builds.
//
// WHY THIS EXISTS. MYTHOS grew three independent build engines: build-runner.js
// (brain.think, driving pipeline_execute/kanban_build_card/start_project/
// run_mission), engagements/executor.js (a second, unqueued brain.think call
// site), and Forge/forge-runner.js (an external agent CLI). Three engines
// meant three behaviours, and the brain-backed ones produced the fabricated
// "Week of November 20, 2023" landing page that the reality-checker rejected.
// This module collapses content generation onto ONE external agent so there is
// one engine with one behaviour. That engine was Hermes-Agent until W6
// (2026-08-22) swapped it for DeepSeek Harness; the HARNESS changed and the
// models did not — dsh runs whatever BRAIN_TABLES.build ranks first.
//
// NO FALLBACK — deliberate. When the engine is unavailable a build FAILS with
// the adapter's install hint. It does not quietly regenerate through brain.think.
// A wrong-but-plausible artifact is worse than a missing one: the whole reason
// this repo keeps getting burned is work that reports success it didn't earn.
//
// BRAIN FALLBACK (2026-07-31) — ADDED, THEN REMOVED 2026-08-15 on the operator's
// ruling. Its argument was that verifier.verify() made a brain-generated artifact
// safe to ship. The 2026-08-14 session settled it empirically: the fallback fired,
// the verifier DID catch the result ("Content appears generic placeholder,
// lacking specific AI news items"), and the job was recorded as done anyway. A
// guard that is correct and ignored is not a guard. See engineFailed() below for
// the full record; the rule at the top of this comment is the live one again.
//
// RETURN SHAPE is intentionally brain.think-compatible
// ({ content, offline, aborted, ... }) so the existing call sites keep their
// null/offline checks, their verifier gate, their retry and their review step
// unchanged. This is a swap of the generator, not a rewrite of the pipeline.

var path = require('path');

// The engine is agentic: left to itself it may write files and reply with a prose
// summary of what it did. The legacy contract needs the artifact CONTENT as the
// reply, so state that as a hard constraint. When it disobeys, verifier.verify()
// in build-runner catches the mismatch and fails the job honestly — this
// preamble reduces that case, it is not trusted to eliminate it.
// The last two lines are not style advice — they are the two failure modes that
// showed up in FOUR consecutive real builds on 2026-08-14, once the refine loop
// started rendering what this engine produces:
//   * three of four snake games auto-started on page load, ran into a wall
//     unattended, and were sitting on a "Game Over!" overlay by the time anyone
//     (or anything) looked at them. Nobody had pressed a key. The artifact was
//     technically complete and effectively dead on arrival.
//   * the pieces were drawn at a size that read as an empty board — measured at
//     0.5% of canvas pixels painted.
// Both are cheap to state up front and expensive to catch afterwards; the refine
// loop is what makes a regression here visible again rather than silent.
var OUTPUT_CONTRACT = [
  'OUTPUT CONTRACT — read before doing anything:',
  '- Reply with the finished artifact content ONLY. No preamble, no summary, no commentary.',
  '- Do NOT create, write or modify any files. Your reply IS the deliverable.',
  '- Do not wrap the whole reply in a markdown code fence unless the artifact itself is fenced.',
  '- An interactive artifact must open in a READY state that waits for the user: never auto-start a'
    + ' game loop that can lose before any input arrives, and never open on a game-over/error screen.',
  '- Draw at a size a person can actually see: game pieces, data points and controls should be'
    + ' obvious at a glance on a 1280x800 screen, not a few pixels on an empty-looking board.',
  // ADDED 2026-08-22, and it is the only clause here with a measured miss rate
  // rather than an incident behind it. W6's engine comparison scored 18 generated
  // artifacts through this repo's own verifier (9 from Hermes-Agent, 9 from dsh,
  // both on mistral-large-2512) and produced an unusually clean result: 6 of 9
  // failed on EACH engine, and all 12 rejections named ONE rule —
  // "no @media queries (not responsive)". Nothing else fired, on either engine.
  //
  // The contract above asks for a ready state and a visible scale; it never asked
  // the model to make the artifact work on a narrow screen. So this was a gap in
  // the INSTRUCTION, not in either harness — which is why swapping the harness
  // correctly changed nothing about it, and why fixing it belongs here rather
  // than in an adapter.
  //
  // THEN MEASURED PROPERLY, because the first number was not a controlled one.
  // The 3/9-vs-8/9 comparison that suggested this change moved the MODEL as well
  // as the contract (mistral-large-2512 to codestral-latest), so it could not
  // attribute the gain to either. Re-run on ONE model, codestral-latest, with
  // this clause as the only difference:
  //
  //     without this line   2/9 verifier-pass   (6 rejections, all @media)
  //     with this line      8/9 verifier-pass   (1 rejection,  @media)
  //
  // Same prompts, same oracle, same model, 9 samples each. The surviving failure
  // is interactive-snake, which suggests a game canvas is the case a general
  // "make it responsive" instruction reaches least well — worth a separate look,
  // not worth widening this clause on a guess.
  //
  // A PROMPT INSTRUCTION IS STILL NOT A GUARANTEE (see the fence note below,
  // which exists because a different clause in this same contract was ignored).
  // 8/9 is an improvement, not a proof, and the verifier remains the gate.
  '- Make it work on a phone as well as a desktop: include at least one @media query and use'
    + ' layout that reflows (flex/grid, percentage or clamp() widths) rather than fixed pixel'
    + ' columns. A page that only works at one window size is not finished.',
].join('\n');

// A PROMPT INSTRUCTION IS NOT A GUARANTEE (found 2026-08-14, first real
// end-to-end build). The contract above asks the model not to wrap its reply in
// a markdown fence. Hermes wrapped it anyway, and nothing downstream stripped
// it, so the saved .html began with ```html and ended with ``` — which the
// browser renders as literal text either side of the page. It had been shipping
// on every fenced reply, invisible to the whole pipeline: the verifier reads
// source without a "no stray fences" rule, and the only reason anyone saw it is
// that the new refine loop screenshotted the artifact and the fence text was
// there in the picture.
//
// Deliberately narrow: strip ONLY a fence that wraps the ENTIRE reply (first
// non-empty line opens it, last non-empty line closes it). An artifact that
// legitimately CONTAINS fenced blocks — a markdown README, a doc with code
// samples — is untouched, because its first line is not an opening fence.
var WHOLE_REPLY_FENCE_RE = /^\s*```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*\s*$/;

function stripWholeReplyFence(text) {
  var s = String(text == null ? '' : text);
  var m = s.match(WHOLE_REPLY_FENCE_RE);
  if (!m) return s;
  var inner = m[1];
  // Refuse to "fix" a reply whose inner content is itself fence-opening — that
  // is a nested/ambiguous shape, and guessing there could truncate an artifact.
  if (/^\s*```/.test(inner)) return s;
  return inner.trim() ? inner : s;
}

// W6 (2026-08-22) — THERE IS NO ERROR-REPLY REGEX HERE ANY MORE, and its
// absence is a decision rather than an oversight.
//
// Hermes reported provider failures on STDOUT with EXIT CODE 0 (BUG-058/245): a
// misconfigured provider replied "HTTP 401: Missing Authentication header" and
// looked like a perfectly successful run, so that text became the artifact. The
// adapter defined `HERMES_ERROR_REPLY_RE` and this module imported it.
//
// dsh has no such mode. Its exit code IS the oracle — 0 iff the final `turn/end`
// reason is `completed` — and its reference documents stderr as empty on
// success. The adapter asserts BOTH: a non-zero exit throws, and an exit 0 that
// nonetheless wrote to stderr throws with the text, on the grounds that the
// documented contract moved and content produced under unknown conditions must
// not be scored. So by the time `generate` sees a reply, the "exit 0 but
// actually a provider error" case has already been rejected upstream.
//
// Writing a speculative detector here anyway would add a pattern nothing has
// ever matched, over attacker-adjacent text (a model's own output), which this
// repo has recorded as a defect class in its own right: a guard that is correct
// and never fires is not a guard, and one that mis-fires would reject a
// legitimate artifact whose first line happens to read like an HTTP error.
// PINNED as a disposition — if dsh is ever measured producing exit-0 failures,
// that is a new commit with the measurement attached.

// Timeout headroom for a text build. No caller has ever passed timeoutMs, so
// every build here silently ran under the adapter's generic default — while
// forge-runner.js, the OTHER build path, gives its builds 30 minutes because
// "builds run a real agent loop and need real headroom" (.env.example). A
// grounded build stacks research + skill resolution + a possible review-retry
// against that one budget. Defaulted here rather than threaded through three
// call sites, so no caller can forget it. Below forge-runner's 30 min: this path
// generates one artifact, not a tree.
function textBuildTimeoutMs() {
  return Number(process.env.DSH_TEXT_BUILD_TIMEOUT_MS) || 600000; // 10 min
}

function createBuildEngine(deps) {
  // RENAMED from deps.hermes (W6). The old name became a lie the moment the
  // engine stopped being Hermes, and a parameter named after a deleted program
  // is exactly the contradiction this repo treats as a defect.
  var engine = deps && deps.engine;
  var vault = deps && deps.vault;
  var bus = deps && deps.bus;
  if (!engine || typeof engine.runTask !== 'function') {
    throw new Error('createBuildEngine requires the dsh-agent adapter (deps.engine)');
  }

  // NO PROVIDER-ROTATION FORWARDING. Hermes rotated between provider slots
  // mid-build and this module forwarded that to the bus, because a build that
  // silently finished on a different model than the operator configured is
  // exactly the drift this module exists to stop.
  //
  // dsh-agent does not rotate. It selects ONE model from BRAIN_TABLES.build
  // before spawning, and logs `dsh-agent.lane-head-skipped` naming every lane
  // entry it passed over and why. Retrying the next entry after a failure would
  // need a classifier over dsh's error text to tell "this model is unavailable"
  // from "this task failed", and a wrong classification that also hides the real
  // diagnosis is worse than the original failure. So there is no rotation event
  // to forward, and no listener is registered for one.

  // The engine CLI needs a working directory. These calls are text-only — nothing
  // is supposed to be written — so they get a throwaway scratch dir rather than
  // a project dir. If the engine disobeys the output contract and writes anyway,
  // the damage is contained here instead of landing in a project and being
  // counted as build output by forge-runner's file-appearance oracle.
  // W6-AD-3 (2026-08-22) — THE UNDEFINED RETURN IS NOW A HARD FAILURE UPSTREAM.
  //
  // This used to return `undefined` on failure, and the comment on that line
  // said "no scratch dir -> adapter falls back to cwd inheritance". Under Hermes
  // that was merely untidy. Under dsh it would be a security problem: dsh adopts
  // its invoking directory as a WRITABLE workspace and loads that directory's
  // CLAUDE.md/AGENTS.md as agent instructions (41,412 bytes in this repo, both
  // loading in full), so inheriting MYTHOS's cwd would hand a build task this
  // repo's operating rules plus write access to the repository.
  //
  // The undefined return is KEPT — a vault that cannot make a directory is a
  // real condition and inventing a path would be worse — but `generate` now
  // refuses on it by name instead of passing it through, and dsh-agent's
  // requireCwd() throws as a second, independent line of defence.
  function scratchDir(source) {
    if (!vault || typeof vault.vaultPath !== 'function') return undefined;
    var slug = String(source || 'build').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
    var abs = vault.vaultPath(path.join('builds', '.engine-scratch', slug));
    try {
      if (typeof vault.ensureDir === 'function') vault.ensureDir(abs);
      else require('fs').mkdirSync(abs, { recursive: true });
    } catch (_) { return undefined; }
    return abs;
  }

  function cleanup(dir) {
    if (!dir) return;
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }

  // F5 (2026-08-15, operator ruling A) — THERE IS NO FALLBACK, BY DESIGN.
  //
  // A brainFallback() lived here from 2026-07-31: on a Hermes failure it
  // regenerated the content with brain.think({lane:'build'}), emitted
  // `build-engine-fallback-used`, and shipped the result as the build artifact.
  // Its comment argued the downstream verifier made that safe. It did not. On
  // 2026-08-14 it fired for real — vault/Checkpoints/build-jobs.json, job
  // job-1786743287677-62:
  //     "engine": "brain-fallback",
  //     "_verifyWarnings": [
  //       "Headline story 'OpenAI Launches \"GPT-5 Turbo\"' not found in provided HTML",
  //       "Content appears generic placeholder, lacking specific AI news items"
  //     ]
  // The verifier caught it and the job was recorded as done anyway. So the
  // guard that justified the fallback was real, correct, and ignored.
  //
  // This directly contradicted the repo's binding rule (root CLAUDE.md): Hermes
  // is the ONLY build-content engine and there is no brain.think fallback BY
  // DESIGN, because a build with no engine must FAIL with an install hint rather
  // than ship a plausible-but-wrong artifact. The operator ruled on 2026-08-15
  // to honour that rule rather than amend it.
  //
  // An engine failure therefore returns the offline result unchanged, and the
  // caller reports it. Do not reintroduce a second content engine here — if
  // builds need to work without the engine, that is a decision to change the
  // documented architecture, not a fallback to add quietly inside a catch.
  // W6 (2026-08-22): the ENGINE changed, the RULING did not. Ruling A survives
  // the swap — one build engine, no brain.think fallback — and this function is
  // re-pointed rather than relaxed. Anyone reading this after the Hermes
  // deletion should not conclude the ruling was quietly dropped along with the
  // program it originally named.
  //
  // BUG-321: the install hint used to be unconditional. On 2026-08-22 two builds
  // died at the 600s ceiling with a load-time crash, and the failure message
  // told the operator to reinstall — while the SAME audit line reported
  // state ONLINE, evidence "version-printed-and-matched-pin". The engine was
  // installed, pinned and version-matched; the task failed. Sending someone to
  // reinstall a correct install is misdirection, and it costs real time on the
  // one path where the operator is already blocked.
  //
  // getStatus() is synchronous and its `state` is what the probe concluded, so
  // this needs no extra round-trip. Anything other than a confident ONLINE keeps
  // the install instruction — an unknown state should err toward telling the
  // operator how to install, not toward silence.
  function engineFailed(offlineResult) {
    var err = (offlineResult && offlineResult.error) || 'the build engine is unavailable';
    var online = false;
    try {
      var st = typeof engine.getStatus === 'function' ? engine.getStatus() : null;
      online = !!(st && st.state === 'ONLINE');
    } catch (_) { online = false; }
    var tail = ' — DeepSeek Harness is the only build-content engine and there is no fallback. '
      + (online
        ? 'It is installed and version-matched, so this is a task failure, not a missing install.'
        : 'Install it with `node mythos/scripts/setup-dsh.js --install`.');
    return { offline: true, engine: 'dsh', error: err + tail };
  }

  // generate({ prompt, source, timeoutMs }) -> brain.think-shaped result.
  // Never throws: every failure becomes { offline: true, error } so callers can
  // keep the control flow they already have.
  async function generate(opts) {
    var o = opts || {};
    if (!o.prompt || !String(o.prompt).trim()) {
      return { offline: true, engine: 'dsh', error: 'build-engine: empty prompt' };
    }
    var full = OUTPUT_CONTRACT + '\n\n' + String(o.prompt);
    var dir = scratchDir(o.source);
    var offline;
    // W6-AD-3. Refuse rather than forward an absent scratch directory. dsh would
    // otherwise adopt MYTHOS's own cwd as a writable workspace and read this
    // repo's CLAUDE.md as agent instructions. The adapter throws on this too;
    // checking here means the message names the VAULT, which is the thing
    // actually broken, instead of naming dsh.
    if (!dir) {
      offline = { offline: true, engine: 'dsh',
        error: 'build-engine: could not create a scratch directory under the vault, and the '
          + 'engine must not inherit MYTHOS\'s working directory (dsh would treat it as a '
          + 'writable workspace and load this repo\'s CLAUDE.md as instructions). Check the '
          + 'vault path and permissions.' };
      return engineFailed(offline);
    }
    try {
      var reply = await engine.runTask(full, {
        cwd: dir,
        // autoApprove is DELIBERATELY ABSENT, which selects dsh's read-only
        // sandbox. OUTPUT_CONTRACT says "Do NOT create, write or modify any
        // files. Your reply IS the deliverable." Under Hermes that was a sentence
        // in a prompt plus a throwaway directory to contain the damage; under dsh
        // the sandbox itself refuses, so the contract is enforced rather than
        // requested. The scratch dir stays as a second line of defence.
        timeoutMs: o.timeoutMs || textBuildTimeoutMs(),
        maxPromptChars: 24000,
      });
      if (!reply || !String(reply).trim()) {
        // The adapter already rejects exit-0-with-empty-stdout, so reaching this
        // means a reply that was whitespace only. Kept because "empty artifact"
        // must never be returned as content.
        offline = { offline: true, engine: 'dsh', error: 'the build engine returned an empty reply' };
        return engineFailed(offline);
      }
      return { content: stripWholeReplyFence(reply), engine: 'dsh', offline: false, aborted: false };
    } catch (err) {
      var msg = String((err && err.message) || err);
      if (bus) bus.emit('health.anomaly', { kind: 'build-engine-failed', engine: 'dsh', error: msg });
      offline = { offline: true, engine: 'dsh', error: msg };
      return engineFailed(offline);
    } finally {
      cleanup(dir);
    }
  }

  return { generate: generate, OUTPUT_CONTRACT: OUTPUT_CONTRACT };
}

module.exports = {
  createBuildEngine: createBuildEngine,
  OUTPUT_CONTRACT: OUTPUT_CONTRACT,
  // HERMES_ERROR_REPLY_RE is gone, not renamed — see the note above
  // textBuildTimeoutMs(). dsh's exit code is its oracle, so there is nothing for
  // a re-export to point at.
  stripWholeReplyFence: stripWholeReplyFence,
};
