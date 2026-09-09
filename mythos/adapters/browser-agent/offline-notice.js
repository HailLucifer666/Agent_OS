'use strict';
// State-change fanout only. Deliberate disconnects never call notifyOffline;
// repeat speech suppression belongs to the existing conversation announcer.
const listeners = new Set();
function onOffline(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notifyOffline(reason, logger) {
  for (const fn of listeners) {
    try { fn({ reason }); }
    catch (err) { if (logger) logger.warn('browser-agent offline notification failed', { error: err.message }); else process.emitWarning(err); }
  }
}
module.exports = { onOffline, notifyOffline };
