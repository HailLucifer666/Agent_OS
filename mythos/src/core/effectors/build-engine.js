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
var OUTPUT_CONTRACT = [
  'OUTPUT CONTRACT — read before doing anything:',
  '- Reply with the finished artifact content ONLY. No preamble, no summary, no commentary.',
  '- Do NOT create, write or modify any files. Your reply IS the deliverable.',
  '- Do not wrap the whole reply in a markdown code fence unless the artifact itself is fenced.',
].join('\n');

// Hermes reports provider failures on STDOUT with EXIT CODE 0 — observed
// live on 2026-07-29: a misconfigured provider produced the reply
//   "HTTP 401: Missing Authentication header"
// and, with a stale model slug,
//   "API call failed after 3 retries: HTTP 404: This model is unavailable..."
// Both looked like a perfectly successful run to the adapter. Without this
// guard that text becomes the artifact — the exact "reported success it didn't
// earn" failure this whole module exists to stop. These patterns are Hermes's
// own literal error prefixes, anchored to the start of the reply, not a
// general-purpose "does this look like an error" heuristic.
var HERMES_ERROR_REPLY_RE = /^\s*(?:API call failed after \d+ retries:|HTTP \d{3}:)/;

function createBuildEngine(deps) {
  var hermes = deps && deps.hermes;
  var vault = deps && deps.vault;
  var bus = deps && deps.bus;
  if (!hermes || typeof hermes.runTask !== 'function') {
    throw new Error('createBuildEngine requires the hermes-agent adapter');
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
    try {
      var reply = await hermes.runTask(full, {
        requireCli: true,       // the gateway cannot be cwd-pinned; builds need the CLI
        cwd: dir,
        timeoutMs: o.timeoutMs,
        maxPromptChars: 24000,
      });
      if (!reply || !String(reply).trim()) {
        return { offline: true, engine: 'hermes', error: 'Hermes returned an empty reply' };
      }
      if (HERMES_ERROR_REPLY_RE.test(String(reply))) {
        var reported = String(reply).trim().slice(0, 300);
        if (bus) bus.emit('health.anomaly', { kind: 'build-engine-provider-error', engine: 'hermes', error: reported });
        return { offline: true, engine: 'hermes', error: 'Hermes provider error (exit 0, error on stdout): ' + reported };
      }
      return { content: String(reply), engine: 'hermes', offline: false, aborted: false };
    } catch (err) {
      var msg = String((err && err.message) || err);
      if (bus) bus.emit('health.anomaly', { kind: 'build-engine-failed', engine: 'hermes', error: msg });
      // offline:true is how both call sites already recognise "no content" —
      // reusing it keeps their existing branch, and `error` carries the real
      // reason (usually the adapter's install hint) instead of a generic one.
      return { offline: true, engine: 'hermes', error: msg };
    } finally {
      cleanup(dir);
    }
  }

  return { generate: generate, OUTPUT_CONTRACT: OUTPUT_CONTRACT };
}

module.exports = { createBuildEngine: createBuildEngine, OUTPUT_CONTRACT: OUTPUT_CONTRACT };
