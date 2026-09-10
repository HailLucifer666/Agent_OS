'use strict';

// golden-path.test.js — the judge inside scripts/golden-path.js, tested without a
// server, a browser or a network. The runner's value is the honesty of its four
// outcomes, so that is what is pinned here: a turn that spoke but proved nothing
// is UNVERIFIED and not PASS; an offline provider is PREREQ-MISSING and not FAIL;
// and the streak skips PREREQ days without resetting.
//
// Mutation probes, 2026-09-07 (each applied, seen to fail the named test, then
// restored):
//   (a) actionProves: drop the `p.unverified` check -> "unverified action is not
//       proof" fails.
//   (b) overallVerdict: return PASS for an empty list -> "zero steps is not a
//       pass" fails.
//   (c) streakOf: `continue` -> `break` on PREREQ -> "PREREQ days are skipped,
//       not reset" fails.
//   (d) 2026-09-07, second pass: verdictForStep, drop the onlyEmptyDone branch ->
//       "an empty done with nothing else observable is PREREQ-MISSING" fails.

const test = require('node:test');
const assert = require('node:assert/strict');

const gp = require('../scripts/golden-path.js');
const { VERDICT } = gp;

const step = { id: 'open', anyOf: ['open_web', 'browser_click'], oracle: 'media' };
const okAction = (tool) => ({ type: 'action', payload: { tool, ok: true, result: { ok: true } } });
const doneFrame = (extra) => Object.assign({ type: 'done', say: 'Playing it now.' }, extra || {});
const turnWith = (events, actions, ackMs) => ({ events, actions, timedOut: false, ackMs: ackMs === undefined ? 400 : ackMs });

test('requiring the runner drives nothing', () => {
  assert.equal(typeof gp.verdictForStep, 'function');
  // Five since 2026-09-11: a named-browser turn was added after this script
  // missed BUG-435's regression. Every step said "Open YouTube" with no browser
  // named, so it would have reported PASS while "open YouTube in Brave" opened
  // nothing at all. The count is asserted so a step cannot be quietly dropped —
  // which is exactly how an instrument stops measuring the thing that broke.
  assert.equal(gp.STEPS.length, 5);
  const named = gp.STEPS.find((s) => s.nameBrowser);
  assert.ok(named, 'the named-browser turn must survive: it is the one BUG-435 needed');
  assert.match(named.text, /\bBrave\b|\bChrome\b|\bEdge\b/, 'and it has to actually name a browser');
  assert.deepEqual(gp.STEPS.map((s) => s.id), ['open-named', 'open', 'pause', 'resume', 'next']);
});

test('a proven tool plus a playing oracle is PASS', () => {
  const r = gp.verdictForStep(step, turnWith([doneFrame()], [okAction('browser_click')]), { ok: true, playing: true, title: 'Video 3' });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.match(r.reason, /browser_click/);
  assert.match(r.reason, /Video 3/);
});

test('a reply with no matching ok action is UNVERIFIED, not PASS', () => {
  const r = gp.verdictForStep(step, turnWith([doneFrame()], [okAction('read_status')]), { ok: true, playing: true });
  assert.equal(r.verdict, VERDICT.UNVERIFIED);
});

test('unverified action is not proof', () => {
  const a = { type: 'action', payload: { tool: 'browser_click', ok: true, unverified: true } };
  assert.equal(gp.actionProves(a, step.anyOf), false);
  const inner = { type: 'action', payload: { tool: 'browser_click', ok: true, result: { ok: false } } };
  assert.equal(gp.actionProves(inner, step.anyOf), false);
  assert.equal(gp.actionProves(okAction('browser_click'), step.anyOf), true);
});

test('tool ok but oracle silent is FAIL; oracle unreadable is UNVERIFIED', () => {
  const turn = turnWith([doneFrame()], [okAction('open_web')]);
  assert.equal(gp.verdictForStep(step, turn, { ok: true, playing: false }).verdict, VERDICT.FAIL);
  assert.equal(gp.verdictForStep(step, turn, { ok: false, error: '401' }).verdict, VERDICT.UNVERIFIED);
  assert.equal(gp.verdictForStep(step, turn, null).verdict, VERDICT.UNVERIFIED);
});

test('a step without an oracle passes on tool proof alone', () => {
  const pause = { id: 'pause', anyOf: ['media_key'] };
  assert.equal(gp.verdictForStep(pause, turnWith([doneFrame()], [okAction('media_key')]), null).verdict, VERDICT.PASS);
});

test('offline provider and refused tool are PREREQ-MISSING, not FAIL', () => {
  assert.equal(gp.verdictForStep(step, turnWith([doneFrame({ offline: true, say: '' })], []), null).verdict, VERDICT.PREREQ);
  const refused = { type: 'action', payload: { tool: 'open_web', refused: 'browser adapter offline' } };
  const r = gp.verdictForStep(step, turnWith([doneFrame()], [refused]), null);
  assert.equal(r.verdict, VERDICT.PREREQ);
  assert.match(r.reason, /browser adapter offline/);
});

test('an empty done with nothing else observable is PREREQ-MISSING (routed into Live), not UNVERIFIED', () => {
  // Live shape, 2026-09-07: exactly one frame, type done, say '', no actions.
  const r = gp.verdictForStep(step, turnWith([{ type: 'done', say: '' }], []), null);
  assert.equal(r.verdict, VERDICT.PREREQ);
  assert.match(r.reason, /live-session/);
  // Adjacent cases that must keep their verdicts: a done that SAID something and
  // proved nothing is still UNVERIFIED; an empty done accompanied by another
  // frame is not the Live shape either.
  assert.equal(gp.verdictForStep(step, turnWith([doneFrame()], []), null).verdict, VERDICT.UNVERIFIED);
  assert.equal(gp.verdictForStep(step, turnWith([{ type: 'say', say: 'x' }, { type: 'done', say: '' }], []), null).verdict, VERDICT.UNVERIFIED);
});

test('probeCdp reports a refused port as a missing prerequisite, not a throw', async () => {
  const net = require('node:net');
  // Bind then close to obtain a port that is definitely not listening.
  const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const r = await gp.probeCdp('http://127.0.0.1:' + port);
  assert.equal(r.ok, false);
  assert.match(r.error, /no debuggable browser/);
  const bad = await gp.probeCdp('not a url');
  assert.equal(bad.ok, false);
});

test('timeout, missing done and turn error are FAIL', () => {
  assert.equal(gp.verdictForStep(step, { events: [], actions: [], timedOut: true }, null).reason, 'turn-timeout');
  assert.equal(gp.verdictForStep(step, turnWith([{ type: 'say', say: 'hi' }], []), null).reason, 'missing-done');
  assert.equal(gp.verdictForStep(step, turnWith([doneFrame({ error: 'boom' })], []), null).verdict, VERDICT.FAIL);
});

test('overall verdict: worst outcome wins, PREREQ above FAIL above UNVERIFIED', () => {
  const v = (list) => gp.overallVerdict(list.map((verdict, i) => ({ id: String(i), verdict, reason: '' })));
  assert.equal(v([VERDICT.PASS, VERDICT.PASS]), VERDICT.PASS);
  assert.equal(v([VERDICT.PASS, VERDICT.UNVERIFIED]), VERDICT.UNVERIFIED);
  assert.equal(v([VERDICT.UNVERIFIED, VERDICT.FAIL]), VERDICT.FAIL);
  assert.equal(v([VERDICT.FAIL, VERDICT.PREREQ]), VERDICT.PREREQ);
});

test('zero steps is not a pass', () => {
  assert.equal(gp.overallVerdict([]), VERDICT.PREREQ);
  assert.equal(gp.overallVerdict(undefined), VERDICT.PREREQ);
});

test('p95 picks the 95th percentile and tolerates empty input', () => {
  assert.equal(gp.p95([]), null);
  assert.equal(gp.p95([300]), 300);
  assert.equal(gp.p95([100, 200, 300, 400, 5000]), 5000);
  assert.equal(gp.p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
});

test('log line is one line, machine-splittable, and names every non-PASS step', () => {
  const results = [
    { id: 'open', verdict: VERDICT.PASS, reason: 'browser_click' },
    { id: 'pause', verdict: VERDICT.UNVERIFIED, reason: 'no ok action among media_key|browser_click' },
  ];
  const line = gp.formatLogLine('2026-09-07T10:00:00.000Z', VERDICT.UNVERIFIED, results, 812);
  assert.equal(line.split('\n').length, 1);
  const parts = line.split(' ');
  assert.equal(parts[0], '2026-09-07T10:00:00.000Z');
  assert.equal(parts[1], VERDICT.UNVERIFIED);
  assert.equal(parts[2], 'steps=1/2');
  assert.equal(parts[3], 'ackP95ms=812');
  assert.match(line, /pause=UNVERIFIED\(no_ok_action_among_media_key\|browser_click\)/);
  assert.match(gp.formatLogLine('t', VERDICT.PASS, [], null), /ackP95ms=n\/a/);
});

test('streak counts trailing PASS lines; a FAIL or UNVERIFIED resets it', () => {
  const L = (v) => '2026-09-07T00:00:00.000Z ' + v + ' steps=4/4 ackP95ms=500';
  assert.equal(gp.streakOf([]), 0);
  assert.equal(gp.streakOf([L('PASS'), L('PASS'), L('PASS')]), 3);
  assert.equal(gp.streakOf([L('PASS'), L('FAIL'), L('PASS')]), 1);
  assert.equal(gp.streakOf([L('PASS'), L('UNVERIFIED')]), 0);
});

test('PREREQ days are skipped, not reset', () => {
  const L = (v) => '2026-09-07T00:00:00.000Z ' + v + ' steps=0/4 ackP95ms=n/a';
  assert.equal(gp.streakOf([L('PASS'), L('PASS'), L('PREREQ-MISSING'), L('PASS')]), 3);
  assert.equal(gp.streakOf([L('FAIL'), L('PREREQ-MISSING')]), 0);
});
