'use strict';

// goal-authority.js — did the operator's own words ask for a goal? Pure, no
// imports from the runtime, so it can be tested on strings (BUG-446, 2026-10-06).
//
// WHY. The operator's decision (2026-10-06): background goal work runs "when I ask
// it to, and when the app is running". The cortex runs any ACTIVE goal on its own
// tick, so a goal becomes active only through the operator. Two model-callable
// tools could make one: `create_goal` (a new active goal) and `toggle_goal`
// (reopening a done one). This judge decides, from the operator's transcript for
// THIS turn, whether they asked; voice/authority-gate.js mints a consent token
// (leash/consent.js) only on a yes. Not asked is not an error: the effector then
// saves an inert proposal instead.
//
// Narrow on purpose: this turn's words only (no "earlier they said"), an explicit
// request, not negated, not hypothetical, not quoted, not a denial, and more than
// a bare command (the model would be choosing what the goal is). English only:
// words in another language ask nothing here, and the result is a proposal.
// The goal's TITLE is not bound to the words — the operator asked for "a goal" and
// the model words it (pinned by test); `remember` binds its text, goals do not.

const { DENIAL_RE, countWords } = require('./operator-authority');

const SHORT_INPUT_MAX_WORDS = 4;

const GOAL_NOUN = '(?:goal|goals|to-?do|to-?dos|task|tasks)';
const CREATE_RE = new RegExp([
  '\\b(?:create|add|make|set up|set|start|open|log|put|save|track|note)\\b(?:\\s+[\\w\'-]+){0,4}?\\s+' + GOAL_NOUN + '\\b',
  '\\bnew ' + GOAL_NOUN + '\\b',
  '\\bmy (?:goal|to-?do) (?:is|for [\\w ]{1,20} is)\\b',
].join('|'), 'i');
const REOPEN_RE = new RegExp([
  '\\b(?:re-?open|un-?complete|un-?finish|un-?mark|un-?tick|un-?check|toggle)\\b',
  '\\bmark\\b[^.?!]{0,60}\\b(?:not (?:done|finished|complete)|incomplete|undone|active|open)\\b',
].join('|'), 'i');
// A desktop task is one the operator names by what it does (the controller's own
// parser accepts only YouTube open / play result N / pause / resume / next).
const DESKTOP_RE = /\b(?:play|open|watch|pause|resume|skip|start|launch|put on|go to|next)\b/i;
const NEGATED_RE = /\b(?:don'?t|do not|never|no need to|not|stop)\b(?:\s+[\w'-]+){0,3}?\s+(?:create|add|make|set|start|open|reopen|re-open|toggle|mark|play|watch|pause|resume|skip|launch)\b/i;
const HYPOTHETICAL_RE = /\b(?:what if|suppose|supposing|imagine|hypothetically|if I (?:say|said|tell|told|ask|asked))\b/i;
const QUOTED_RE = /["“‘][^"”’]{0,200}["”’]/g;

function plain(text) {
  return String(text || '').replace(/[’‘ʼ]/g, "'").replace(/\s+/g, ' ');
}

// { tool: 'create_goal' | 'toggle_goal', current: this turn's operator words }
// -> { proceed: boolean, reason: string }. Any other tool never proceeds. Also
// covers 'desktop_task_start' (BUG-446, 2026-10-06: it creates an active goal).
function judgeGoalRequest({ tool, current } = {}) {
  const said = plain(current).trim();
  if (!said) return { proceed: false, reason: 'no-operator-words' };
  if (DENIAL_RE.test(said)) return { proceed: false, reason: 'operator-objected' };
  const asked = said.replace(QUOTED_RE, ' ');
  if (HYPOTHETICAL_RE.test(asked)) return { proceed: false, reason: 'not-a-request' };
  if (NEGATED_RE.test(asked)) return { proceed: false, reason: 'operator-declined' };
  const re = tool === 'create_goal' ? CREATE_RE : tool === 'toggle_goal' ? REOPEN_RE : tool === 'desktop_task_start' ? DESKTOP_RE : null;
  if (!re || !re.test(asked)) return { proceed: false, reason: 'not-requested' };
  // A desktop request IS the task ("play result 3"), so a short one is a request;
  // a goal's title is the model's, so a bare "add a goal" is not.
  if (tool !== 'desktop_task_start' && countWords(said) <= SHORT_INPUT_MAX_WORDS) return { proceed: false, reason: 'bare-command' };
  return { proceed: true, reason: 'operator-request' };
}

module.exports = { judgeGoalRequest };
