'use strict';

// test/bug-323-tool-suggestions-respect-word-boundaries.test.js — BUG-323.
//
// THE LAST INSTANCE OF THE BUG-309 CLASS, and the one the 2026-08-22 audit filed
// rather than fixed. effectors/hub.js's nearestToolNames() scored a candidate as
// a near-match with a BIDIRECTIONAL RAW SUBSTRING test:
//
//   lower.indexOf(wanted) !== -1 || wanted.indexOf(lower) !== -1   -> score 1
//
// score 1 is the best non-exact tier, and ties break toward the SHORTER name, so
// a short tool name embedded anywhere inside a longer requested name was
// promoted to the top of the "did you mean" list.
//
// MEASURED FIRST, against the real hub with a realistic name set (2026-08-23).
// The audit's framing was WRONG and is corrected here: it called this a
// "tool-selection scorer" with "a documented history of tool-selection races".
// It selects nothing. It only writes the suggestion text on the unknown-tool
// FAILURE path — invoke() has already decided to fail before it is called. So
// this is a bad-suggestion defect, not a wrong-dispatch defect, and it is fixed
// because it is the same class as the root cause, not because it was severe.
//
// 12 probes, 10 good suggestions, 1 false positive, 1 empty:
//
//   open_web_page        -> open_web       good      (segment-aligned prefix)
//   read_status_of_build -> read_status    good
//   web_search_news      -> web_search     good
//   draggable_reorder    -> drag           good      (prefix of a segment)
//   essay_write          -> say            FALSE     ('say' inside 'essay')
//   statuss              -> (none)         see below
//
// THE RULE THAT KEEPS ALL TEN AND KILLS THE ONE. Tool names in this tree are
// snake_case identifiers, so the honest boundary is the segment: a containment
// counts only when the match begins at index 0 or immediately after an
// underscore. 'drag' inside 'draggable_reorder' starts at 0 and survives; 'say'
// inside 'essay_write' starts at index 2 and does not.
//
// DELIBERATELY NOT keyword-match.js, which BUG-309 added. That module does
// English morphology — plural/gerund endings, negation windows — because it
// matches prose specs. These are identifiers. Reusing it here would apply
// stemming to tool names, which is a different and wrong question.
//
// 'statuss' returning nothing is NOT changed and is not a defect: only
// 'read_status' is registered, edit distance from 'statuss' to it is 4, past the
// name/3 threshold. Widening that threshold to catch it would re-admit the noise
// this fix removes. The ALIASES table is the mechanism for known misnames.
//
// Run: cd mythos && node --test test/bug-323-tool-suggestions-respect-word-boundaries.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createEffectorHub } = require('../src/core/effectors/hub');

// Real registered names, taken from the effectors in this tree (the short ones
// are what make this bug reachable at all: jwt, drag, say, look, mythos).
const REGISTERED = [
  'jwt', 'drag', 'say', 'look', 'mythos', 'project', 'spotify',
  'ui_type', 'ui_click', 'click_at', 'open_web', 'note_read', 'note_take',
  'web_fetch', 'web_search', 'read_file', 'launch_app', 'job_status',
  'read_status', 'open_artifact', 'open_folder', 'browser_navigate',
];

function hubWith(names) {
  const hub = createEffectorHub({ bus: { emit() {} }, config: {} });
  // register(), not registerNamed(): named services go into a SEPARATE map that
  // nearestToolNames() does not read, so registering that way would make every
  // assertion below pass on an empty candidate set.
  for (const n of names || REGISTERED) {
    hub.register({ id: n, invoke: async () => ({ ok: true }) });
  }
  return hub;
}

async function suggest(hub, name) {
  const r = await hub.invoke(name, {}, {});
  assert.equal(r.ok, false, 'the probe name must be unregistered for this to test anything');
  return r.suggestions;
}

describe('BUG-323 — a tool suggestion must match on a segment boundary', () => {
  it('a short tool name buried mid-word is no longer suggested', async () => {
    // THE FAILING CASE. 'say' is a real registered effector and 'essay' really
    // does contain it. On HEAD this returned ['say'].
    const hub = hubWith();
    const out = await suggest(hub, 'essay_write');
    assert.ok(!out.includes('say'),
      "'say' appears inside 'essay' by accident, not by meaning: " + JSON.stringify(out));
  });

  it('every genuinely useful suggestion measured on HEAD still survives', async () => {
    // THE REGRESSION HALF, and the reason this is a boundary rule rather than a
    // ban on short names or on the reverse direction. Each of these was verified
    // to be produced by HEAD before the fix; a fix that loses them is worse than
    // the false positive it removes.
    const hub = hubWith();
    const cases = [
      ['open_web_page', 'open_web'],
      ['read_status_of_build', 'read_status'],
      ['web_search_news', 'web_search'],
      ['spotify_pause', 'spotify'],
      ['jwt_decode_token', 'jwt'],
      ['look_at_screen', 'look'],
      ['project_manager_list', 'project'],
      ['mythos_restart_everything', 'mythos'],
      // 'drag' is a prefix of the SEGMENT 'draggable', not a whole segment —
      // this is the case that rules out "split on _ and compare segments".
      ['draggable_reorder', 'drag'],
    ];
    for (const [asked, expected] of cases) {
      const out = await suggest(hub, asked);
      assert.ok(out.includes(expected),
        'asked ' + asked + ' — expected ' + expected + ' among ' + JSON.stringify(out));
    }
  });

  it('the reverse direction still works when it lands on a boundary', async () => {
    // A candidate CONTAINING the request is the useful half of the bidirectional
    // rule (a truncated name), and it is kept — bounded the same way.
    const hub = hubWith(['web_search', 'read_status', 'open_artifact']);
    assert.ok((await suggest(hub, 'search')).includes('web_search'),
      "'search' begins right after the underscore in 'web_search'");
    assert.ok(!(await suggest(hub, 'earch')).includes('web_search'),
      "'earch' starts mid-segment and is a typo for nothing");
  });

  it('an exact name is never routed through suggestions at all', async () => {
    // Pins that the fix did not disturb dispatch. A registered name must invoke.
    const hub = hubWith();
    const r = await hub.invoke('web_search', {}, {});
    assert.equal(r.ok, true, 'a registered tool must still be dispatched');
  });

  it('a close typo is still caught by edit distance, which the boundary rule must not shadow', async () => {
    // The second tier is untouched. 'web_serch' shares no segment-aligned
    // substring with 'web_search' long enough to matter — it is caught because
    // it is one deletion away, and that path must keep working.
    const hub = hubWith();
    const out = await suggest(hub, 'web_serch');
    assert.ok(out.includes('web_search'), 'one-character typo must still resolve: ' + JSON.stringify(out));
  });

  it('the suggestion list stays bounded and ordered', async () => {
    // Behaviour nearestToolNames() already had; asserted so the rewrite cannot
    // quietly drop the limit or the shorter-name tie-break.
    const hub = hubWith();
    const out = await suggest(hub, 'note_reader');
    assert.ok(out.length <= 3, 'at most three suggestions: ' + JSON.stringify(out));
    assert.equal(out[0], 'note_read', 'the segment-aligned match ranks first');
  });

  it('nothing plausible produces no suggestion rather than a wrong one', async () => {
    const hub = hubWith();
    assert.deepEqual(await suggest(hub, 'zzzzqqqq'), []);
  });
});
