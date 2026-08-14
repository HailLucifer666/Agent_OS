'use strict';

// effectors/build-engine.js — the single content-generation engine for builds.
//
// WHY THIS EXISTS. MYTHOS grew three independent build engines: build-runner.js
// (brain.think, driving pipeline_execute/kanban_build_card/start_project/
// run_mission), engagements/executor.js (a second, unqueued brain.think call
// site), and Forge/hermes-runner.js (the external Hermes CLI). Three engines
// meant three behaviours, and the brain-backed ones produced the fabricated
// "Week of November 20, 2023" landing page that the reality-checker rejected.
// This module collapses content generation onto Hermes-Agent so there is one
// engine with one behaviour.
//
// NO FALLBACK — deliberate. When Hermes is unavailable a build FAILS with the
// adapter's install hint. It does not quietly regenerate through brain.think.
// A wrong-but-plausible artifact is worse than a missing one: the whole reason
// this repo keeps getting burned is work that reports success it didn't earn.
//
// BRAIN FALLBACK (2026-07-31): a guarded fallback to brain.think was added for
// the case where Hermes is WIRED (HERMES_CLI set, provider configured) but
// transiently unreachable at runtime (binary moved, provider outage, network).
// Distinct from the original "no fallback" stance, which was about not hiding
// an UNWIRED Hermes behind silent brain output. With Hermes wired and verified,
// a brain fallback on transient offline is safer than hard-failing every build
// — and the downstream verifier.verify() gate (build-runner.js) still rejects
// fabricated/garbage output, so the "no reported success it didn't earn"
// principle holds. Anomaly-emitted + engine-stamped so a fallback is visible.
//
// RETURN SHAPE is intentionally brain.think-compatible
// ({ content, offline, aborted, ... }) so the existing call sites keep their
// null/offline checks, their verifier gate, their retry and their review step
// unchanged. This is a swap of the generator, not a rewrite of the pipeline.

var path = require('path');

// Hermes is agentic: left to itself it may write files and reply with a prose
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

// Hermes reports provider failures on STDOUT with EXIT CODE 0 — a misconfigured
// provider replies "HTTP 401: Missing Authentication header" and looks like a
// perfectly successful run. Without this guard that text becomes the artifact:
// the exact "reported success it didn't earn" failure this module exists to
// stop.
//
// The pattern MOVED to adapters/hermes-agent on 2026-08-03 and is imported here
// rather than redefined. Provider rotation in the adapter has to classify the
// identical shape, and two independently-maintained copies of a safety regex is
// how one of them quietly stops matching. One definition, two consumers.
var HERMES_ERROR_REPLY_RE = require('../../../adapters/hermes-agent').HERMES_ERROR_REPLY_RE;

// Timeout headroom for a text build. No caller has ever passed timeoutMs, so
// every build here silently ran under the hermes adapter's generic 3-minute
// default (HERMES_TASK_TIMEOUT_MS) — while hermes-runner.js, the OTHER Hermes
// path, gives its builds 30 minutes because "builds run a real agent loop and
// need real headroom" (.env.example). A grounded build stacks research + skill
// resolution + a possible review-retry against that one budget. Defaulted here
// rather than threaded through three call sites, so no caller can forget it.
// Below hermes-runner's 30 min: this path generates one artifact, not a tree.
function textBuildTimeoutMs() {
  return Number(process.env.HERMES_TEXT_BUILD_TIMEOUT_MS) || 600000; // 10 min
}

function createBuildEngine(deps) {
  var hermes = deps && deps.hermes;
  var vault = deps && deps.vault;
  var bus = deps && deps.bus;
  var brain = deps && deps.brain; // optional — for the guarded offline fallback
  if (!hermes || typeof hermes.runTask !== 'function') {
    throw new Error('createBuildEngine requires the hermes-agent adapter');
  }

  // Provider rotation happens inside the adapter, which has no bus (no adapter
  // in this repo emits health.anomaly directly). Forward it here, where the bus
  // lives, so a mid-build provider swap is VISIBLE. A build that silently
  // finished on a different model than the operator configured is exactly the
  // drift this module was created to stop — rotation is a recovery, not a
  // non-event.
  if (bus && typeof hermes.onProviderRotated === 'function') {
    hermes.onProviderRotated(function (evt) {
      bus.emit('health.anomaly', {
        kind: 'hermes-provider-rotated',
        engine: 'hermes',
        from: evt.from, to: evt.to, reason: evt.reason,
        fromProvider: evt.fromProvider, toProvider: evt.toProvider,
      });
    });
  }

  // Hermes's CLI needs a working directory. These calls are text-only — nothing
  // is supposed to be written — so they get a throwaway scratch dir rather than
  // a project dir. If Hermes disobeys the output contract and writes anyway,
  // the damage is contained here instead of landing in a project and being
  // counted as build output by hermes-runner's file-appearance oracle.
  function scratchDir(source) {
    if (!vault || typeof vault.vaultPath !== 'function') return undefined;
    var slug = String(source || 'build').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
    var abs = vault.vaultPath(path.join('builds', '.engine-scratch', slug));
    try {
      if (typeof vault.ensureDir === 'function') vault.ensureDir(abs);
      else require('fs').mkdirSync(abs, { recursive: true });
    } catch (_) { return undefined; }   // no scratch dir → adapter falls back to cwd inheritance
    return abs;
  }

  function cleanup(dir) {
    if (!dir) return;
    try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }

  // Brain fallback for when Hermes is transiently unreachable. Only used when
  // brain is wired AND the failure looks like a runtime/availability issue
  // (not an empty-prompt programmer error, which should stay a hard error).
  // Returns brain.think's result tagged engine:'brain-fallback', or the
  // original offline result if brain is absent or also fails. The downstream
  // verifier.verify() gate (build-runner.js) still vets the content, so this
  // never ships unaudited output.
  async function brainFallback(prompt, source, offlineResult) {
    if (!brain || typeof brain.think !== 'function') return offlineResult;
    try {
      var r = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: source || 'build-engine-fallback',
      });
      if (r && r.content) {
        if (bus) bus.emit('health.anomaly', { kind: 'build-engine-fallback-used', engine: 'brain-fallback', hermesError: offlineResult && offlineResult.error });
        // Same fence strip as the Hermes path: a fenced reply is a model habit,
        // not a Hermes quirk, so the guarded fallback needs it too.
        return { content: stripWholeReplyFence(r.content), engine: 'brain-fallback', offline: false, aborted: !!r.aborted };
      }
      // brain itself returned offline — propagate the combined failure honestly.
      return { offline: true, engine: 'hermes', error: 'Hermes offline (' + (offlineResult && offlineResult.error) + ') and brain also offline (' + (r && r.error) + ')' };
    } catch (e) {
      return { offline: true, engine: 'hermes', error: 'Hermes offline (' + (offlineResult && offlineResult.error) + '); brain fallback threw: ' + ((e && e.message) || e) };
    }
  }

  // generate({ prompt, source, timeoutMs }) -> brain.think-shaped result.
  // Never throws: every failure becomes { offline: true, error } so callers can
  // keep the control flow they already have.
  async function generate(opts) {
    var o = opts || {};
    if (!o.prompt || !String(o.prompt).trim()) {
      return { offline: true, engine: 'hermes', error: 'build-engine: empty prompt' };
    }
    var full = OUTPUT_CONTRACT + '\n\n' + String(o.prompt);
    var dir = scratchDir(o.source);
    var offline;
    try {
      var reply = await hermes.runTask(full, {
        requireCli: true,       // the gateway cannot be cwd-pinned; builds need the CLI
        cwd: dir,
        timeoutMs: o.timeoutMs || textBuildTimeoutMs(),
        maxPromptChars: 24000,
      });
      if (!reply || !String(reply).trim()) {
        offline = { offline: true, engine: 'hermes', error: 'Hermes returned an empty reply' };
        return await brainFallback(full, o.source, offline);
      }
      if (HERMES_ERROR_REPLY_RE.test(String(reply))) {
        var reported = String(reply).trim().slice(0, 300);
        if (bus) bus.emit('health.anomaly', { kind: 'build-engine-provider-error', engine: 'hermes', error: reported });
        offline = { offline: true, engine: 'hermes', error: 'Hermes provider error (exit 0, error on stdout): ' + reported };
        return await brainFallback(full, o.source, offline);
      }
      return { content: stripWholeReplyFence(reply), engine: 'hermes', offline: false, aborted: false };
    } catch (err) {
      var msg = String((err && err.message) || err);
      if (bus) bus.emit('health.anomaly', { kind: 'build-engine-failed', engine: 'hermes', error: msg });
      offline = { offline: true, engine: 'hermes', error: msg };
      return await brainFallback(full, o.source, offline);
    } finally {
      cleanup(dir);
    }
  }

  return { generate: generate, OUTPUT_CONTRACT: OUTPUT_CONTRACT };
}

module.exports = {
  createBuildEngine: createBuildEngine,
  OUTPUT_CONTRACT: OUTPUT_CONTRACT,
  HERMES_ERROR_REPLY_RE: HERMES_ERROR_REPLY_RE,
  stripWholeReplyFence: stripWholeReplyFence,
};
