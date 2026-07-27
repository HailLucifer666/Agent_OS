'use strict';

// skills/run-skill-tool.js — run a skill's real CLI tool, gracefully degrading.
//
// Problem this solves: build-pack.js and the build lane previously loaded a
// skill's SKILL-CORE.md *summary* but never ran the skill's actual tooling.
// For ui-ux-pro-max that means Mythos substituted a weaker home-grown design
// resolver (design/system.js) for the skill's real scripts/search.py backed by
// its full CSV database (192 palettes / 84 styles / 74 font pairings). This
// module lets the build lane invoke the real thing automatically.
//
// Contract: NEVER block a build on a missing skill or missing runtime. If the
// skill isn't installed, the file is absent, or Python/executable is missing,
// return null and let the caller fall back to its existing resolver. Mirrors
// the agent-reach availability pattern in agent-actions.js (probe once, cache,
// degrade silently). A failure here is an invitation to use the substitute,
// not a build failure.

var fs = require('fs');
var { execFile } = require('child_process');
var loader = require('./loader');

// Cache of interpreter availability so we don't re-probe every build.
// Key: interpreter name ('python' / 'python3' / 'node' / ...). Value: bool.
var interpreterCache = {};

// Probe whether an interpreter is on PATH (resolves within ~3s). Cached so the
// first build on a given machine pays the probe cost; subsequent builds don't.
function interpreterAvailable(name) {
  if (interpreterCache[name] !== undefined) return Promise.resolve(interpreterCache[name]);
  return new Promise(function(resolve) {
    execFile(name, ['--version'], { timeout: 3000, windowsHide: true }, function(err) {
      interpreterCache[name] = !err;
      resolve(interpreterCache[name]);
    });
  });
}

// Resolve which interpreter to use for a script by extension. Today: .py →
// python (Windows) / python3 (Unix); .js → node. Returns null for unknown.
function interpreterFor(scriptPath) {
  if (/\.py$/i.test(scriptPath)) {
    return process.platform === 'win32' ? 'python' : 'python3';
  }
  if (/\.js$/i.test(scriptPath)) return 'node';
  return null;
}

// Run a skill's CLI tool. Args:
//   skillName  — allowlisted skill dir name (e.g. 'ui-ux-pro-max')
//   scriptRel  — path to the script relative to the skill dir (e.g. 'scripts/search.py')
//   args       — array of CLI args to pass after the script path
//   opts       — { timeoutMs?: number (default 20000), maxBuffer?: number (default 1MB) }
// Returns: Promise<string|null> — the script's stdout on success, or null on
// any failure (skill missing, script missing, interpreter missing, non-zero
// exit, timeout). Never throws.
async function runSkillTool(skillName, scriptRel, args, opts) {
  opts = opts || {};
  // Resolve the dir that ACTUALLY contains the script. Skills are often
  // vendored repo-local as essence-only (SKILL-CORE.md, no scripts/), while
  // their runnable tooling lives in ~/.zcode — resolveSkillFile checks both
  // and returns the one holding the requested file.
  var dir = loader.resolveSkillFile(skillName, scriptRel);
  if (!dir) return null;                           // skill or script not installed anywhere
  var scriptPath = dir + '/' + scriptRel;          // forward slashes work cross-platform in execFile

  var interp = interpreterFor(scriptRel);
  if (!interp) return null;                        // unknown script type
  var hasInterp = await interpreterAvailable(interp);
  if (!hasInterp) return null;                     // Python/Node not on PATH

  return new Promise(function(resolve) {
    execFile(
      interp,
      [scriptPath].concat(args || []),
      {
        timeout: opts.timeoutMs || 20000,
        maxBuffer: opts.maxBuffer || (1024 * 1024),
        windowsHide: true,
        cwd: dir,                                  // run from the skill dir so relative data/ paths resolve
      },
      function(err, stdout) {
        if (err) return resolve(null);             // non-zero exit / timeout / signal — degrade
        var out = String(stdout || '').trim();
        resolve(out || null);
      }
    );
  });
}

// Synchronous availability probe (no run) — lets a caller decide up front
// whether to attempt the real tool or go straight to the fallback, without
// paying the execFile round-trip when the answer is obviously no.
function skillToolAvailable(skillName, scriptRel) {
  return loader.resolveSkillFile(skillName, scriptRel) !== '';
}

// Test hook: reset the interpreter cache (availability can change during a
// long-lived process if the operator installs Python mid-session).
function _resetCache() {
  interpreterCache = {};
}

module.exports = {
  runSkillTool: runSkillTool,
  skillToolAvailable: skillToolAvailable,
  interpreterAvailable: interpreterAvailable,
  _interpreterFor: interpreterFor,
  _resetCache: _resetCache,
};
