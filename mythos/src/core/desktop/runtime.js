'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createDesktopController } = require('./controller');
const { registerFromDesktop } = require('../effectors/from-desktop');
const { dispatchAction } = require('../effectors/dispatch-action');
const { childRuntimeDir } = require('../util/child-runtime');

function createDesktopRuntime({ goals, effectors, leash, memory, config, bus, logger }) {
  const connections = new Set();
  const signals = new Map();
  const owners = new Map();
  let bridge = null;
  const controller = createDesktopController({ goals, executeTool: async (tool, args, ctx) => {
    if (!connections.has(ctx.connectionId) || ctx.signal?.aborted) return { ok: false, result: 'Operator connection is no longer active', notExecuted: true };
    const goal = goals.get(ctx.goalId);
    if (goal?.execution?.owner !== 'desktop' || goal.execution.state !== 'running') return { ok: false, result: 'Desktop task does not own execution', notExecuted: true };
    owners.set(ctx.goalId, ctx.connectionId);
    if (bridge && signals.get(ctx.goalId) !== ctx.signal) {
      const resumed = await bridge.beginTask(ctx.goalId);
      if (!resumed.ok || ctx.signal.aborted) return { ok: false, result: resumed.error || 'Task was interrupted', notExecuted: true };
      signals.set(ctx.goalId, ctx.signal);
    }
    const decision = { tool, args, rationale: 'Observed desktop task step' };
    const verdict = leash.check(decision, { goalId: ctx.goalId, connectionId: ctx.connectionId });
    if (!verdict.allow) return { ok: false, result: verdict.reason || 'Action requires confirmation', confirmPending: !!verdict.requireConfirm, notExecuted: true };
    return dispatchAction(decision, { ...ctx, tier: verdict.tier, channel: 'desktop', traceId: ctx.goalId, effectors, goals, memory, config, bus });
  } });
  registerFromDesktop(effectors, { controller });
  const unsubscribe = bus.subscribe('browser.extension.user-takeover', event => {
    const taskId = event.payload.taskId, connectionId = owners.get(taskId);
    if (connectionId) controller.control({ taskId, action: 'pause' }, { connectionId }).catch(error => logger.warn('desktop.takeover-failed', { error: error.message }));
  });
  return {
    controller,
    getBridge: () => bridge,
    bind(connectionId) { connections.add(connectionId); },
    watch(connectionId, listener) {
      let closed = false;
      const unsubscribe = bus.subscribe('goal.updated', event => {
        const task = controller.status({ taskId: event.payload.id }, { connectionId });
        if (task.ok) listener(task);
      });
      // Discovery is read-only. Reconnection never starts a persisted task.
      queueMicrotask(() => {
        const task = controller.status({}, { connectionId });
        if (!closed && task.ok) listener(task);
      });
      return () => { closed = true; unsubscribe(); };
    },
    async unbind(connectionId) {
      connections.delete(connectionId);
      await controller.disconnect(connectionId);
      for (const [taskId, owner] of owners) {
        if (owner === connectionId) { owners.delete(taskId); signals.delete(taskId); }
      }
    },
    async start() {
      if (!config.DESKTOP_OPERATOR_ENABLED) return;
      const runtimeDir = process.env.MYTHOS_BROWSER_EXTENSION_RUNTIME_DIR || path.join(childRuntimeDir(), 'browser-extension');
      const setupPath = path.join(runtimeDir, 'browser-extension-setup.json');
      if (!fs.existsSync(setupPath)) { logger.warn('desktop.setup-required', { reason: 'Complete explicit local browser extension setup' }); return; }
      const setup = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
      bridge = require('../../../adapters/browser-extension').createBrowserExtensionBridge({ runtimeDir, allowedExtensionIds: setup.allowedExtensionIds, bus, logger });
      try { await bridge.start(); } catch (error) { bridge = null; throw error; }
    },
    async stop() {
      unsubscribe();
      await Promise.all([...connections].map(connectionId => this.unbind(connectionId)));
      await bridge?.stop(); bridge = null;
    },
  };
}
module.exports = { createDesktopRuntime };
