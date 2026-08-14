'use strict';

// build-refine-loop.test.js — the "snake game test" fix (2026-08-14, Track 3).
//
// THE GAP THIS CLOSES. Every gate before this one reads the artifact's SOURCE:
// design/verify.js runs rule checks and an LLM judge over the text. So an
// artifact that parses, passes every rule and throws a TypeError on its first
// animation frame shipped as `done`, and so did one that ran but looked like
// template slop. Nothing had ever seen the thing rendered.
//
// build-runner.js now owns a bounded loop — render, look, critique, regenerate —
// and this file pins the parts that are policy rather than plumbing:
//
//   * the loop is BOUNDED and the bound is honoured;
//   * a critique failure is NEVER reported as success;
//   * a refined regeneration must clear the SAME verifier the first generation
//     did, and when it does not, the last VERIFIED artifact ships (not the last
//     one attempted);
//   * an unreachable vision lane is 'blind', which is neither pass nor fail;
//   * with the feature off, the pipeline behaves exactly as it did before.
//
// Fakes are used for the engine, verifier and refiner deliberately: a real
// browser plus a real vision call is the LIVE verification (recorded in the
// commit), and it cannot be a unit test. What is faked here is only what the
// loop consumes; the loop itself is the real one.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRefiner, looksRenderable } = require('../src/core/effectors/build-refine');

const HTML = '<!doctype html><html><body><canvas id="game"></canvas></body></html>';

let vaultDir;
let vault;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-refine-'));
  vault = createFsStore(() => vaultDir, null);
});

afterEach(() => {
  try { fs.rmSync(vaultDir, { recursive: true, force: true }); } catch (_) {}
});

// A refiner whose critique verdicts are scripted, so the loop's decisions are
// what is under test rather than a model's opinion.
function fakeRefiner(verdicts, opts) {
  const o = opts || {};
  const calls = { render: 0, critique: 0 };
  return {
    calls: calls,
    available: () => o.available !== false,
    unavailableReason: () => o.reason || 'no Chrome/Edge found',
    looksRenderable: () => o.renderable !== false,
    render: async (html, tag) => {
      calls.render += 1;
      return {
        ok: true,
        screenshotPath: path.join(vaultDir, 'builds', 'refine', tag + '.png'),
        screenshotB64: 'ZmFrZQ==',
        consoleErrors: [],
        pageErrors: [],
      };
    },
    critique: async () => {
      calls.critique += 1;
      return verdicts[Math.min(calls.critique - 1, verdicts.length - 1)];
    },
  };
}

function runnerWith(refiner, engineReplies, verifierFn) {
  let generated = 0;
  const runner = createBuildRunner({
    config: { MYTHOS_BUILD_CONCURRENCY: 1, BUILD_REFINE_MAX_ITERATIONS: 2 },
    bus: null,
    vault: vault,
    verifier: verifierFn ? { verify: verifierFn } : { verify: async () => ({ pass: true, issues: [], warnings: [] }) },
    buildEngine: {
      generate: async () => {
        const reply = engineReplies[Math.min(generated, engineReplies.length - 1)];
        generated += 1;
        return reply;
      },
    },
    refiner: refiner,
  });
  return { runner, generations: () => generated };
}

// enqueue is fire-and-forget; the job record is mutated in place, so waiting on
// the terminal status is how a test observes the finished pipeline.
function waitForFinish(runner, job) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    (function poll() {
      const j = runner.getJob(job.id);
      if (j && (j.status === 'done' || j.status === 'failed')) return resolve(j);
      if (Date.now() > deadline) return reject(new Error('job never finished: ' + JSON.stringify(j)));
      setTimeout(poll, 10);
    })();
  });
}

describe('build refine loop — bounds and honesty', () => {
  it('a first-look PASS ships the first artifact and renders exactly once', async () => {
    const refiner = fakeRefiner([{ pass: true, verdict: 'VERDICT: PASS', issues: [] }]);
    const { runner, generations } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(shipped, HTML);
    assert.equal(refiner.calls.render, 1);
    assert.equal(generations(), 1, 'a passing first look must not pay for a regeneration');
    assert.equal(done.refineStatus, 'passed-first-look');
    assert.equal(done.refineIterations, 1);
    assert.equal(done.refinePasses.length, 1);
  });

  it('a FAIL regenerates with the critique injected, and a passing second look ships the refined artifact', async () => {
    const refiner = fakeRefiner([
      { pass: false, verdict: 'VERDICT: FAIL', issues: ['the canvas is blank', 'no score is visible'] },
      { pass: true, verdict: 'VERDICT: PASS', issues: [] },
    ]);
    const REFINED = HTML.replace('</body>', '<div id="score">0</div></body>');
    const prompts = [];
    const runner = createBuildRunner({
      config: { MYTHOS_BUILD_CONCURRENCY: 1, BUILD_REFINE_MAX_ITERATIONS: 2 },
      bus: null,
      vault: vault,
      verifier: { verify: async () => ({ pass: true, issues: [], warnings: [] }) },
      buildEngine: {
        generate: async ({ prompt }) => {
          prompts.push(prompt);
          return { content: prompts.length === 1 ? HTML : REFINED, engine: 'hermes' };
        },
      },
      refiner: refiner,
    });
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(shipped, REFINED, 'the improved artifact is what ships');
    assert.equal(done.refineStatus, 'refined');
    assert.equal(done.refineIterations, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /REJECTED/);
    assert.match(prompts[1], /the canvas is blank/,
      'the real critique text must reach the regeneration prompt — a summary of it is not the critique');
    assert.match(prompts[1], /no score is visible/);
  });

  it('is bounded: repeated FAILs stop at the configured maximum and say so, never claiming success', async () => {
    const refiner = fakeRefiner([{ pass: false, verdict: 'VERDICT: FAIL', issues: ['still broken'] }]);
    const { runner } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async () => ({}) });
    const done = await waitForFinish(runner, job);
    assert.equal(done.refineIterations, 2, 'the loop must honour BUILD_REFINE_MAX_ITERATIONS');
    assert.equal(refiner.calls.critique, 2);
    assert.equal(done.refineStatus, 'exhausted',
      'an exhausted loop must not read as a pass — the artifact shipped without visual approval');
    assert.deepEqual(done.refineIssues, ['still broken']);
    assert.equal(done.refinePasses.length, 2, 'every pass is recorded, so refinement is visible not claimed');
  });

  it('a refined artifact that fails the source verifier is REVERTED — the last verified artifact ships', async () => {
    const refiner = fakeRefiner([{ pass: false, verdict: 'VERDICT: FAIL', issues: ['too plain'] }]);
    const BROKEN = '<html><body>regressed</body></html>';
    let verifyCalls = 0;
    const runner = createBuildRunner({
      config: { MYTHOS_BUILD_CONCURRENCY: 1, BUILD_REFINE_MAX_ITERATIONS: 2 },
      bus: null,
      vault: vault,
      verifier: {
        verify: async () => {
          verifyCalls += 1;
          // First call is the original gate (pass); the second judges the
          // refined candidate and rejects it.
          return verifyCalls === 1
            ? { pass: true, issues: [], warnings: [] }
            : { pass: false, issues: ['inline styles are forbidden'], warnings: [] };
        },
      },
      buildEngine: {
        generate: async () => ({ content: verifyCalls === 0 ? HTML : BROKEN, engine: 'hermes' }),
      },
      refiner: refiner,
    });
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(shipped, HTML, 'the verified artifact ships, never the unverified regeneration');
    assert.equal(done.refineStatus, 'reverted');
    assert.deepEqual(done.refineIssues, ['inline styles are forbidden']);
  });

  it('an unreachable vision lane is BLIND — neither a pass nor a build failure', async () => {
    const refiner = fakeRefiner([{ pass: null, verdict: 'the vision lane has no live provider right now', issues: [], blind: true }]);
    const { runner, generations } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done', 'a busy vision lane must not fail a build');
    assert.equal(shipped, HTML);
    assert.equal(done.refineStatus, 'blind');
    assert.match(done.refineSkipReason, /no live provider/);
    assert.equal(generations(), 1, 'nothing is regenerated on a verdict nobody could form');
  });

  it('records an honest skip when the refiner cannot run (no Chrome / no vision lane)', async () => {
    const refiner = fakeRefiner([], { available: false, reason: 'no Chrome/Edge found — set CHROME_PATH' });
    const { runner } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async () => ({}) });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(done.refineStatus, 'skipped');
    assert.match(done.refineSkipReason, /CHROME_PATH/);
    assert.equal(refiner.calls.render, 0);
  });

  it('with the feature off (no refiner injected) the pipeline is byte-for-byte what it was', async () => {
    const { runner } = runnerWith(null, [{ content: HTML, engine: 'hermes' }]);
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(shipped, HTML);
    assert.equal(done.refineStatus, undefined, 'a disabled feature must leave no trace on the job record');
    assert.equal(done.refineIterations, undefined);
    assert.equal(done.refinePasses, undefined);
  });

  it('non-web artifacts are never rendered — there is no visual truth to check', async () => {
    const refiner = fakeRefiner([{ pass: true, verdict: 'PASS', issues: [] }], { renderable: false });
    const { runner } = runnerWith(refiner, [{ content: 'def solve(): return 42', engine: 'hermes' }]);
    const job = runner.enqueue({ kind: 'build', prompt: 'a python solver', run: async () => ({}) });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(refiner.calls.render, 0);
    assert.equal(done.refineStatus, undefined);
  });
});

describe('build-refine.js — renderability and degradation', () => {
  it('recognises web artifacts and rejects everything else', () => {
    assert.equal(looksRenderable('<!DOCTYPE html><html></html>'), true);
    assert.equal(looksRenderable('<html><body>x</body></html>'), true);
    assert.equal(looksRenderable('def solve():\n    return 42'), false);
    assert.equal(looksRenderable('# A markdown report\n\nSome prose.'), false);
    assert.equal(looksRenderable(''), false);
    assert.equal(looksRenderable(null), false);
  });

  it('available() is false with no brain, and the reason names what is missing', () => {
    const r = createBuildRefiner({ vault: vault, brain: null, launcher: {} });
    assert.equal(r.available(), false);
    assert.match(r.unavailableReason(), /vision lane unreachable/);
  });

  it('a blind critique (no screenshot) fails closed and names the render error', async () => {
    const r = createBuildRefiner({ vault: vault, brain: { think: async () => ({}) }, launcher: {} });
    const out = await r.critique({ screenshotB64: null, renderError: 'net::ERR_FILE_NOT_FOUND', consoleErrors: [], pageErrors: [] });
    assert.equal(out.pass, false, 'an artifact nobody could render must not pass');
    assert.match(out.verdict, /could not be rendered/);
    assert.match(out.issues.join(' '), /ERR_FILE_NOT_FOUND/);
  });

  it('a runtime error overrides a model PASS — the model cannot see an exception', async () => {
    const brain = { think: async () => ({ content: 'VERDICT: PASS\nlooks great', provider: 'p', model: 'm' }) };
    // chainFor stub is required whenever brain is a fake: vision-call.js
    // preflights the lane through the REAL registry, so without it this asserts
    // on whether THIS machine has vision keys, not on the critique logic.
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({
      screenshotB64: 'ZmFrZQ==',
      consoleErrors: [],
      pageErrors: ['TypeError: ctx.fillRect is not a function'],
      spec: 'a snake game',
    });
    assert.equal(out.pass, false, 'a page that threw is a failure however good the screenshot looks');
    assert.match(out.issues.join(' '), /TypeError/);
  });

  it('parses the model FAIL shape into concrete issues the regeneration can act on', async () => {
    const brain = { think: async () => ({
      content: 'VERDICT: FAIL\nISSUES:\n- the hero has no type hierarchy\n- invented metric "+47% faster"\n',
      provider: 'p', model: 'm',
    }) };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({ screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'landing page' });
    assert.equal(out.pass, false);
    assert.equal(out.issues.length, 2);
    assert.match(out.issues[0], /type hierarchy/);
    assert.match(out.issues[1], /invented metric/);
  });

  it('an offline vision lane yields pass:null (blind), never a silent pass', async () => {
    const brain = { think: async () => ({ offline: true }) };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({ screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'x' });
    assert.equal(out.pass, null);
    assert.equal(out.blind, true);
  });
});
