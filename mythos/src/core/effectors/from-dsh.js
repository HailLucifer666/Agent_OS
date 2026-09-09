'use strict';

// effectors/from-dsh.js — delegate a coding/agent task to the build engine
// (adapters/dsh-agent, DeepSeek Harness). Tier 3 (confirm) — dsh executes real
// commands on this machine. Degrades honestly: when dsh isn't installed the tool
// fails with the install hint instead of pretending.
//
// RENAMED from from-hermes.js / hermes_task by W6 (2026-08-22). The tool name
// changed with the engine; it is NOT aliased (W6-AD-8: delete, don't stub). A
// `hermes_task` shim forwarding to `dsh_task` would be a lie about what runs,
// and `hermes_task` is in the leash's NEVER_TRUSTABLE set — a stale alias there
// is a safety surface, not just a naming wart. Both names had to move together;
// see leash/index.js and leash/tiers.js.

var os = require('os');
var fs = require('fs');
var path = require('path');
var effectorFromTool = require('./adapter').effectorFromTool;
var engine = require('../../../adapters/dsh-agent');
var { reasonText } = require('../util/reason-text');

var MAX_REPLY_CHARS = 20000; // build reports run long — 4000 truncated real output

function ok(r) { return { ok: true, result: r }; }
function fail(m) { return { ok: false, result: { error: m } }; }

// W6-AD-3. The old hermes_task called `runTask(task)` with NO cwd, so the agent
// inherited MYTHOS's own working directory. Under dsh that is not merely untidy:
// dsh adopts its invoking directory as a WRITABLE workspace and loads that
// directory's CLAUDE.md/AGENTS.md as agent instructions (41,412 bytes in this
// repo, both loading in full). An operator asking for "a coding task" would have
// handed the agent this repository's operating rules plus write access to it.
//
// So the task gets its OWN workspace, under a MYTHOS-owned root derived from the
// environment (root CLAUDE.md — no machine paths, no writes outside the
// project's own state directory). The directory is DELIBERATELY NOT DELETED
// afterwards and its absolute path is returned: an agent task's whole point is
// the work it leaves behind, and a tool that silently discards its output is
// worse than one that never ran.
//
// The workspace name is derived here, never from the tool's arguments. A
// model-supplied directory would be a path-traversal surface pointed straight at
// a write-enabled sandbox.
function taskWorkspaceRoot() {
  if (process.env.MYTHOS_DSH_TASK_ROOT) return process.env.MYTHOS_DSH_TASK_ROOT;
  var base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.local', 'state') : os.tmpdir());
  return path.join(base, 'MYTHOS', 'dsh-tasks');
}

function makeTaskWorkspace() {
  var root = taskWorkspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  // mkdtemp rather than a timestamp: two concurrent tasks must not collide, and
  // a collision here would let one task read and overwrite another's output.
  return fs.mkdtempSync(path.join(root, 'task-'));
}

function buildTools() {
  async function dsh_task(args) {
    var task = String((args && (args.task || args.prompt)) || '').trim();
    if (!task) return fail('task required — what the build engine should do');
    var ws;
    try {
      ws = makeTaskWorkspace();
    } catch (err) {
      // Naming the root matters: "could not create a workspace" with no path is
      // indistinguishable from "the engine is missing", and they need different
      // fixes.
      return fail('could not create a task workspace under ' + taskWorkspaceRoot()
        + ': ' + reasonText(err));
    }
    try {
      var selectedModel = null, reply = await engine.runTask(task, {
        cwd: ws,
        // An operator-delegated agent task is expected to write — that is what
        // distinguishes it from build-engine.generate, which runs read-only. The
        // sandbox still confines every write to `ws`.
        writeRoot: ws,
        autoApprove: true, onModelSelected: model => { selectedModel = model; },
      });
      if (!reply) return fail('the build engine returned an empty response');
      return ok({
        laneFallback: !!selectedModel?.rejected?.length,
        // BUG-431: another overlapping task can replace the adapter's global
        // model; keep this task's facts before the reply so truncation retains them.
        status: { ...engine.getStatus(), ...(selectedModel ? { model: selectedModel } : {}) },
        reply: reply.slice(0, MAX_REPLY_CHARS),
        workspace: ws,
        files: listWorkspace(ws),
      });
    } catch (err) {
      // Report the workspace on failure too. A task that wrote three files and
      // then hit a timeout has left work worth looking at, and a bare error
      // message would hide it.
      return fail(reasonText(err) + ' [workspace: ' + ws + ']');
    }
  }

  return [
    { name: 'dsh_task',
      description: 'Delegate a coding or multi-step agent task to the build engine (DeepSeek Harness), running in its own sandboxed workspace directory. Use for heavy coding work. Returns the reply plus the workspace path and the files it wrote. Fails with an install hint when the engine is unavailable.',
      params: { task: 'string — the task/prompt for the build engine' },
      danger: true,
      fn: dsh_task }
  ];
}

// Relative paths, so the reply names files rather than leaking the whole
// absolute tree into a spoken or logged result. Best-effort: a workspace we
// cannot read is not a reason to discard a successful reply.
function listWorkspace(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(function (e) { return e.isFile(); })
      .map(function (e) { return path.relative(dir, path.join(e.parentPath || e.path || dir, e.name)); })
      .slice(0, 200);
  } catch (_) {
    return [];
  }
}

function registerFromDsh(hub) {
  var tools = buildTools();
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { registerFromDsh: registerFromDsh, buildTools: buildTools };
