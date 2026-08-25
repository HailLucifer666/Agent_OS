'use strict';

// F9 (2026-08-15) — "MYTHOS did not remember previously requested songs".
//
// Measured in the 2026-08-14 vault:
//   - "Radiohead" appears 18x in Episodic and 0x in Semantic.
//   - It was played three times (21:43, 21:44, 22:05) and never became a fact.
//   - The complaint landed 22:15:36; the music-taste facts were written
//     22:16-22:24 — AFTER it, by the model reacting to the complaint — and
//     fragmented into eight append-only bullets with one artist recorded twice.
//   - The Semantic store on this machine has never contained a single
//     consolidated-*.md file, so the episodic->semantic distillation has never
//     produced output here at all.
//
// The structural gap: every route into Semantic required the MODEL to choose to
// call `remember`. Behaviour — the most reliable signal about what someone likes
// — produced nothing at all.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createHabitPromoter, WATCHED, subjectOf } = require('../src/core/memory/habit-promoter');
const { TIER_TABLE } = require('../src/core/leash/tiers');

function harness(opts) {
  const writes = [];
  const promoter = createHabitPromoter(Object.assign({
    semantic: { write: (topic, facts, meta) => { writes.push({ topic, facts, meta }); return { ref: topic }; } },
  }, opts || {}));
  return { promoter, writes };
}

describe('F9 — a repeated action becomes a durable fact', () => {
  it('the third play promotes; the first two do not', () => {
    const { promoter, writes } = harness();
    promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.deepStrictEqual(writes, [], 'one play is a request, not a preference');
    promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.deepStrictEqual(writes, [], 'two is coincidence');
    promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.strictEqual(writes.length, 1, 'three is a habit — this is the exact case that was missed');
    assert.match(writes[0].facts[0], /Radiohead/i);
  });

  it('casing and whitespace are one preference, not three', () => {
    // Counting raw arguments is how a threshold silently never fires.
    const { promoter, writes } = harness();
    for (const q of ['Radiohead', 'radiohead', '  RADIOHEAD ']) {
      promoter.observe('spotify_play', { query: q }, true);
    }
    assert.strictEqual(writes.length, 1);
  });

  it('it promotes once, not on every play thereafter', () => {
    // Repeated writes are what produced eight fragmented bullets for one taste.
    const { promoter, writes } = harness();
    for (let i = 0; i < 10; i++) promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.strictEqual(writes.length, 1);
  });

  it('two different subjects are two facts under two topics', () => {
    const { promoter, writes } = harness();
    for (let i = 0; i < 3; i++) promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    for (let i = 0; i < 3; i++) promoter.observe('spotify_play', { query: 'Steve Vai' }, true);
    assert.strictEqual(writes.length, 2);
    assert.notStrictEqual(writes[0].topic, writes[1].topic,
      'a stable per-subject topic is what lets a fact be updated instead of appended to');
  });
});

describe('F9 — what must NOT become a fact', () => {
  it('a failed action is not evidence of anything', () => {
    const { promoter, writes } = harness();
    for (let i = 0; i < 5; i++) promoter.observe('spotify_play', { query: 'Radiohead' }, false);
    assert.deepStrictEqual(writes, []);
  });

  it('a bare transport command names no subject', () => {
    const { promoter, writes } = harness();
    for (const q of ['next', 'pause', 'play', 'shuffle', 'something', 'music']) {
      for (let i = 0; i < 4; i++) promoter.observe('spotify_play', { query: q }, true);
    }
    assert.deepStrictEqual(writes, [], '"the operator likes: next" is noise that costs recall quality');
  });

  it('an unwatched tool is ignored no matter how often it runs', () => {
    const { promoter, writes } = harness();
    for (let i = 0; i < 20; i++) promoter.observe('screen_look', { query: 'what is on screen' }, true);
    assert.deepStrictEqual(writes, []);
  });

  it('a missing or absurd argument is ignored', () => {
    const { promoter, writes } = harness();
    for (let i = 0; i < 5; i++) promoter.observe('spotify_play', {}, true);
    for (let i = 0; i < 5; i++) promoter.observe('spotify_play', { query: 'x'.repeat(500) }, true);
    for (let i = 0; i < 5; i++) promoter.observe('spotify_play', null, true);
    assert.deepStrictEqual(writes, []);
  });

  it('a semantic write that throws cannot break the action that triggered it', () => {
    const { promoter } = harness({ semantic: { write: () => { throw new Error('vault is read-only'); } } });
    for (let i = 0; i < 3; i++) {
      assert.doesNotThrow(() => promoter.observe('spotify_play', { query: 'Radiohead' }, true));
    }
  });
});

describe('F9 — the watch list is derived, not imagined', () => {
  it('every watched tool is a real tool', () => {
    // The first draft of this list contained play_music and play_song, neither of
    // which exists. A watch list naming tools nobody can call is a feature that
    // silently does nothing — the same hand-kept-copy class as the claim-check
    // categories and the vault path.
    const unknown = Object.keys(WATCHED).filter(
      (t) => !Object.prototype.hasOwnProperty.call(TIER_TABLE, t));
    assert.deepStrictEqual(unknown, [], 'watched tools that do not exist: ' + unknown.join(', '));
  });

  it('every watched argument is a real parameter of its tool', () => {
    // Reads the live tool catalog rather than restating parameter names, so a
    // renamed parameter fails here instead of degrading into a no-op.
    // These three modules export a static TOOLS array (unlike from-gmail and
    // from-dashboard, which build theirs from an injected ctx), so the catalog
    // is readable without standing up a whole effector hub.
    const catalog = new Map();
    for (const mod of ['from-spotify', 'from-pc', 'from-whatsapp']) {
      const tools = require('../src/core/effectors/' + mod).TOOLS || [];
      for (const tool of tools) catalog.set(tool.name, tool.params || {});
    }
    const checked = [];
    for (const [tool, spec] of Object.entries(WATCHED)) {
      const params = catalog.get(tool);
      if (!params) continue;
      checked.push(tool);
      assert.ok(Object.prototype.hasOwnProperty.call(params, spec.arg),
        tool + ' has no parameter "' + spec.arg + '" — it has: ' + Object.keys(params).join(', '));
    }
    assert.ok(checked.length > 0, 'the catalog must be reachable, or this test proves nothing');
  });

  it('subjectOf reads the argument the catalog actually names', () => {
    assert.strictEqual(subjectOf('spotify_play', { query: 'Radiohead' }), 'radiohead');
    assert.strictEqual(subjectOf('launch_app', { name: 'Notepad' }), 'notepad');
    assert.strictEqual(subjectOf('whatsapp_send', { to: 'Dad', text: 'hi' }), 'dad');
    assert.strictEqual(subjectOf('spotify_play', { trackId: '3z8h0TU7ReDPLIbEnYhWZb' }), null,
      'a track ID is not a name and must not be written into a fact the operator would read');
  });
});

describe('F9 — dispatch actually calls it', () => {
  it('dispatch-action observes habits with the verified-only guard', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'dispatch-action.js'), 'utf8');
    assert.match(src, /memory\.habits\.observe\(/,
      'the promoter is inert unless the shared dispatch sequence calls it');
    const at = src.indexOf('memory.habits.observe(');
    const call = src.slice(at, src.indexOf(')', src.indexOf('actionOk', at)));
    assert.match(call, /actionOk\s*&&\s*!actionUnverified/,
      'an action that only MIGHT have landed is not evidence of a habit — the evidence '
      + 'contract must survive this far down (src/core/CLAUDE.md)');
  });
});
