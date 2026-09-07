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

const { createHabitPromoter, WATCHED, subjectOf, keyFor } = require('../src/core/memory/habit-promoter');
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

  it('retries failed persistence and announces only a durable promotion', () => {
    // BUG-249: semantic.write normally reports failure as degraded:true, not
    // an exception. Cover that production contract and thrown failures too.
    const failureResults = [() => { throw new Error('temporary vault failure'); },
      () => ({ ref: null, degraded: true }), () => null, () => undefined,
      () => ({ ref: null, degraded: false }), () => ({ ref: 'stale', degraded: true })];
    for (const fail of failureResults) {
      let writes = 0;
      const events = [];
      const { promoter } = harness({
        semantic: { write() { writes++; return writes === 1 ? fail() : { ref: 'saved', degraded: false }; } },
        logger: { info: (...args) => events.push(args) },
      });
      for (let i = 0; i < 2; i++) promoter.observe('spotify_play', { query: 'Radiohead' }, true);
      assert.equal(promoter.observe('spotify_play', { query: 'Radiohead' }, true), null);
      assert.equal(writes, 1);
      assert.equal(events.length, 0, 'failed persistence must not announce a durable fact');
      assert.ok(promoter.observe('spotify_play', { query: 'Radiohead' }, true));
      assert.equal(writes, 2, 'failure must not poison the promoted set');
      assert.equal(events.length, 1);
      assert.equal(events[0][0], 'memory.habit-promoted');
      assert.equal(promoter.observe('spotify_play', { query: 'Radiohead' }, true), null);
      assert.equal(writes, 2, 'a durable success must still deduplicate later observations');
    }
  });

  it('honors the real semantic store degraded-return contract before retrying', () => {
    const { createSemanticStore } = require('../src/core/memory/semantic');
    const stored = new Map();
    const anomalies = [];
    const promotions = [];
    let unavailable = true;
    const semantic = createSemanticStore({
      fs: { writeText(file, text) {
        if (unavailable) throw new Error('fixture filesystem temporarily unavailable');
        stored.set(file, text);
      } },
      config: {}, bus: { emit: (...args) => anomalies.push(args) }, logger: {},
    });
    const promoter = createHabitPromoter({ semantic, promoteAfter: 1,
      logger: { info: (...args) => promotions.push(args) } });
    assert.equal(promoter.observe('spotify_play', { query: 'Radiohead' }, true), null);
    assert.equal(stored.size, 0);
    assert.equal(promotions.length, 0);
    assert.equal(anomalies[0][1].kind, 'memory-write-failed');
    unavailable = false;
    assert.ok(promoter.observe('spotify_play', { query: 'Radiohead' }, true));
    assert.match([...stored.values()][0], /radiohead/i);
    assert.equal(promotions.length, 1);
    promoter.observe('spotify_play', { query: 'Radiohead' }, true);
    assert.equal(promotions.length, 1);
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

describe('the (tool, subject) counter key is joined by a NUL', () => {
  // habit-promoter.js used to write this separator as a RAW 0x00 byte, which made
  // git classify the whole file as binary: no line-level diff, nothing reviewable in
  // a pull request, and grep answering "Binary file ... matches" instead of the line.
  // The fix changed only the SOURCE representation (a JavaScript escape), so these
  // assertions are what prove the runtime VALUE did not move with it.
  //
  // The raw byte cannot come back -- source-has-no-nul-byte.test.js fails on it.
  // What this block stops is the opposite mistake: reading the escape as noise and
  // tidying it into a visible character, which is a silent behaviour change.
  const NUL = String.fromCharCode(0);

  it('keyFor joins the two halves with exactly one NUL', () => {
    assert.strictEqual(keyFor('spotify_play', 'radiohead'), 'spotify_play' + NUL + 'radiohead');
    const key = keyFor('launch_app', 'notepad');
    assert.strictEqual(key.charCodeAt('launch_app'.length), 0,
      'the separator must be U+0000');
    assert.strictEqual(key.split(NUL).length, 2, 'exactly one separator');
  });

  it('the separator is not a character that can occur in either half', () => {
    // Not a cosmetic choice. A subject is free text off a tool argument, so any
    // printable character can appear inside one; only a NUL is guaranteed absent
    // from both a tool name and a normalized subject.
    for (const visible of [' ', ':', '|', '-', '/', ',', '.']) {
      assert.notStrictEqual(keyFor('launch_app', 'x'), 'launch_app' + visible + 'x',
        'the separator has become ' + JSON.stringify(visible) + ' -- a printable character '
        + 'can occur inside a subject, so two different habits could collide on one key');
    }
  });

  it('observe() counts on that key rather than building its own', () => {
    // keyFor could be correct and unused. This is the one line that has to keep
    // pointing at it, so it is asserted directly.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'memory', 'habit-promoter.js'), 'utf8');
    assert.match(src, /const key = keyFor\(tool, subject\);/,
      'observe() must build its counter key with keyFor -- an inlined separator here would '
      + 'pass every assertion above while behaving differently');
  });
});
