'use strict';
// BUG-424: a superseded turn must stay silent, whether the operator or our next
// system notice interrupted it (BUG-432). System-initiated greetings and alerts
// remain speakable. This does not serialize notices or filter native Live audio.
const { STARTED_MESSAGE } = require('./action-evidence-ledger');
const { NO_SUCCESS_CLAIM, SYSTEM_NOTICE_PREFIX } = require('./narration-claims');
const ENVELOPE_RE = /^\s*(?:response|functionResponse|tool_response)\s*:\s*\w+\s*\{/i;
function silentTurnWithheld({ text, interrupts }) {
  if (interrupts > 0) return 'superseded';
  const s = String(text || '');
  if (ENVELOPE_RE.test(s) || [STARTED_MESSAGE, NO_SUCCESS_CLAIM, SYSTEM_NOTICE_PREFIX].some(v => s.includes(v))) return 'tool-envelope';
  return null;
}
module.exports = { silentTurnWithheld };
