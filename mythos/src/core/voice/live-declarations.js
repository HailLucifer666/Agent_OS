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
  const { withheld, unavailable } = rebuildDeclarations();
  // Only the tool NAMES go to the session; withheld/unavailable are
  // reported here. Re-logging them on every rotation would turn a
  // once-per-session diagnostic into a recurring one. The rebuild also keeps
  // the unavailable set for the immediately following setup instruction.
  let unavailableNow = unavailable || [];
  const forSession = () => {
    const next = rebuildDeclarations(); unavailableNow = next.unavailable || [];
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

  function instructionBlock() {
    if (config.LIVE_VOICE_HONESTY_ENABLED === false || !unavailableNow.length) return '';
    const reasons = new Map();
    // Keep the measured missing entry inside the cap even when many OAuth
    // tools precede it in catalog order. No missing tool is invented here.
    const capped = [...unavailableNow].sort((a, b) => Number(b.name === 'browser_navigate') - Number(a.name === 'browser_navigate')).slice(0, 12);
    for (const item of capped) {
      if (!reasons.has(item.reason)) reasons.set(item.reason, []);
      reasons.get(item.reason).push(item.name);
    }
    return '\n\nUNAVAILABLE TOOLS (as of this session setup; do not claim they ran):\n'
      + [...reasons].map(([reason, names]) => names.join(', ') + ': ' + reason).join('\n')
      + (unavailableNow.length > 12 ? '\nAdditional unavailable tools omitted from this summary: ' + (unavailableNow.length - 12) + '.' : '');
  }
  return { forSession, instructionBlock };
}
module.exports = { createLiveDeclarations };
