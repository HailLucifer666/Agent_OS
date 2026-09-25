'use strict';

// spoken-tool-syntax.js — BUG-449: the voice model spoke a tool call aloud.
//
// THE INCIDENT, 2026-09-23 14:13:16 (attended run, turn 50). The output
// transcription of what the operator heard began, verbatim:
//   call:web_search{maxResults:5,query:Nothing Phone (4a) Pro 256I completely
//   understand your frustration, Sir.
// The model rendered a function call as speech. The same reply ended "I'm
// searching specifically for the current Indian price… now", and no web_search
// followed that turn. A textual "call" is not a tool call: nothing was dispatched,
// and nothing in the claim checker treats a spoken call string as a claim.
//
// WHAT THIS DOES. Detects function-call syntax naming a REAL tool in a turn's
// output transcript and reports it as a `spoken-tool-syntax` anomaly, with the
// tool named and whether a real call of that tool ran in the same turn.
//
// WHAT IT NEVER DOES, BY CONSTRUCTION:
//   * It never executes anything. The parsed name is a LABEL on an anomaly row.
//     This file requires only the tier table (data), and its reporter's one side
//     effect is bus.emit('health.anomaly'); a test pins both. Running parsed
//     speech as a command would turn an audible glitch into an action nobody
//     authorised — the leash exists so that cannot happen.
//   * It never speaks. Same reasoning and the same shape as
//     promoted-rank-anomaly.js: the reporter is NOT routed through the adapter's
//     reportTurnAudit, every path of which ends in a spoken [SYSTEM] correction.
//     The healer acknowledges the kind (immune/known-conditions.js), so the
//     explainer is not asked to narrate it either.
//
// WHY A KNOWN TOOL NAME IS REQUIRED. The claim checker's rule applies: favour
// misses over false positives. "call: mom{" is not evidence of anything, while
// `call:web_search{` is unambiguous. The name set is DERIVED from the tier table
// (every tool the leash knows), not typed here, so a new tool is covered the day
// it is registered.
//
// WHAT IS NOT COVERED — PREVENTION. The text has already been heard when its
// transcript arrives; keeping it from reaching playback needs the validated text
// lane (plan decision D7, deferred). This is the detector half only, and BUG-449
// stays open on that account.

const { TIER_TABLE } = require('../leash/tiers');

const KNOWN_TOOLS = new Set(Object.keys(TIER_TABLE));
// The fragment kept on the anomaly row: enough to read the shape, bounded so a
// long reply cannot be copied wholesale into the vault.
const FRAGMENT_CHARS = 160;

// Call shapes, each capturing the tool name. Kept to shapes that do not occur in
// ordinary speech: a "call:" prefix, Gemini's code-style `default_api.` prefix,
// or a snake_case name immediately followed by an argument list that opens with
// `key:` or `key=`.
const CALL_SHAPES = [
  /\bcall\s*:\s*([a-z][a-z0-9_]*)\s*[{(]/gi,
  /\bdefault_api\s*\.\s*([a-z][a-z0-9_]*)\s*\(/gi,
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[{(]\s*["']?[a-z_][a-z0-9_]*["']?\s*[:=]/gi,
];

function detectSpokenToolSyntax(assistantText, actionsThisTurn) {
  const text = String(assistantText || '');
  if (!text) return [];
  const ran = new Set((Array.isArray(actionsThisTurn) ? actionsThisTurn : [])
    .filter((a) => a && a.tool).map((a) => a.tool));
  const byTool = new Map();
  for (const shape of CALL_SHAPES) {
    shape.lastIndex = 0;
    let m;
    while ((m = shape.exec(text)) !== null) {
      const tool = m[1].toLowerCase();
      if (!KNOWN_TOOLS.has(tool) || byTool.has(tool)) continue;
      byTool.set(tool, {
        tool,
        fragment: text.slice(m.index, m.index + FRAGMENT_CHARS),
        toolCallHappened: ran.has(tool),
      });
    }
  }
  return [...byTool.values()];
}

function reasonFor(hit) {
  return 'the reply spoke a ' + hit.tool + ' call aloud as text instead of calling the tool; '
    + (hit.toolCallHappened ? 'a real ' + hit.tool + ' call did run this turn' : 'no ' + hit.tool + ' call ran');
}

// `reason` is mandatory: immune/explainer.js narrates an unplaybooked anomaly from
// `target` + `reason`, and every detector in this family carries one.
function reportSpokenToolSyntax({ bus, assistantText, actionsThisTurn }) {
  if (!bus || typeof bus.emit !== 'function') return 0;
  const hits = detectSpokenToolSyntax(assistantText, actionsThisTurn);
  for (const hit of hits) {
    bus.emit('health.anomaly', {
      kind: 'spoken-tool-syntax', tool: 'spoken-tool-syntax', target: 'spoken-tool-syntax',
      claim: hit.fragment, spokenTool: hit.tool, toolCallHappened: hit.toolCallHappened,
      reason: reasonFor(hit),
    });
  }
  return hits.length;
}

module.exports = { detectSpokenToolSyntax, reportSpokenToolSyntax, reasonFor, FRAGMENT_CHARS };
