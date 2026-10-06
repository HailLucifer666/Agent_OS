'use strict';
const { effectorFromTool } = require('./adapter');
const { verifyConsent } = require('../leash/consent'); // BUG-446
const { remedy } = require('./evidence');

function buildTools({ controller } = {}) {
  // Catalog inspection needs declarations without constructing an execution runtime.
  const invoke = (method, args, ctx) => {
    if (!controller || typeof controller[method] !== 'function') return { ok: false, result: 'Desktop controller unavailable', notExecuted: true };
    return controller[method](args, { connectionId: ctx && ctx.connectionId, requestId: ctx && ctx.requestId });
  };
  // BUG-446 (2026-10-06): a started task is an ACTIVE goal that runs at once, so it
  // needs the operator's words (a consent token minted from them, voice/authority-
  // gate.js; never from model arguments). Without one nothing is created: a task
  // runs now or not at all, so there is no proposal form, and the message names
  // the next step.
  const startWithConsent = (args, ctx) => {
    if (!verifyConsent(ctx && ctx.consent, 'desktop_task_start', args).ok) {
      return { ok: false, notExecuted: true, result: 'Not started: a desktop task runs only when the operator asks for it in their own words this turn. Ask them what they want done first.', remedy: remedy('desktop_task_start', {}, 'start it only after the operator has said, in their own words, what to do', ['request']) };
    }
    return invoke('start', args, ctx);
  };
  return [
    { name: 'desktop_task_start', description: 'Start an observed desktop task. Stage 1 supports YouTube result 1 through 20 from a single observed list and pause/resume/next only. Missing or ambiguous results block without guessing. A started response is NOT completion; use desktop_task_status for observed evidence.',
      params: { request: 'string — explicit operator desktop request' }, danger: false, needs_result: true,
      fn: (args, ctx) => startWithConsent(args, ctx) },
    { name: 'desktop_task_status', description: 'Read a desktop task execution record, its current state and independent evidence. Blocked or unknown outcomes are not completion.',
      params: { taskId: 'string (optional) — returned task identifier; defaults to latest task in this process' }, danger: false, needs_result: true,
      fn: (args, ctx) => invoke('status', args, ctx) },
    { name: 'desktop_task_control', description: 'Pause, cancel, or explicitly resume a desktop task. Resume observes fresh state and never blindly repeats a write with unknown outcome. Pausing the task stops execution; to pause video playback request that through desktop_task_start.',
      params: { taskId: 'string — returned task identifier', action: 'string — pause, cancel, or resume' }, danger: false, needs_result: true,
      fn: (args, ctx) => invoke('control', args, ctx) },
  ];
}
function registerFromDesktop(hub, ctx) {
  const tools = buildTools(ctx);
  for (const tool of tools) hub.register(effectorFromTool(tool));
  return { count: tools.length };
}
module.exports = { buildTools, registerFromDesktop };
