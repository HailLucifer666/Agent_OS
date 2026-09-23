'use strict';

// test/bug-451-provenance.test.js — BUG-451: lessons recorded guesses as causes.
//
// 2026-09-23, attended run. The healer's lesson recorded a SYMPTOM: "browser_click
// on specific element refs/selectors (e.g., f5e1537, f5e298) fails repeatedly".
// The model's note_take recorded a CAUSE: "…those elements can become stale very
// quickly due to page re-renders. A browser_snapshot should be taken immediately
// before each browser_click…". The cause was wrong (the reference was invented —
// BUG-445), and the goal planner reads lessons back as instructions.
//
// THE RULE (src/core/memory/provenance.js): the server labels each remembered
// sentence from its text — 'hypothesis' if it states a cause, 'observation' if it
// reports what happened — and no writer can produce 'verified'. The planner reads
// observations only. A note MYTHOS writes carries its label on the entry.
//
// The real texts below are verbatim from the operator's vault; the records
// themselves were NOT edited (they are the operator's data — see BUGS.md).
//
// RED FIRST, 2026-09-23, against dd239233 (HEAD's files restored in place, then
// re-hashed identical): all 10 of the first 10 failed. (f) first PASSED there,
// vacuously — the fixture recorded the symptom first, and the old planner line cut
// the text at 180 characters before the guess appeared. The fixture now records
// the guess first, and (f) fails on the old code for the stated reason.
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEALER_LESSON = 'browser_click on specific element refs/selectors (e.g., f5e1537, f5e298) fails repeatedly';
const MODEL_NOTE = 'Repeated `browser_click` failures on youtube.com using element `ref`s suggest that those elements can become stale very quickly due to page re-renders. A `browser_snapshot` should be taken immediately before each `browser_click` attempt that relies on its generated refs to minimize this risk.';

const prov = () => require('../src/core/memory/provenance');

function fakeFs() {
  const store = {};
  return {
    store,
    ensureDir() {},
    listFiles: (dir) => Object.keys(store).filter((k) => k.indexOf(dir + '/') === 0).map((k) => ({ path: k, name: path.basename(k) })),
    readText: (p) => (store[p] != null ? store[p] : ''),
    writeText: (p, v) => { store[p] = v; },
    removeFile: (p) => { delete store[p]; },
    vaultPath: () => 'vault',
  };
}
const lessonsStore = (fsx) => require('../src/core/memory/lessons').createLessonsStore({ fs: fsx, config: {} });
const sidecarOf = (fsx) => JSON.parse(/<!--\s*(\{.*\})\s*-->/.exec(Object.values(fsx.store)[0])[1]);

describe('BUG-451 — the server labels what a remembered sentence claims', () => {
  test('(a) THE TWO RECORDS: the model\'s note states a cause (hypothesis); the healer\'s lesson reports a symptom (observation)', () => {
    assert.equal(prov().provenanceOf(MODEL_NOTE), 'hypothesis');
    assert.equal(prov().provenanceOf(HEALER_LESSON), 'observation');
  });

  test('(a2) ADJACENT, and the documented over-fire: a quoted error with "because" reads as a hypothesis — the safe direction', () => {
    assert.equal(prov().provenanceOf('launch_app timed out after 10 s'), 'observation');
    assert.equal(prov().provenanceOf('the operator refreshed the page, so the ref was gone'), 'observation',
      'a cause phrased without a marker passes — a shape rule, recorded as a limit');
    assert.equal(prov().provenanceOf('failed because the page timed out'), 'hypothesis');
  });
});

test('(a3) EVERY cause marker is exercised — the real note carries two, so dropping either alone would pass (a)', () => {
  const byMarker = [
    'it failed because the page reloaded', 'the refs went stale due to re-renders', 'a timeout caused by the proxy',
    'it broke as a result of the update', 'the root cause is the cache', 'the reason is a stale ref',
    'the failure stems from the parser', 'which is why the click missed', 'this suggests that refs expire',
    'the refresh led to the error', 'it worked thanks to the retry',
  ];
  const missed = byMarker.filter((s) => prov().provenanceOf(s) !== 'hypothesis');
  assert.deepEqual(missed, []);
});

describe('BUG-451 — lessons carry per-entry provenance, and nothing can claim to be verified', () => {
  test('(b) each entry is labelled when written; appending labels only the new entry', () => {
    const fsx = fakeFs(); const lessons = lessonsStore(fsx);
    lessons.recordFailure({ tool: 'browser_click' }, MODEL_NOTE, { source: 'goal-failure' });
    assert.deepEqual(sidecarOf(fsx).provenance, ['hypothesis']);
    lessons.recordFailure({ tool: 'browser_click' }, HEALER_LESSON, { source: 'reflection' });
    assert.deepEqual(sidecarOf(fsx).provenance, ['hypothesis', 'observation'], 'the earlier entry keeps its label; the new one gets its own');
  });

  test('(c) a caller cannot pass a label in — "verified" from anywhere is discarded and recomputed', () => {
    const fsx = fakeFs(); const lessons = lessonsStore(fsx);
    lessons.write('forced', [MODEL_NOTE], { provenance: ['verified'] });
    assert.deepEqual(sidecarOf(fsx).provenance, ['hypothesis']);
    const fsy = fakeFs(); const l2 = lessonsStore(fsy);
    l2.recordFailure({ tool: 'x' }, HEALER_LESSON, { source: 'incident', provenance: 'verified' });
    assert.deepEqual(sidecarOf(fsy).provenance, ['observation']);
  });

  test('(d) a record written BEFORE labels existed is classified at read — the 09-23 file is covered without editing it', () => {
    const fsx = fakeFs();
    // Byte-shape of the real 09-23 lesson file, sidecar with no provenance field, plus the model's cause as a second line.
    fsx.store['Lessons/legacy.md'] = '## legacy\n\n<!-- {"id":"lsn-1","ts":1,"count":2,"lastSeen":1,"trigger":{"tool":"","argsHash":"0","goalTitle":"browser_click"},"sources":["reflection"]} -->\n- '
      + HEALER_LESSON + '\n- ' + MODEL_NOTE + '\n';
    const hit = lessonsStore(fsx).recall('browser_click', {})[0];
    assert.deepEqual(hit.provenance, ['observation', 'hypothesis']);
    assert.equal(hit.plannerSnippet, HEALER_LESSON, 'the planner is given the symptom, not the guessed cause');
    assert.match(hit.snippet, /Repeated .browser_click. failures on youtube/, 'the general snippet (both lines, cut at 220) is unchanged — provenance is added, nothing is hidden from recall');
  });

  test('(e) a lesson whose ONLY line is a guessed cause gives the planner a warning, not the guess', () => {
    const fsx = fakeFs(); const lessons = lessonsStore(fsx);
    lessons.recordFailure({ tool: 'browser_click' }, MODEL_NOTE, {});
    const hit = lessons.recall('browser_click', {})[0];
    assert.doesNotMatch(hit.plannerSnippet, /re-renders|browser_snapshot should/);
    assert.match(hit.plannerSnippet, /unverified/);
  });
});

describe('BUG-451 — the goal planner is not instructed by a guess', () => {
  test('(f) THROUGH THE REAL PLANNER: the PRIOR FAILURES block carries the observation and not the hypothesis', async () => {
    const goalsMod = require('../src/core/goals/index');
    const fsx = fakeFs(); const lessons = lessonsStore(fsx);
    // The guess is recorded FIRST. With the symptom first, the old planner line cut the text at 180
    // characters before the guess ever appeared, and this test passed on the old code for that reason
    // alone (found by the red-first run, 2026-09-23).
    lessons.recordFailure({ tool: '', goalTitle: 'open the third video' }, MODEL_NOTE, { source: 'goal-failure' });
    lessons.recordFailure({ tool: '', goalTitle: 'open the third video' }, HEALER_LESSON, { source: 'reflection' });
    const prompts = [];
    const brain = { think: async (opts) => { prompts.push(opts.messages[0].content); return { content: null, parsed: null, offline: true }; } };
    const goalsFs = { ensureDir() {}, listFiles: () => [], readText: () => '', readJSON: () => null, writeJSON() {}, writeText() {}, removeFile() {}, exists: () => false, vaultPath: () => 'vault' };
    const memory = { lessons, episodic: { recall: () => [] }, skills: { write: () => ({ ref: 'x' }) } };
    const sys = goalsMod.createGoalSystem({ fs: goalsFs, config: { GOAL_FAIL_PAUSE_THRESHOLD: 9, LESSON_RECALL_LIMIT: 5 }, bus: { emit() {} }, memory, brain });
    const g = sys.create({ title: 'open the third video', drive: 'user-service' });
    await sys.plan(g, { memory, brain, recallCache: [] });
    const prompt = prompts.find((p) => /PRIOR FAILURES/.test(p));
    assert.ok(prompt, 'fixture check: the lesson reached the planner');
    assert.match(prompt, /fails repeatedly/);
    assert.doesNotMatch(prompt, /due to page re-renders|should be taken immediately before/,
      'the guessed cause must not reach the planner as an instruction');
  });
});

describe('BUG-451 — a note MYTHOS writes carries its provenance on the entry', () => {
  let dir; let notes; let tools;
  const tool = (name) => tools.find((t) => t.name === name);
  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug451-notes-'));
    notes = require('../src/core/memory/notes').createNotesStore({ dir });
    tools = require('../src/core/effectors/from-memory').buildTools({ notes });
  }
  const done = () => fs.rmSync(dir, { recursive: true, force: true });

  test('(g) the 09-23 note is stored marked as a hypothesis, and the model is told so in the result', async () => {
    setup();
    try {
      const out = await tool('note_take').fn({ title: 'Lesson Learned: Rapid Ref Staleness on YouTube', text: MODEL_NOTE });
      assert.equal(out.ok, true);
      assert.equal(out.result.provenance, 'hypothesis');
      assert.match(out.result.evidence, /unverified hypothesis/);
      const body = notes.read('Lesson Learned: Rapid Ref Staleness on YouTube').content;
      assert.match(body, /<!-- mythos-provenance: hypothesis \(states a cause MYTHOS has not verified\) -->\n/);
    } finally { done(); }
  });

  test('(h) ADJACENT: an observation is marked as one; appending labels only the new entry and leaves the operator\'s text untouched', async () => {
    setup();
    try {
      notes.write({ title: 'Shopping', text: 'milk, eggs — written by the operator' });
      const before = notes.read('Shopping').content;
      const out = await tool('note_take').fn({ title: 'Shopping', text: 'bread was added at 5 pm' });
      assert.equal(out.result.provenance, 'observation');
      const after = notes.read('Shopping').content;
      assert.ok(after.startsWith(before.replace(/\s*$/, '')), 'the operator\'s text is kept byte for byte');
      assert.equal((after.match(/mythos-provenance/g) || []).length, 1, 'only the entry MYTHOS wrote is labelled');
      assert.match(after, /<!-- mythos-provenance: observation -->\nbread was added/);
    } finally { done(); }
  });

  test('(i) the model cannot choose the label: an args.provenance of "verified" is ignored', async () => {
    setup();
    try {
      const out = await tool('note_take').fn({ title: 'Forced', text: MODEL_NOTE, provenance: 'verified' });
      assert.equal(out.result.provenance, 'hypothesis');
      assert.doesNotMatch(notes.read('Forced').content, /verified -->/);
    } finally { done(); }
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug451/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All 11 tests GREEN
// before each one.
//
//   W1  everything is an observation                      -> (a)(a2)(a3)(b)(d)(e)(f)(g)…
//   W2  the "due to" marker dropped                       -> (a3)
//   W3  the "suggests that" marker dropped                -> (a3)
//   W4  a caller-supplied label accepted ("verified")     -> (c)
//   W5  appending relabels existing entries               -> (b)(f)
//   W6  the planner snippet keeps hypotheses              -> (d)(e)(f)
//   W7  the planner reads the general snippet again       -> (f)
//   W8  a legacy record is not classified at read         -> (d)
//   W9  note_take does not mark the entry                 -> (g)(h)
//   W10 note_take lets the model choose the label         -> (i)
//
// W2 and W3 would each have SURVIVED (a) alone: the real note carries both
// markers, so dropping one still reads it as a hypothesis. (a3) was written for
// that before the run.
//
// NOT COVERED, AND SAID SO:
//   * Nothing produces 'verified'. A verifier with trusted evidence for a specific
//     claim is the missing half; until it exists every cause stays a hypothesis.
//   * Evidence references (the action ids a note was written from) are not
//     attached: note_take has no view of the action ledger.
//   * The semantic store is not labelled. The same false cause also reached a
//     consolidated semantic memory on 2026-09-23 ("(rapid re-rendering) is
//     resolved"), which this rule would not even catch — no cause marker.
//   * The two wrong records, and that third one, are left in the operator's vault
//     unedited: removing or quarantining them is the operator's call.
