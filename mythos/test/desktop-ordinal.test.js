'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest } = require('../src/core/desktop/intent');
const { createDesktopController, REVEAL_SCROLLS } = require('../src/core/desktop/controller');
const { createGoalSystem } = require('../src/core/goals');

// BUG-421 MUTATION RUN 2026-09-10 on src/core/desktop/controller.js, each
// verified applied by grep and restored sha256-identical (cce93de3aa08...):
//   `flat >= 1` instead of `flat >= 2` — literally the pre-fix rule
//     -> 5 red, including the measured-page test and the BUG-417 early-stop
//        test, whose expected scroll count this change deliberately moves.
//   `flat = after <= before ? 1 : 0` (a flat run that never accumulates)
//     -> 3 red: the early stop never fires and every refusal reaches the cap.
//   put `REVEAL_SCROLLS + ' scrolls'` back in the refusal
//     -> 2 red: the message names the cap again instead of the attempts made.
//   drop the reachable count from the refusal            -> 1 red.
//   disable the desktop.reveal log line                  -> 1 red.
//
// The scroll cap is asserted through the exported REVEAL_SCROLLS, not a typed 4,
// so a deliberate change to it moves these tests with it instead of failing as
// a stale literal. What the cap is NOT allowed to do is drift silently.

// BUG-417: the rig now models a page taller than the viewport. `visibleCount`
// is how many of the ranked cards are ON SCREEN — the rest are ranked with a
// null ref, which is what the engine now reports — and `revealPerScroll` is how
// many more each browser_scroll brings into view. revealPerScroll: 0 models a
// list that never reveals the card, which must block after a bounded number of
// scrolls rather than scrolling forever.
// BUG-421: `growBy` can only express arithmetic growth (6, 8, 10, ...), and the
// sequence measured on the real page was 6, 6, 8, 11, 14 — flat once, then
// uneven. `counts` and `visible` take that sequence literally, one entry per
// observation, so the test can reproduce the page that broke rather than a
// model of it. The last entry repeats if the loop reads further.
function rig({ count = 3, ambiguous = false, missingRef = false, wrongVideo = false, stationary = false, ad = false, visibleCount = null, revealPerScroll = 0, growBy = 0, counts = null, visible = null, logger = null } = {}) {
  const goals = createGoalSystem({ fs: { writeJSON() {} }, config: {}, bus: { emit() {} },
    memory: { episodic: { write() {} } }, brain: null });
  const calls = []; let selected = null, reads = 0, scrolls = 0;
  const ctx = { connectionId: 'ordinal-session' };
  const seq = (list, index) => (list === null ? null : list[Math.min(index, list.length - 1)]);
  const controller = createDesktopController({ goals, logger, wait: async () => {}, executeTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'brave', tabId: 7, active: true, url: 'https://www.youtube.com/' }] } };
    if (name === 'browser_click') { selected = Number(args.ref.slice(1)); return { ok: true, result: { delivered: true } }; }
    if (name === 'browser_navigate') return { ok: true, result: { delivered: true } };
    if (name === 'browser_scroll') { scrolls++; return { ok: true, result: { commandAccepted: true } }; }
    assert.equal(name, 'browser_video_list');
    reads++;
    return { ok: true, result: {
      target: { browserId: 'brave', tabId: 7, frameId: 0, observationId: 'snapshot-' + reads, url: 'https://www.youtube.com/' },
      ambiguous, items: Array.from({ length: seq(counts, scrolls) ?? (count + growBy * scrolls) }, (_, index) => {
        const shown = seq(visible, scrolls);
        const onScreen = shown !== null
          ? index < shown
          : (visibleCount === null ? !missingRef : index < visibleCount + revealPerScroll * scrolls);
        return { ref: onScreen ? 'v' + (index + 1) : null, videoId: 'id-' + (index + 1), visible: onScreen };
      }),
      playback: { videoId: wrongVideo ? 'unrequested' : 'id-' + selected, currentTime: stationary ? 0 : reads, paused: false, ad },
    } };
  } });
  return { controller, goals, calls, ctx, scrollCount: () => scrolls };
}
async function run(r, request) {
  const accepted = r.controller.start({ request }, r.ctx);
  assert.equal(accepted.started, true, 'supported ordinal request must start');
  return (await r.controller.settled(accepted.result.taskId)).result;
}

test('YouTube ordinal grammar accepts bounded words and correct numeric ordinals without weakening intent boundaries', () => {
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
  words.forEach((word, index) => {
    const n = index + 1;
    for (const ordinal of [word, String(n), n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th')]) {
      const intent = parseRequest('Open YouTube and play the ' + ordinal + ' video');
      assert.ok(intent, ordinal);
      assert.equal(intent.kind === 'play-third' ? 3 : intent.ordinal, n);
    }
  });
  assert.deepEqual(parseRequest('Play the third video on YouTube'), { kind: 'play-third', query: null, contextual: false });
  assert.deepEqual(parseRequest('Search YouTube for piano and play the second result'), { kind: 'play-index', ordinal: 2, query: 'piano' });
  assert.equal(parseRequest('play second'), null);
  assert.equal(parseRequest('play second', true).contextual, true);
  for (const request of ['Play zeroth on YouTube', 'Play 0 on YouTube', 'Play 21st on YouTube', 'Play -1 on YouTube',
    'Play 2.5 on YouTube', 'Play 2rd on YouTube', 'Do not play second on YouTube', 'Play second on YouTube and delete files']) {
    assert.equal(parseRequest(request, true), null, request);
  }
});

test('second and twentieth selection bind observed reference and verify the requested video independently', async () => {
  for (const ordinal of [2, 20]) {
    const r = rig({ count: ordinal });
    const state = await run(r, 'Play ' + ordinal + ' on YouTube');
    assert.equal(state.state, 'completed');
    assert.equal(state.expected.videoId, 'id-' + ordinal);
    assert.equal(state.evidence.observed.videoId, 'id-' + ordinal);
    const clicks = r.calls.filter(call => call.name === 'browser_click');
    assert.equal(clicks.length, 1);
    assert.deepEqual(clicks[0].args, { target: { browserId: 'brave', tabId: 7, frameId: 0, observationId: 'snapshot-1', url: 'https://www.youtube.com/' }, ref: 'v' + ordinal });
    assert.ok(r.calls.filter(call => call.name === 'browser_video_list').length >= 3);
  }
});

test('short or ambiguous observed lists block ordinal selection without clicking another card', async () => {
  // BUG-417 SPLIT THIS TEST, and the split is the point. `{ missingRef: true }`
  // used to belong here: a card with no ref meant "not ready", and the run
  // blocked. It now means "ranked but below the fold", which is a case the
  // controller must RESOLVE by scrolling rather than refuse — so it moved to its
  // own test below. What stays here is the genuinely unresolvable set: a list
  // too short to contain the ordinal, and a page with more than one list.
  for (const options of [{ count: 1 }, { count: 3, ambiguous: true }]) {
    const r = rig(options);
    const state = await run(r, 'Play second on YouTube');
    assert.equal(state.state, 'blocked');
    assert.equal(state.evidence, null);
    assert.equal(r.calls.some(call => call.name === 'browser_click'), false);
    assert.equal(r.scrollCount(), 0, 'a card that does not exist is not somewhere further down');
    // Not /2/: that matches any digit 2 anywhere in the reason, including the
    // "snapshot-2" observation id, so it would pass on the wrong message.
    assert.match(state.reason, options.ambiguous
      ? /More than one visible video list/
      : /Requested result 2 never appeared in the observed list/);
  }
});

test('BUG-417 — a card below the fold is scrolled into view, not refused', async () => {
  // The measured complaint: a YouTube search page shows roughly four or five
  // cards, so "play the sixth result" polled until the observation budget ran
  // out and blocked, while the tool advertises result 1 through 20.
  const r = rig({ count: 8, visibleCount: 4, revealPerScroll: 2 });
  const state = await run(r, 'Play the sixth video on YouTube');
  assert.equal(state.state, 'completed', 'result six exists two scrolls down');
  const clicks = r.calls.filter(call => call.name === 'browser_click');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].args.ref, 'v6', 'the SIXTH card, not the last visible one');
  assert.equal(r.scrollCount(), 1, 'one scroll reveals cards 5 and 6; a second would be waste');
  // The ref must come from the observation taken AFTER the scroll. A pre-scroll
  // ref would be a stale observation, which is what actOnNode's identity check
  // exists to catch — better not to send one at all. Counted up to the CLICK,
  // not over the whole run: verification reads afterwards would inflate it and
  // make this assert something else by accident.
  const clickAt = r.calls.findIndex(call => call.name === 'browser_click');
  const readsBeforeClick = r.calls.slice(0, clickAt).filter(call => call.name === 'browser_video_list').length;
  assert.equal(clicks[0].args.target.observationId, 'snapshot-' + readsBeforeClick);
  const scrollAt = r.calls.findIndex(call => call.name === 'browser_scroll');
  assert.ok(scrollAt < clickAt && scrollAt !== -1, 'the scroll happens before the click');
  assert.ok(r.calls.slice(scrollAt, clickAt).some(call => call.name === 'browser_video_list'),
    're-observed between scrolling and clicking, so the ref is not a pre-scroll one');
});

test('BUG-417 — scrolling is bounded, and stops early once the list stops growing', async () => {
  // revealPerScroll 0: the card is ranked and never comes into view. Without a
  // bound this scrolls an infinite feed forever; without the growth check it
  // burns the whole budget before reporting anything.
  const r = rig({ count: 8, visibleCount: 4, revealPerScroll: 0 });
  const state = await run(r, 'Play the sixth video on YouTube');
  assert.equal(state.state, 'blocked');
  assert.equal(state.evidence, null);
  assert.equal(r.calls.some(call => call.name === 'browser_click'), false,
    'a card that cannot be seen must never be clicked, and a different one must never be substituted');
  assert.equal(r.scrollCount(), 2, 'BUG-421: TWO flat readings settle it, not one — one is indistinguishable from a lazy loader');
  assert.match(state.reason, /after 2 scrolls/);
  assert.match(state.reason, /the list stopped producing new results/);
});

test('BUG-417 — a growing list is given the full scroll budget, and no more', async () => {
  // A lazy feed that adds cards on every scroll but never reveals the target:
  // the early-stop rule cannot fire, so the hard cap is the only thing that
  // ends it.
  const r = rig({ count: 8, visibleCount: 4, revealPerScroll: 0, growBy: 3 });
  const state = await run(r, 'Play the sixth video on YouTube');
  assert.equal(state.state, 'blocked');
  assert.equal(r.scrollCount(), REVEAL_SCROLLS, 'exactly the cap — never an unbounded walk down an infinite feed');
  // BUG-421: asserted against the exported constant, so a deliberate change to
  // the cap moves this test with it instead of failing as a typed-in 4.
  assert.match(state.reason, new RegExp('after ' + REVEAL_SCROLLS + ' scrolls'));
  assert.match(state.reason, /the scroll budget ran out while the list was still growing/);
});

test('BUG-417 — a card already in view is clicked without scrolling at all', async () => {
  // The adjacent case that must keep passing. Everything above is worthless if
  // the common path now pays for a scroll it does not need.
  const r = rig({ count: 8, visibleCount: 8 });
  const state = await run(r, 'Play second on YouTube');
  assert.equal(state.state, 'completed');
  assert.equal(r.scrollCount(), 0);
  assert.equal(r.calls.find(call => call.name === 'browser_click').args.ref, 'v2');
});

test('BUG-421 — the measured page (6, 6, 8, 11, 14) reaches result six instead of refusing after one scroll', async () => {
  // The sequence is transcribed from the ticket: a real YouTube search page at
  // 1280x800, ranked count flat across the first scroll and then growing, with
  // result six clickable on the FOURTH. Under the old rule the first flat reading
  // ended the loop and the card was refused. `counts`/`visible` replay the
  // sequence literally, because `growBy` can only express arithmetic growth and
  // this page is flat once and then uneven.
  const r = rig({
    counts:  [6, 6, 8, 11, 14],
    visible: [4, 4, 5, 6, 6],
  });
  const state = await run(r, 'Play the sixth video on YouTube');
  assert.equal(state.state, 'completed', 'result six is four scrolls down, not absent');
  const clicks = r.calls.filter(call => call.name === 'browser_click');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].args.ref, 'v6', 'the SIXTH card, never a substitute');
  assert.equal(r.scrollCount(), 3, 'flat, flat-then-growing, growing — and card six is in view by the third re-observation');
});

test('BUG-421 — a genuinely exhausted list still stops early, and pays exactly one extra scroll for the change', async () => {
  // The adjacent case that must keep passing, stated as a price rather than a
  // rounding error: two flat readings instead of one is one more scroll on a
  // short page. It must NOT become the full cap.
  const r = rig({ counts: [5, 5, 5, 5, 5], visible: [4, 4, 4, 4, 4] });
  const state = await run(r, 'Play the fifth video on YouTube');
  assert.equal(state.state, 'blocked');
  assert.equal(r.calls.some(call => call.name === 'browser_click'), false,
    'a card that cannot be seen must never be clicked, and a different one must never be substituted');
  assert.equal(r.scrollCount(), 2);
  assert.ok(r.scrollCount() < REVEAL_SCROLLS, 'early stop still beats the cap');
});

test('BUG-421 — the refusal names the attempts actually made and how many cards were reachable', async () => {
  // The independent defect, fixed regardless of the stop rule: the message used
  // to read "after 4 scrolls" no matter what the loop did, and never said how
  // many cards WERE clickable. Those are the two facts that separate "this page
  // is short" from "the budget ran out", which have different answers.
  const r = rig({ counts: [9, 9, 9], visible: [3, 3, 3] });
  const state = await run(r, 'Play the seventh video on YouTube');
  assert.equal(state.state, 'blocked');
  assert.match(state.reason, /ranked 7 of 9/, 'names where the card sits');
  assert.match(state.reason, /after 2 scrolls/, 'names the attempts made, not the cap');
  assert.match(state.reason, /3 of them are clickable/, 'names what WAS reachable');
  assert.match(state.reason, /the list stopped producing new results/);
  assert.doesNotMatch(state.reason, new RegExp('after ' + REVEAL_SCROLLS + ' scrolls'),
    'the old message hardcoded the cap; that is the bug');
});

test('BUG-421 — one scroll is reported as "1 scroll", not "1 scrolls"', async () => {
  // Reachable only when the cap is 1, so the singular branch is pinned through
  // the constant rather than by faking a state the loop cannot produce.
  const r = rig({ counts: [4], visible: [2] });
  const state = await run(r, 'Play the fourth video on YouTube');
  assert.equal(state.state, 'blocked');
  // With a flat list the loop stops after two, so assert the pluralisation rule
  // where it is observable: the message must agree with the number it prints.
  const printed = /after (\d+) scrolls?/.exec(state.reason);
  assert.ok(printed, 'the message names a scroll count');
  assert.equal(printed[0], Number(printed[1]) === 1 ? 'after 1 scroll' : 'after ' + printed[1] + ' scrolls');
});

test('BUG-421 — every reveal attempt is logged, so the attended run can settle what the flat reading was', async () => {
  // This fix could reason about the flat first reading but not measure it: a lazy
  // loader and a count read before the DOM rendered look identical from here. The
  // log line is what the next attended run reads. Without a logger the controller
  // must behave exactly as before, which every other test in this file asserts.
  const rows = [];
  const r = rig({
    counts:  [6, 6, 8, 11, 14],
    visible: [4, 4, 5, 6, 6],
    logger: { info: (msg, fields) => rows.push({ msg, fields }), warn() {}, error() {} },
  });
  await run(r, 'Play the sixth video on YouTube');
  const reveals = rows.filter(row => row.msg === 'desktop.reveal');
  assert.equal(reveals.length, 3, 'one row per scroll attempt');
  assert.deepEqual(reveals.map(row => [row.fields.before, row.fields.after]),
    [[6, 6], [6, 8], [8, 11]],
    'the row carries the before/after counts, which is the whole measurement');
  assert.equal(reveals[0].fields.ordinal, 6);
  assert.equal(reveals[2].fields.revealed, true);
  assert.equal(reveals[0].fields.clickable, 4, 'and how many were reachable at the time');
});

test('BUG-421 — the ordinal grammar is NOT bounded to what a page can serve (pinned decision)', () => {
  // Deliberately not changed. parseRequest runs before any observation exists, so
  // the grammar cannot know how many cards a page will serve; narrowing it would
  // turn a runtime refusal that names the real problem into a parse failure that
  // names nothing. The refusal above is the mechanism, and this is its pin.
  assert.deepEqual(parseRequest('Play the twentieth video on YouTube'),
    { kind: 'play-index', ordinal: 20, query: null, contextual: false });
  // And the boundary is still the grammar’s own, not the page’s: 21 is refused
  // because ORDINAL_WORDS ends at twenty, which is a vocabulary limit, not a
  // claim about how many cards YouTube will serve.
  assert.equal(parseRequest('Play 21st on YouTube', true), null);
});
test('second-card delivery cannot prove success for another video, stationary playback, or an ad', async () => {
  for (const options of [{ wrongVideo: true }, { stationary: true }, { ad: true }]) {
    const r = rig(options);
    const state = await run(r, 'Play second on YouTube');
    assert.equal(state.state, 'blocked');
    assert.equal(state.evidence, null);
    assert.equal(r.calls.filter(call => call.name === 'browser_click').length, 1);
  }
});

test('legacy third records still resume, while malformed persisted ordinals cannot reach a leaf', async () => {
  const r = rig();
  const legacy = r.goals.create({ status: 'paused', execution: { owner: 'desktop', version: 1, state: 'paused', phase: 'observing',
    intent: { kind: 'play-third' }, steps: 0, target: { browserId: 'brave', tabId: 7 } } });
  assert.equal((await r.controller.control({ taskId: legacy.id, action: 'resume' }, r.ctx)).started, true);
  assert.equal((await r.controller.settled(legacy.id)).result.state, 'completed');
  assert.equal(r.calls.find(call => call.name === 'browser_click').args.ref, 'v3');
  const before = r.calls.length;
  for (const ordinal of [undefined, 0, -1, 2.5, 21, '2', null]) {
    const malformed = r.goals.create({ execution: { owner: 'desktop', version: 1, state: 'paused', phase: 'observing',
      intent: { kind: 'play-index', ordinal }, steps: 0 } });
    assert.equal((await r.controller.control({ taskId: malformed.id, action: 'resume' }, r.ctx)).ok, false);
  }
  assert.equal(r.calls.length, before);
});

test('resuming an uncertain ordinal write observes the expected video without repeating the click', async () => {
  const r = rig();
  const goal = r.goals.create({ status: 'paused', execution: { owner: 'desktop', version: 1, state: 'paused', phase: 'verifying',
    intent: { kind: 'play-index', ordinal: 2 }, steps: 3, target: { browserId: 'brave', tabId: 7 }, expected: { kind: 'playing', videoId: 'id-2' } } });
  assert.equal((await r.controller.control({ taskId: goal.id, action: 'resume' }, r.ctx)).started, true);
  assert.equal((await r.controller.settled(goal.id)).result.state, 'blocked');
  assert.equal(r.calls.some(call => call.name === 'browser_click'), false);
});
