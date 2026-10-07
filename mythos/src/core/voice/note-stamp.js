'use strict';
// note-stamp.js — BUG-300's disclaimer, appended to a note written in a turn where
// no tool verified anything (live-tool-adapter.js stampProvenanceIfUnbacked).
//
// Moved out of live-tool-adapter.js on 2026-10-07 so voice/authority-gate.js can
// read a held note back WITHOUT it. Independent review finding, same date: the
// stamp is added before the hold (so the consent token binds the text actually
// written), and the read-back target then demanded every word of the disclaimer
// too. A model reading back only the note body never counted as having asked, so
// the operator's "yes" approved nothing. The token still binds the stamped text;
// only what the operator must hear excludes it.
const UNBACKED_NOTE_STAMP = '\n\n[Recorded from conversation — not verified by any tool '
  + 'during this exchange.]';

function withoutStamp(text) {
  const s = String(text || '');
  return s.endsWith(UNBACKED_NOTE_STAMP.trim()) ? s.slice(0, s.lastIndexOf(UNBACKED_NOTE_STAMP.trim())).trim() : s;
}

module.exports = { UNBACKED_NOTE_STAMP, withoutStamp };
