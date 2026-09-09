'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest } = require('../src/core/desktop/intent');
const { createDesktopController } = require('../src/core/desktop/controller');
const { createGoalSystem } = require('../src/core/goals');

function rig({ count = 3, ambiguous = false, missingRef = false, wrongVideo = false, stationary = false, ad = false } = {}) {
  const goals = createGoalSystem({ fs: { writeJSON() {} }, config: {}, bus: { emit() {} },
    memory: { episodic: { write() {} } }, brain: null });
  const calls = []; let selected = null, reads = 0;
  const ctx = { connectionId: 'ordinal-session' };
  const controller = createDesktopController({ goals, wait: async () => {}, executeTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'brave', tabId: 7, active: true, url: 'https://www.youtube.com/' }] } };
    if (name === 'browser_click') { selected = Number(args.ref.slice(1)); return { ok: true, result: { delivered: true } }; }
    if (name === 'browser_navigate') return { ok: true, result: { delivered: true } };
    assert.equal(name, 'browser_video_list');
    reads++;
    return { ok: true, result: {
      target: { browserId: 'brave', tabId: 7, frameId: 0, observationId: 'snapshot-' + reads, url: 'https://www.youtube.com/' },
      ambiguous, items: Array.from({ length: count }, (_, index) => ({ ref: missingRef ? null : 'v' + (index + 1), videoId: 'id-' + (index + 1) })),
      playback: { videoId: wrongVideo ? 'unrequested' : 'id-' + selected, currentTime: stationary ? 0 : reads, paused: false, ad },
    } };
  } });
  return { controller, goals, calls, ctx };
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
  for (const options of [{ count: 1 }, { count: 3, ambiguous: true }, { missingRef: true }]) {
    const r = rig(options);
    const state = await run(r, 'Play second on YouTube');
    assert.equal(state.state, 'blocked');
    assert.equal(state.evidence, null);
    assert.equal(r.calls.some(call => call.name === 'browser_click'), false);
    // Not /2/: that matches any digit 2 anywhere in the reason, including the
    // "snapshot-2" observation id, so it would pass on the wrong message.
    assert.match(state.reason, options.ambiguous
      ? /More than one visible video list/
      : /Requested playable result 2 did not become ready/);
  }
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
