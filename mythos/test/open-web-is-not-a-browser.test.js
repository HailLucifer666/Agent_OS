'use strict';

// 2026-08-09, incident inc-1786236365947-3: "Multitasking task failed:
// open_web(search) did not open a browser window as user expected (widget open
// instead)."
//
// Nothing is broken. open_web is a dashboard-widget renderer BY DESIGN, and its
// own failure strings have said so for a while. The defect is the NAME: to a
// model choosing a tool from a list, "open_web" reads as "open the web", so it
// wins any request phrased as searching or browsing. The remedy is text — the
// description has to lead with what the tool is NOT, because a disclaimer in the
// last sentence of a long description loses to a name in the first word.
//
// A prompt/description regression is invisible at runtime and cannot be caught
// by any behavioural test, since the behaviour is correct and always was. This
// gate is the only thing standing between a future tidy-up of that wording and a
// repeat of the same incident.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/core/effectors/from-dashboard');
const { RULES } = require('../src/core/voice/voice-agent');

function openWebDescription() {
  const { TOOLS: tools } = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
  });
  const tool = tools.find((t) => t.name === 'open_web');
  assert.ok(tool, 'open_web must still be registered in from-dashboard.js');
  return String(tool.description);
}

describe('open_web tells the model, up front, that it is not a browser', () => {
  it('the description leads with the negative, not with "open web content"', () => {
    const d = openWebDescription();
    // "leads with" is the whole point: the correction has to arrive before the
    // model has finished reading the name and moved on.
    const opening = d.slice(0, 160);
    assert.match(opening, /does NOT open a browser/i,
      'open_web\'s description must say it does NOT open a browser within its first sentence — '
      + 'a caveat at the end loses to the tool\'s own name. Got: ' + opening);
    assert.match(opening, /inside the mythos dashboard/i,
      'the description must name where the content actually goes (the MYTHOS dashboard)');
  });

  it('the description names browser_navigate as the tool for real browsing', () => {
    assert.match(openWebDescription(), /browser_navigate/,
      'a rule that says "not this tool" without naming the right one is a dead end — '
      + 'this repo has fixed that exact shape twice (BUG-099, BUG-107)');
  });

  it('the voice system prompt carries a BROWSER RULE separating browse from render', () => {
    assert.match(RULES, /BROWSER RULE/,
      'RULES must carry a standalone BROWSER RULE. The guidance existed only as the last '
      + 'clause of BROWSER CONTROL RULE, a paragraph otherwise about tab handling — and the '
      + 'model still chose open_web for "search the web".');
    const rule = RULES.slice(RULES.indexOf('BROWSER RULE'));
    const firstPara = rule.slice(0, rule.indexOf('\n\n') === -1 ? rule.length : rule.indexOf('\n\n'));
    assert.match(firstPara, /search the web/i,
      'the rule must name the phrasing that actually misfired ("search the web for X")');
    assert.match(firstPara, /browser_navigate/,
      'the rule must name browser_navigate as the answer');
  });
});
