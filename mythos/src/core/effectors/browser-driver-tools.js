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
  // BUG-462 review, 2026-10-27. `params` is read by describeMeta() on every
  // catalog build, by validate() on every dispatch, and by JSON.stringify() when
  // a tool is logged. A bridge probe that throws used to throw out of all three -
  // so a browser-extension problem would take down the whole tool catalog (and
  // the voice session that builds from it) instead of simply withholding
  // `target`. A probe that cannot answer has not found a bridge: degrade, never
  // propagate.
  const bridgeNow = () => { try { return getBridge(); } catch (_) { return null; } };
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
    // BUG-462 side-finding (2026-10-06). `target` is the extension path's argument. It
    // used to be added to the schema unconditionally, so on a machine with no
    // extension bridge the model was handed a param that could only produce the
    // "desktop-owned task" refusal (browser_snapshot, 02:16:41 on 2026-09-25, with
    // CDP attached). It is now offered only while getBridge() returns a bridge, and
    // read LIVE through a getter: the bridge is created by desktopRuntime.start()
    // after registration, and describeMeta() reads tool.params on every catalog
    // build. A tool with no CDP fn (the media tools) already carries its own
    // `target`. Attack: a Live session that declared the schema before the bridge
    // went away can still send target - that call is refused below, and the
    // message now names the way forward instead of ending the turn.
    const wrapped = { ...tool, needs_result: true,
      async fn(args = {}, ctx = {}) {
        const desktop = isDesktopTask(ctx.goalId);
        if (!desktop && !args.target && tool.fn) return tool.fn(args, ctx);
        if (!desktop) return { ok: false, result: 'A desktop-owned task is required for extension browser control. To use the attached debug browser instead, call ' + tool.name + ' again without target.', notExecuted: true };
        const bridge = bridgeNow();
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
    Object.defineProperty(wrapped, 'params', { enumerable: true, get: () => (tool.fn && bridgeNow() ? { ...tool.params, target: TARGET } : tool.params) });
    return wrapped;
  });
}
module.exports = { withBrowserDriver };
