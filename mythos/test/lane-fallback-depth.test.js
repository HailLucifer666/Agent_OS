'use strict';

// Every brain lane must keep a REAL fallback — measured 2026-09-11, because on
// that date six of the eight lanes had exactly one model that could answer.
//
// WHY THE EXISTING GUARD DID NOT CATCH THIS. brain.test.js already asserts that
// no PREF_* table lists a KNOWN_DEAD model, and it passed the whole time. It
// cannot see this failure, because a lane does not become fallback-less by
// listing something dead — it becomes fallback-less by listing things that are
// each individually defensible and collectively unreachable:
//
//   * 14 rungs across the file are BYO_PREMIUM (anthropic, openai). Correct to
//     keep — a buyer supplies the key — and inert on a machine without one.
//   * 13 rungs were ollama. Correct to keep — a local model costs nothing — and
//     inert the moment the operator uninstalled ollama, which happened on
//     2026-09-11 and silently halved several lanes in one action.
//   * Several more were tier-limited (429) or unbilled (402), which are billing
//     states rather than dead models and are deliberately retained.
//
// Every one of those is individually right and the sum was a chain with nothing
// behind its head. That is the shape this file exists to make visible: not "is
// any entry bad" but "is anything actually REACHABLE if the head fails".
//
// What counts as reachable here is deliberately conservative and static — this
// test makes NO network calls, because a gate that needs six API keys and a
// working connection is a gate that gets skipped. It asserts structure the repo
// can check offline: a lane needs at least two rungs that are not BYO, not
// local-only, and not on any of the three recorded do-not-use lists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const lanes = require('../src/core/brain/lanes.default');

const TABLES = ['PREF_VOICE', 'PREF_BUILD', 'PREF_SIMPLE', 'PREF_REASONING',
  'PREF_MEMORY', 'PREF_TEXT', 'PREF_VISION', 'PREF_EMBED'];

// A rung is "cloud-reachable" if it needs no key the repo knows is absent and no
// runtime the operator may not have installed.
const BYO = new Set(lanes.BYO_PREMIUM.map((e) => e.provider));
function isCloudReachable(entry) {
  if (BYO.has(entry.provider)) return false;   // no key on this machine (BUG-418)
  if (entry.provider === 'ollama') return false; // local runtime, may be absent
  const onList = (list) => (list || []).some((d) => d.provider === entry.provider && d.model === entry.model);
  if (onList(lanes.KNOWN_DEAD)) return false;
  if (onList(lanes.TOO_SLOW_NOT_DEAD)) return false;
  if (onList(lanes.UNBILLED_NOT_DEAD)) return false; // answers only once funded
  return true;
}

describe('brain lanes keep a reachable fallback', () => {
  it('every lane has at least two cloud-reachable rungs', () => {
    // TWO, not one. One is not a fallback, it is a single point of failure that
    // looks like a chain — and on 2026-09-11 it failed in front of the operator:
    // the reasoning lane's only reachable model took a 21958ms median against a
    // 30s per-attempt cap, think_deeply gave up, and the healer logged
    // chain-whole-lane-timeout.
    const thin = [];
    for (const name of TABLES) {
      const reachable = lanes[name].filter(isCloudReachable);
      if (reachable.length < 2) {
        thin.push(`${name} has ${reachable.length} (${reachable.map((e) => e.provider + ':' + e.model).join(', ') || 'none'})`);
      }
    }
    assert.deepEqual(thin, [],
      'a lane with fewer than two reachable rungs has no fallback at all — when its head '
      + 'rate-limits, the whole lane fails:\n  ' + thin.join('\n  '));
  });

  it('every lane spans at least two providers', () => {
    // Depth behind one provider is not depth. Mistral returned 429 on FOUR
    // models at once on 2026-09-11 (medium-3.5, medium-latest, medium-2604,
    // magistral-medium) while answering on ministral and codestral — a per-tier
    // limit that takes out several rungs of one provider simultaneously. A lane
    // stacked on a single vendor treats that as total failure.
    for (const name of TABLES) {
      const providers = new Set(lanes[name].filter(isCloudReachable).map((e) => e.provider));
      assert.ok(providers.size >= 2,
        `${name} draws its reachable rungs from only ${[...providers].join(', ') || 'no'} provider(s) — `
        + 'one provider-wide rate limit takes the whole lane down');
    }
  });

  it('no lane lists a model recorded as too slow to use', () => {
    // KNOWN_DEAD and TOO_SLOW_NOT_DEAD are separate on purpose: a dead model can
    // never come back, a slow one returns when the provider adds capacity. Both
    // must stay out of the tables, but conflating them would eventually see a
    // recovered model refused for the wrong reason.
    for (const name of TABLES) {
      for (const entry of lanes[name]) {
        const slow = (lanes.TOO_SLOW_NOT_DEAD || []).find((d) => d.provider === entry.provider && d.model === entry.model);
        assert.equal(slow, undefined,
          `${name} lists ${entry.provider}:${entry.model} — recorded too slow to use (${slow && slow.reason})`);
      }
    }
  });

  it('the embed table documents the real embeddings chain (ollama, mistral, google)', () => {
    // Moved here from brain.test.js 2026-09-11 — that file sits at its file-size
    // ratchet ceiling, and this is a lane-table assertion, so it belongs with the
    // other lane-table assertions rather than costing headroom where it was.
    //
    // brain.think({lane:'embed'}) hard-short-circuits to {offline:true}; real
    // embeddings run through providers/embeddings.js. PREF_EMBED is therefore
    // documentation, and documentation that can drift from the code it describes
    // is how BUG-372 produced a doctor row that was green about a directory
    // nothing loaded from. THIRD RUNG added 2026-09-11 because ollama was
    // uninstalled, leaving mistral-embed as the only embedder while Mistral was
    // 429ing four other models on the same key.
    assert.deepEqual(lanes.PREF_EMBED, [
      { provider: 'ollama', model: 'nomic-embed-text' },
      { provider: 'mistral', model: 'mistral-embed' },
      { provider: 'google', model: 'gemini-embedding-001' },
    ]);
  });

  it('the embed TABLE matches the embed CHAIN that actually runs', () => {
    // The pairing the test above cannot make on its own: adding a provider to
    // one file and not the other leaves the table describing something that does
    // not embed, which is the exact shape of a report nobody can trust.
    const embeddings = require('../providers/embeddings');
    const implemented = Object.keys(embeddings._internal)
      .filter((k) => k.startsWith('embed'))
      .map((k) => k.replace(/^embed/, '').toLowerCase())
      .sort();
    const documented = lanes.PREF_EMBED.map((e) => e.provider).sort();
    assert.deepEqual(implemented, documented,
      `providers/embeddings.js implements [${implemented.join(', ')}] but PREF_EMBED lists `
      + `[${documented.join(', ')}] — one of them is lying about what embeds`);
  });

  it('the three do-not-use lists never overlap', () => {
    // A model on two lists has two different prognoses, and the next session
    // reading one of them acts on the wrong one.
    const lists = { KNOWN_DEAD: lanes.KNOWN_DEAD, TOO_SLOW_NOT_DEAD: lanes.TOO_SLOW_NOT_DEAD, UNBILLED_NOT_DEAD: lanes.UNBILLED_NOT_DEAD };
    const seen = new Map();
    for (const [listName, list] of Object.entries(lists)) {
      for (const e of list || []) {
        const key = e.provider + ':' + e.model;
        assert.equal(seen.has(key), false,
          `${key} is on both ${seen.get(key)} and ${listName} — a model cannot be both permanently gone and temporarily unavailable`);
        seen.set(key, listName);
      }
    }
  });

  it('every do-not-use entry carries a reason', () => {
    // The lists are evidence, not preference. An entry without a reason is
    // someone's opinion with a data structure around it.
    for (const [name, list] of Object.entries({ KNOWN_DEAD: lanes.KNOWN_DEAD, TOO_SLOW_NOT_DEAD: lanes.TOO_SLOW_NOT_DEAD, UNBILLED_NOT_DEAD: lanes.UNBILLED_NOT_DEAD })) {
      for (const e of list || []) {
        assert.ok(e.reason && String(e.reason).trim().length > 10,
          `${name} entry ${e.provider}:${e.model} has no usable reason`);
      }
    }
  });
});
