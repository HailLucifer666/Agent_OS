'use strict';
// BUG-423: declaration loss must reach the setup instruction. No realtimeInput
// is injected; buildSetup calls forSession before instructionBlock each time.
// Legacy batch voice rereads capabilities per turn and remains unchanged.
const { buildFunctionDeclarations } = require('./live-tools');
const { buildCapabilitySnapshot } = require('./tool-capability');
function createLiveDeclarations({ config, effectors, logger, desktop, desktopRuntime,
  browserAgentAdapter, cuaDriverAdapter, pcChild, androidChildAdapter, conversationToolAllowed, rebuild }) {
  const rebuildDeclarations = rebuild || (() => buildFunctionDeclarations(effectors, {
    allowlist: String(config.LIVE_TOOL_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Do not declare a tool whose machinery is absent on this machine.
    // The freshly installed build fired gmail_unread / media_status /
    // spotify_status before the operator had spoken, against credentials
    // and adapters the install does not have. Built HERE, per session, not
    // at boot: an adapter that comes online later must become declarable
    // on the next session without a restart. See core/voice/tool-capability.js.
    capability: buildCapabilitySnapshot({
      config,
      // The adapter modules are singletons holding their own connection
      // state, and pc-child is already require()d at the top of this file
      // for exactly that reason. getStatus() is a pure read; requiring
      // these starts nothing.
      adapters: {
        browser: config.DESKTOP_OPERATOR_ENABLED ? desktopRuntime?.getBridge() || { getStatus: () => ({ state: 'OFFLINE' }) } : browserAgentAdapter,
        cua: cuaDriverAdapter,
        pcChild,
        android: androidChildAdapter,
      },
    }),
    log: (m) => logger.info('live-tools', { detail: m }),
  }));
  const { withheld, unavailable, needsSetup } = rebuildDeclarations();
  // Only the tool NAMES go to the session; withheld/unavailable are
  // reported here. Re-logging them on every rotation would turn a
  // once-per-session diagnostic into a recurring one. The rebuild also keeps
  // the unavailable set for the immediately following setup instruction.
  let unavailableNow = unavailable || [];
  // needsSetup are DECLARED tools whose gate a step in this session can clear.
  // Tracked beside unavailableNow rather than merged into it: the instruction
  // block must say two different things, and the whole 2026-09-10 browser
  // failure was these two states being treated as one.
  let needsSetupNow = needsSetup || [];
  const forSession = () => {
    const next = rebuildDeclarations();
    unavailableNow = next.unavailable || [];
    needsSetupNow = next.needsSetup || [];
    return next.declarations.filter(d => !desktop || conversationToolAllowed(d.name));
  };
  if (withheld.length) logger.info('live-tools.withheld', { count: withheld.length });
  // Logged as its own event, not folded into the line above: "withheld by
  // curation" and "withheld because this machine cannot do it" are
  // different findings and only one of them is a setup problem.
  if (unavailable && unavailable.length) {
    logger.warn('live-tools.unavailable', {
      count: unavailable.length,
      tools: unavailable.map((u) => u.name),
      reasons: [...new Set(unavailable.map((u) => u.reason))],
    });
  }

  function group(items) {
    const reasons = new Map();
    for (const item of items) {
      if (!reasons.has(item.reason)) reasons.set(item.reason, []);
      reasons.get(item.reason).push(item.name);
    }
    return [...reasons].map(([reason, names]) => names.join(', ') + ': ' + reason).join('\n');
  }

  function instructionBlock() {
    if (config.LIVE_VOICE_HONESTY_ENABLED === false) return '';
    if (!unavailableNow.length && !needsSetupNow.length) return '';
    let out = '';
    if (unavailableNow.length) {
      // The browser_navigate sort key that used to live here is GONE, and saying
      // so is the point. It existed (BUG-423) to keep that one measured entry
      // inside the 12-item cap. browser_navigate can no longer reach this list —
      // its rule is selfHealing, so it lands in needsSetup below — which made the
      // sort a comparator that could never fire again: dead code reading as live
      // defence. If the browser rule ever loses selfHealing, this list gets it
      // back and the cap becomes a real risk again; the test named in
      // tool-capability.js is what would catch that.
      const capped = unavailableNow.slice(0, 12);
      out += '\n\nUNAVAILABLE TOOLS (as of this session setup; do not claim they ran):\n' + group(capped)
        + (unavailableNow.length > 12 ? '\nAdditional unavailable tools omitted from this summary: ' + (unavailableNow.length - 12) + '.' : '');
    }
    if (needsSetupNow.length) {
      // Declared, callable, and honest about the order. This paragraph is the
      // half that was missing on 2026-09-10: the model held browser_launch_debug,
      // used it correctly, and had no idea the navigate tools existed because
      // they had been withheld rather than described.
      out += '\n\nTOOLS THAT NEED A STEP FIRST (they ARE available to call — do the step, then call them):\n'
        + group(needsSetupNow.slice(0, 12))
        + (needsSetupNow.length > 12 ? '\nAdditional such tools omitted: ' + (needsSetupNow.length - 12) + '.' : '');
    }
    return out;
  }
  return { forSession, instructionBlock };
}
module.exports = { createLiveDeclarations };
