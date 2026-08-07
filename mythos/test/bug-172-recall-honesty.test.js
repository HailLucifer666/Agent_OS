'use strict';

// test/bug-172-recall-honesty.test.js — BUG-172.
//
// recall_memory returned { ok: true, count: 0, results: [] } when nothing
// matched, and the model read that as "the tool worked" — the 2026-08-07
// session has it saying it recalled something and then having nothing to say.
// A zero result is a real answer and has to arrive in words the reply cannot
// round off.
//
// The count could also reach zero a second way, which looked identical from
// the outside and is not: semantic.recall() returned hits whose snippet was
// the empty string (a topic file that matches the query but parses to zero
// facts), and from-memory.js filtered them out afterwards. So a call that
// genuinely found hits still handed back count:0. That is fixed at the source
// — a hit with no text is not a hit — and the two cases now report
// differently, because "nothing matched" and "matches came back empty" point
// at different things.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { buildTools } = require('../src/core/effectors/from-memory');
const { createSemanticStore } = require('../src/core/memory/semantic');
const { createFsStore } = require('../src/core/memory/fs-store');

function recallTool(recallHybrid) {
  const tools = buildTools({ memory: { recallHybrid }, fs: {}, semantic: {} });
  return tools.find((t) => t.name === 'recall_memory').fn;
}

describe('BUG-172 — an empty recall says so', () => {
  it('zero matches carries a note the reply cannot round off into "I recalled that"', async () => {
    const res = await recallTool(async () => [])({ query: 'the Aether BLE pairing port' });

    assert.equal(res.ok, true, 'finding nothing is not a tool failure');
    assert.equal(res.result.count, 0);
    assert.ok(res.result.note, 'a bare count:0 is what gets misread as success');
    assert.match(res.result.note, /NO MATCHING MEMORIES/);
    assert.match(res.result.note, /the Aether BLE pairing port/, 'the note must name what was searched for');
    assert.match(res.result.note, /do not invent/i);
  });

  it('hits that all came back textless report the DIFFERENT failure they are', async () => {
    const res = await recallTool(async () => [
      { store: 'semantic', snippet: '', score: 0.9 },
      { store: 'semantic', snippet: '', score: 0.5 },
    ])({ query: 'spotify' });

    assert.equal(res.result.count, 0);
    assert.match(res.result.note, /NO USABLE MEMORIES/);
    assert.match(res.result.note, /2 match/, 'the count of empty hits is the clue that points at the store, not the query');
  });

  it('a real hit is unchanged — no note, and the results ride through', async () => {
    const res = await recallTool(async () => [
      { store: 'semantic', snippet: 'the operator prefers dark mode', score: 0.8 },
    ])({ query: 'dark mode' });

    assert.equal(res.result.count, 1);
    assert.equal(res.result.note, undefined, 'a successful recall must not gain a hedge');
    assert.equal(res.result.results[0].snippet, 'the operator prefers dark mode');
  });
});

describe('BUG-172 — semantic.recall drops textless hits at the source', () => {
  function withVault(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-bug172-'));
    try {
      const store = createFsStore(() => dir, null);
      const semantic = createSemanticStore({
        fs: store, config: {}, bus: { emit() {} }, logger: { warn() {} },
      });
      return fn(semantic, store, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a topic file that matches the query but holds no facts is not returned as a hit', () => {
    withVault((semantic, store) => {
      // A header-only topic file: it contains the query word, so the score is
      // non-zero, but parseFacts finds nothing to say about it.
      store.ensureDir('Semantic');
      store.writeText('Semantic/spotify.md', '# spotify\n\n');

      const hits = semantic.recall('spotify');
      assert.deepEqual(hits, [], 'a hit with no text is not a hit — it used to be counted, then dropped downstream');
    });
  });

  it('a topic file with real facts still matches', () => {
    withVault((semantic) => {
      semantic.write('spotify', ['the operator plays spotify on the desktop app'], { confidence: 0.9, append: true });

      const hits = semantic.recall('spotify');
      assert.equal(hits.length, 1);
      assert.match(hits[0].snippet, /desktop app/);
    });
  });
});
