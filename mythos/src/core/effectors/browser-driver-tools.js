'use strict';

// The catalog remains singular. Existing installations retain their CDP tools;
// desktop-owned calls use the extension and never fall through to another profile.
const OPERATIONS = {
  browser_tabs: 'tabs', browser_navigate: 'navigate', browser_click: 'click',
  browser_snapshot: 'observe', browser_scroll: 'scroll',
  browser_video_list: 'videoList', browser_media_state: 'mediaState',
  browser_media_control: 'mediaControl',
};
const TARGET = 'object (optional) - exact target capsule returned by the last observation';
function withBrowserDriver(tools, { getBridge = () => null, isDesktopTask = () => false } = {}) {
  const added = [
    { name: 'browser_video_list', description: 'Observe the selected existing browser tab and its relevant video list. Ads and separately labeled Shorts do not count. References expire when the document changes.', params: { browserId: 'string - observed browser identity', tabId: 'number - observed tab identity', frameId: 'number (optional) - frame identity' } },
    { name: 'browser_media_state', description: 'Read current video identity, advertisement state, playback time and pause state from a bound tab. One sample alone does not prove playback.', params: { target: 'object - exact observed target capsule' } },
    { name: 'browser_media_control', description: 'Request pause, play, resume or next on the bound YouTube player. Acceptance does not establish playback; observe and verify afterward.', params: { target: 'object - exact observed target capsule', action: 'string - pause, play, resume, or next' } },
  ];
  return [...tools, ...added].map((tool) => {
    if (!OPERATIONS[tool.name]) return { ...tool, fn: (args = {}, ctx = {}) =>
      isDesktopTask(ctx.goalId) || args.target
        ? { ok: false, result: 'This browser operation is not supported by the extension driver yet', notExecuted: true }
        : tool.fn(args, ctx) };
    return { ...tool, needs_result: true,
      params: { ...tool.params, ...(tool.fn ? { target: TARGET } : {}) },
      async fn(args = {}, ctx = {}) {
        const desktop = isDesktopTask(ctx.goalId);
        if (!desktop && !args.target && tool.fn) return tool.fn(args, ctx);
        if (!desktop) return { ok: false, result: 'A desktop-owned task is required for extension browser control', notExecuted: true };
        const bridge = getBridge();
        if (!bridge) return { ok: false, result: 'Browser extension is not configured. Complete local extension setup first.', notExecuted: true };
        let op = OPERATIONS[tool.name];
        if (tool.name === 'browser_scroll') {
          if (!['up', 'down'].includes(args.direction)) return { ok: false, result: 'Direction must be "up" or "down".', notExecuted: true };
          args = { ...args, deltaY: args.direction === 'down' ? 600 : -600 };
        }
        if (tool.name === 'browser_tabs' && args.action && args.action !== 'list') {
          if (args.action !== 'new') return { ok: false, result: 'This extension tab action is not supported yet', notExecuted: true };
          op = 'createTab';
        }
        const result = await bridge.execute(op, args, { taskId: ctx.goalId, signal: ctx.signal });
        return result?.ok === false && result.result == null ? { ...result, result: result.error || result.code || 'Extension operation failed' } : result;
      },
    };
  });
}
module.exports = { withBrowserDriver };
