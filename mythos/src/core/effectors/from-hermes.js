'use strict';

// effectors/from-hermes.js — P7 Jarvis upgrade: delegate a coding/agent task
// to the optional hermes-agent sidecar (adapters/hermes-agent). Tier 3
// (confirm) — hermes executes real commands on this machine. Degrades
// honestly: when hermes isn't installed/running the tool fails with the
// install hint instead of pretending.

var effectorFromTool = require('./adapter').effectorFromTool;
var hermes = require('../../../adapters/hermes-agent');
var { reasonText } = require('../util/reason-text');

var MAX_REPLY_CHARS = 20000; // build reports run long — 4000 truncated real output

function ok(r) { return { ok: true, result: r }; }
function fail(m) { return { ok: false, result: { error: m } }; }

function buildTools() {
  async function hermes_task(args) {
    var task = String((args && (args.task || args.prompt)) || '').trim();
    if (!task) return fail('task required — what hermes should do');
    try {
      var reply = await hermes.runTask(task);
      if (!reply) return fail('hermes returned an empty response');
      return ok({ reply: reply.slice(0, MAX_REPLY_CHARS), status: hermes.getStatus() });
    } catch (err) {
      return fail(reasonText(err));
    }
  }

  return [
    { name: 'hermes_task', description: 'Delegate a coding or multi-step agent task to the hermes-agent sidecar (self-improving coding agent with its own learning loop and skills). Use for heavy coding work when hermes is installed. Fails with an install hint when the sidecar is unavailable.', params: { task: 'string — the task/prompt for hermes' }, danger: true, fn: hermes_task }
  ];
}

function registerFromHermes(hub) {
  var tools = buildTools();
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { registerFromHermes: registerFromHermes, buildTools: buildTools };
