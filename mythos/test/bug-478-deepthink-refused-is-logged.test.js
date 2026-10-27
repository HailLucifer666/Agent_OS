'use strict';

// BUG-478 — two think_deeply calls (09:29:43 and 09:30:01 UTC, 2026-10-06) left
// no `deepthink.attempt`, no `deepthink.call` and no late result, while the calls
// at 09:29:18 and 09:30:58 did. The gaps (25s, 18s, 57s) fit the 60s cooldown
// exactly: the cooldown refusal returns from think_deeply BEFORE deepThink()
// runs, and that path wrote nothing. Two other early returns were equally silent:
// no brain wired, and an empty question (deep-think.js).
//
// Fix: every refusal writes one `deepthink.refused` line {reason, sinceLastMs?}.
//
// MUTATION PROBES (2026-10-06; each applied, diffed to confirm it applied, run,
// restored). All five went red for the stated reason; (e) also turned the
// cooldown test red because the extra line doubled its refused count.
//   (a) from-computer.js: delete the logRefusal call in the cooldown branch
//       -> must fail 'cooldown refusal writes deepthink.refused'.
//   (b) from-computer.js: delete the logRefusal call in the no-brain branch
//       -> must fail 'no brain writes deepthink.refused'.
//   (c) deep-think.js: delete the log.info('deepthink.refused') in the empty
//       question branch -> must fail 'empty question writes deepthink.refused'.
//   (d) deep-think-budget.js: logRefusal drops the sinceLastMs field
//       -> must fail the sinceLastMs assertion of (a).
//   (e) from-computer.js: log 'deepthink.refused' on the normal path too
//       -> must fail 'a normal call writes its attempt line and no refused line'.
// Adjacent cases that must keep passing: a throwing logger never fails the tool;
// a null logger is fine; the refusal return values are unchanged.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FROM_COMPUTER = path.resolve(__dirname, '../src/core/effectors/from-computer.js');
const DEEP_THINK = path.resolve(__dirname, '../src/core/effectors/deep-think.js');
const DEEP_BUDGET = path.resolve(__dirname, '../src/core/effectors/deep-think-budget.js');

function freshModule() {
  delete require.cache[FROM_COMPUTER];
  require(DEEP_BUDGET).resetDeepThinkBudget();
  return require(FROM_COMPUTER);
}

// The repo logger is silent under test, so assert on an injected sink instead.
function sink() {
  const rows = [];
  return {
    rows,
    info: (evt, data) => rows.push({ evt, data }),
    warn: () => {},
    named: (name) => rows.filter((r) => r.evt === name),
  };
}

// Stub at the deep-think module boundary (see bug-287 for why a brain stub is
// not enough). The stub itself writes an attempt line, as the real one does.
function stubDeepThink() {
  require.cache[DEEP_THINK] = {
    id: DEEP_THINK, filename: DEEP_THINK, loaded: true,
    exports: {
      deepThink: async (brain, opts) => {
        opts.logger.info('deepthink.attempt', { source: opts.source });
        return { content: 'answer', provider: 'p', model: 'm', offline: false, timedOut: false, ms: 1 };
      },
    },
  };
}

const A_BRAIN = { think: () => Promise.resolve({ content: 'unused' }) };
const hub = { register() {} };

describe('BUG-478: every think_deeply refusal leaves a structured log line', () => {
  let mod;
  beforeEach(() => { mod = freshModule(); });
  afterEach(() => { delete require.cache[FROM_COMPUTER]; delete require.cache[DEEP_THINK]; });

  it('cooldown refusal writes deepthink.refused with sinceLastMs', async () => {
    stubDeepThink();
    const log = sink();
    mod.registerFromComputer(hub, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 }, logger: log });
    await mod.think_deeply({ question: 'first' });
    const res = await mod.think_deeply({ question: 'second, seconds later' });
    assert.equal(res.ok, false);
    const rows = log.named('deepthink.refused');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.reason, 'cooldown');
    assert.equal(typeof rows[0].data.sinceLastMs, 'number');
    assert.ok(rows[0].data.sinceLastMs >= 0 && rows[0].data.sinceLastMs < 60000);
  });

  it('no brain writes deepthink.refused', async () => {
    const log = sink();
    mod.registerFromComputer(hub, { brain: null, config: {}, logger: log });
    const res = await mod.think_deeply({ question: 'anything' });
    assert.equal(res.ok, false);
    const rows = log.named('deepthink.refused');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.reason, 'no-brain');
    assert.equal('sinceLastMs' in rows[0].data, false);
  });

  it('empty question writes deepthink.refused', async () => {
    const { deepThink } = require(DEEP_THINK);
    const log = sink();
    const r = await deepThink(A_BRAIN, { question: '   ', logger: log });
    assert.equal(r.offline, true);
    assert.match(r.reason, /no question/);
    const rows = log.named('deepthink.refused');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.reason, 'empty-question');
  });

  it('a normal call writes its attempt line and no refused line', async () => {
    stubDeepThink();
    const log = sink();
    mod.registerFromComputer(hub, { brain: A_BRAIN, config: { DEEP_THINK_MIN_INTERVAL_MS: 60000 }, logger: log });
    const res = await mod.think_deeply({ question: 'a real question' });
    assert.equal(res.ok, true);
    assert.equal(log.named('deepthink.attempt').length, 1);
    assert.equal(log.named('deepthink.refused').length, 0);
  });

  it('a throwing or absent logger never changes the refusal', async () => {
    mod.registerFromComputer(hub, {
      brain: null, config: {}, logger: { info() { throw new Error('boom'); } },
    });
    assert.equal((await mod.think_deeply({ question: 'x' })).ok, false);
    mod.registerFromComputer(hub, { brain: null, config: {}, logger: null });
    assert.equal((await mod.think_deeply({ question: 'x' })).ok, false);
  });
});
