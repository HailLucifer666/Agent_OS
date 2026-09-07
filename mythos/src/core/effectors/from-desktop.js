'use strict';
const { effectorFromTool } = require('./adapter');

function buildTools({ controller } = {}) {
  // Catalog inspection needs declarations without constructing an execution runtime.
  const invoke = (method, args, ctx) => {
    if (!controller || typeof controller[method] !== 'function') return { ok: false, result: 'Desktop controller unavailable', notExecuted: true };
    return controller[method](args, { connectionId: ctx && ctx.connectionId, requestId: ctx && ctx.requestId });
  };
  return [
    { name: 'desktop_task_start', description: 'Start an observed desktop task. Stage 1 supports YouTube third-result playback and pause/resume/next only. A started response is NOT completion; use desktop_task_status for observed evidence.',
      params: { request: 'string — explicit operator desktop request' }, danger: false, needs_result: true,
      fn: (args, ctx) => invoke('start', args, ctx) },
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
