'use strict';

// test/brain-lane-wiring.test.js — the assertions behind the 2026-08-14 lane
// split (reasoning + memory).
//
// WHY AN ASSERTION AND NOT A COMMENT. Three separate incidents in this repo are
// the same bug: a registry SILENTLY SUBSTITUTES instead of failing. The skills
// loader searched one root and found nothing; lanes.default.js's own header
// records four dead OpenRouter slugs that registry.js counted alive on key
// presence; and chainFor() falls back to the `text` lane — which has no caller —
// for any unknown lane name, so `lane: 'resoning'` produces no error at all,
// just quietly worse answers. The invariant has broken three times, so it gets
// a test that runs on every commit rather than a fourth hand-check.
//
// The other two blocks pin the two SIBLING ARGUMENTS a lane rename silently
// drops. Neither throws when it breaks; the call still succeeds and the output
// is merely worse, which is the only reason they were worth finding in advance.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createBrain } = require('../src/core/brain/index');
const { TERSE_STYLE } = require('../src/core/brain/style-terse');
const chain = require('../src/core/brain/chain');
const registry = require('../src/core/brain/registry');
const { BRAIN_TABLES } = require('../src/core/brain/lanes.default');

const SRC_DIR = path.resolve(__dirname, '../src');

// Same chain.complete monkey-patch brain.test.js and brain-terse-style.test.js
// already use: capture the assembled messages, reject with chainExhausted so
// nothing reaches a real provider, always restore.
async function captureMessages(brainOpts, thinkOpts) {
  let captured = null;
  const orig = chain.complete;
  chain.complete = function (opts) {
    captured = opts.messages;
    const err = new Error('chain exhausted (test)');
    err.chainExhausted = true;
    return Promise.reject(err);
  };
  try {
    await createBrain(Object.assign({ bus: null }, brainOpts)).think(thinkOpts);
  } finally {
    chain.complete = orig;
  }
  return captured || [];
}

const hasTerse = (msgs) => msgs.some((m) => m.role === 'system' && m.content === TERSE_STYLE);
const systemText = (msgs) => msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('every brain lane a caller names is registered', function () {
  // SCOPE, STATED HONESTLY so this never reads as more coverage than it has:
  // this is a scan for LITERAL `lane: 'x'` strings. It cannot resolve a lane
  // held in a variable. There is exactly one such site in src/ and it is
  // whitelisted by name below, with both of its branches asserted by hand. If a
  // second dynamic site appears, this test will not see it — add it there.
  const DYNAMIC_LANE_SITES = [
    {
      file: path.join('core', 'goals', 'index.js'),
      // goals/index.js: `var lane = goal.drive === 'user-service' ? 'build' : 'simple';`
      branches: ['build', 'simple'],
      why: 'goal planning picks its lane from goal.drive at runtime',
    },
  ];

  // Namespaces that reuse the WORD "lane" for something that is not a brain
  // lane. Checked by eye 2026-08-14; each is a different vocabulary entirely and
  // must not be dragged into BRAIN_TABLES.
  const NOT_BRAIN_LANES = new Set([
    'backlog', 'building', 'review', 'done', 'todo', 'blocked', 'shipped', // kanban columns
    'ollama',        // chain.js provider lane, not a brain lane
    'voice-live',    // live-session.js's brain-spend tag; never passed to chainFor
    'string', 'string (optional)', // tool param DESCRIPTIONS, not values
  ]);

  it('resolves every literal lane: string in src/ to a BRAIN_TABLES key', function () {
    const files = walkJs(SRC_DIR, []);
    const offenders = [];
    const found = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // `(?<![\w-])` and the REQUIRED space are both load-bearing, and both were
      // added after this scan produced false positives on its first run: without
      // them it matched inside the string literal 'unknown-lane:' in
      // immune/healer.js and captured the next 200 characters of source as a
      // "lane name". A guard that cries wolf gets deleted, which would cost more
      // than the guard is worth. Every real call site writes `lane: 'x'`.
      const re = /(?<![\w-])lane:\s+'([^']*)'/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const lane = m[1];
        if (NOT_BRAIN_LANES.has(lane)) continue;
        found.push(lane);
        if (!BRAIN_TABLES[lane]) {
          offenders.push(path.relative(SRC_DIR, file) + " -> lane: '" + lane + "'");
        }
      }
    }
    // Anti-vacuity. The regex above was tightened twice to kill false
    // positives, and each tightening is a chance to match nothing at all — at
    // which point this test passes forever while checking nothing. There were
    // ~25 literal call sites when it was written; 10 is a floor with room for
    // real consolidation, not a count to keep in sync.
    assert.ok(found.length >= 10, 'the lane scan matched only ' + found.length + ' sites — the regex has stopped seeing real call sites');
    assert.ok(new Set(found).has('reasoning'), 'the scan should see the reasoning lane it was written for');
    assert.deepEqual(offenders, [],
      'unregistered brain lane(s) — chainFor() would silently substitute the caller-less `text` lane:\n' + offenders.join('\n'));
  });

  it('each whitelisted dynamic lane site still resolves on every branch', function () {
    for (const site of DYNAMIC_LANE_SITES) {
      const full = path.join(SRC_DIR, site.file);
      assert.ok(fs.existsSync(full), site.file + ' moved — update DYNAMIC_LANE_SITES rather than deleting this guard');
      for (const branch of site.branches) {
        assert.ok(BRAIN_TABLES[branch],
          site.file + ' can pass lane ' + JSON.stringify(branch) + ' (' + site.why + ') and it is not registered');
      }
    }
  });

  it('reports an unknown lane loudly instead of substituting text in silence', async function () {
    const events = [];
    const bus = { emit: (type, detail) => events.push({ type, detail }) };
    // registry dedupes per lane name (a coding error's first report is the whole
    // signal), so use a name no other test can have burned.
    const typo = 'resoning-' + process.pid + '-' + Math.floor(Math.random() * 1e6);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      const chainResult = await registry.chainFor(typo, { bus });
      assert.ok(Array.isArray(chainResult), 'chainFor must still return a chain, never throw');
    } finally {
      console.warn = origWarn;
    }
    const anomaly = events.find((e) => e.type === 'health.anomaly' && e.detail && e.detail.kind === 'brain-lane-unknown');
    assert.ok(anomaly, 'expected a health.anomaly for an unknown lane');
    assert.equal(anomaly.detail.lane, typo);
    assert.equal(anomaly.detail.fallback, 'text');
    assert.ok(anomaly.detail.known.includes('reasoning'), 'the report must name the lanes that DO exist');
    assert.ok(warns.some((w) => w.includes(typo)), 'stderr must carry it too — chain.js only forwards a bus when its caller passed one');
  });

  it('a registered lane emits no anomaly', async function () {
    const events = [];
    const bus = { emit: (type, detail) => events.push({ type, detail }) };
    await registry.chainFor('reasoning', { bus });
    await registry.chainFor('memory', { bus });
    assert.deepEqual(events, [], 'a registered lane must be silent');
  });
});

describe('BREAKAGE 1 — persona survives the lane move', function () {
  // agent-actions.js passes persona: personas.loadPersona('reviewer') /
  // 'reality-checker', and both calls moved from 'simple' to 'reasoning' on
  // 2026-08-14. brain/index.js only injects a persona for lanes on its own
  // list. Had that list not moved too, the argument would have been ignored in
  // total silence and both seats would have gone generic — the exact thing the
  // (deferred) vault/Personas/ work is meant to fix.
  const PERSONA = 'You are a merciless build reviewer.';

  for (const lane of ['voice', 'build', 'simple', 'reasoning', 'memory']) {
    it('injects a per-call persona on lane ' + lane, async function () {
      const msgs = await captureMessages(
        { config: {} },
        { lane, persona: PERSONA, messages: [{ role: 'user', content: 'grade this' }] });
      assert.ok(systemText(msgs).includes(PERSONA),
        'lane ' + lane + ' accepted a persona argument and dropped it');
    });
  }
});

describe('BREAKAGE 2 — terse styling follows the right lanes', function () {
  // The default is load-bearing and was invisible until now: every lane-simple
  // caller got TERSE_STYLE unless it passed terse:false, so moving three
  // callers off 'simple' would have silently removed compression from all
  // three. The decision was made explicitly — keep it for memory (summaries
  // should stay compact), drop it for reasoning (compressing a reasoning answer
  // works against the reason the lane exists).
  const DEFAULT_TERSE = 'simple,memory';

  it('ships the decision as the schema default, not as folklore', function () {
    const schemaSrc = fs.readFileSync(path.join(SRC_DIR, 'core', 'config', 'schema.js'), 'utf8');
    assert.match(schemaSrc, /BRAIN_TERSE_LANES:\s*\{[^}]*default:\s*'simple,memory'/,
      'BRAIN_TERSE_LANES default changed — if that is deliberate, update this test and say why in schema.js');
  });

  it('keeps terse on the memory lane', async function () {
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: DEFAULT_TERSE } },
      { lane: 'memory', messages: [{ role: 'user', content: 'distill' }] });
    assert.ok(hasTerse(msgs), 'memory consolidation lost its compression');
  });

  it('keeps terse OFF on the reasoning lane', async function () {
    const msgs = await captureMessages(
      { config: { BRAIN_TERSE_LANES: DEFAULT_TERSE } },
      { lane: 'reasoning', messages: [{ role: 'user', content: 'think' }] });
    assert.ok(!hasTerse(msgs), 'reasoning output must not be compressed — that is what the lane exists to avoid');
  });
});
