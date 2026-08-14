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
const { createBuildRefiner, looksRenderable, deadOnArrival } = require('../src/core/effectors/build-refine');

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
// what is under test rather than a model's opinion. opts.pageErrors makes the
// render report real-shaped runtime errors, which is how the known-broken tests
// below reproduce the first end-to-end run's failure.
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
        pageErrors: o.pageErrors ? o.pageErrors.slice() : [],
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

  // ---- known-broken never ships (the first real end-to-end run) ------------
  //
  // 2026-08-14, first e2e build against the real Hermes engine: its snake game
  // called an undefined function, the loop caught the real pageError, the
  // regeneration was REJECTED by the source verifier over a style rule, and the
  // revert branch shipped the throwing original as status:done. "Last verified"
  // is not "works" — the verifier reads source and cannot see a runtime error.

  it('REVERTED with a throwing original fails the job instead of shipping it as done', async () => {
    const refiner = fakeRefiner([{ pass: false, verdict: 'VERDICT: FAIL', issues: ['game is not playable'] }],
      { pageErrors: ['checkFoodCollision is not defined'] });
    let verifyCalls = 0;
    let shipped = null;
    const runner = createBuildRunner({
      config: { MYTHOS_BUILD_CONCURRENCY: 1, BUILD_REFINE_MAX_ITERATIONS: 2 },
      bus: null,
      vault: vault,
      verifier: {
        verify: async () => {
          verifyCalls += 1;
          // The original clears the gate; the refined candidate is rejected on a
          // style rule — exactly the real run's shape.
          return verifyCalls === 1
            ? { pass: true, issues: [], warnings: [] }
            : { pass: false, issues: ['no @media queries (not responsive)'], warnings: [] };
        },
      },
      buildEngine: { generate: async () => ({ content: HTML, engine: 'hermes' }) },
      refiner: refiner,
    });
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'failed', 'an artifact watched throwing must never be status:done');
    assert.equal(shipped, null, 'run() must not be reached — nothing is written');
    assert.match(done.error, /throws when it runs/);
    assert.match(done.error, /checkFoodCollision is not defined/,
      'the failure must name the real runtime error, not a generic refinement message');
    assert.deepEqual(done.refineRuntimeErrors, ['checkFoodCollision is not defined']);
    assert.equal(done.refineStatus, 'reverted', 'the disposition stays visible on the job record');
  });

  it('a BLIND verdict on a throwing page also fails — no model needed to see an exception', async () => {
    const refiner = fakeRefiner([{ pass: null, verdict: 'the vision lane was unreachable', issues: [], blind: true }],
      { pageErrors: ['TypeError: ctx.fillRect is not a function'] });
    const { runner } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async () => ({}) });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /ctx\.fillRect is not a function/);
  });

  it('a BLIND verdict on a CLEAN page still ships — unknown-looking is not broken', async () => {
    const refiner = fakeRefiner([{ pass: null, verdict: 'the vision lane was unreachable', issues: [], blind: true }]);
    const { runner } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    let shipped = null;
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(shipped, HTML);
    assert.equal(done.refineRuntimeErrors, undefined);
  });

  it('an accepted-but-unrendered final candidate is EXHAUSTED, never asserted broken or clean', async () => {
    // The candidate passes the source verifier on the last iteration and the
    // loop ends before it can be rendered. Whether it throws is genuinely
    // unknown, so the job must neither fail nor claim the artifact runs.
    const refiner = fakeRefiner([{ pass: false, verdict: 'VERDICT: FAIL', issues: ['too plain'] }],
      { pageErrors: ['old error from the ORIGINAL artifact'] });
    const REFINED = HTML.replace('</body>', '<div>fixed</div></body>');
    let generated = 0;
    let shipped = null;
    const runner = createBuildRunner({
      config: { MYTHOS_BUILD_CONCURRENCY: 1, BUILD_REFINE_MAX_ITERATIONS: 1 },
      bus: null,
      vault: vault,
      verifier: { verify: async () => ({ pass: true, issues: [], warnings: [] }) },
      buildEngine: { generate: async () => { generated += 1; return { content: generated === 1 ? HTML : REFINED, engine: 'hermes' }; } },
      refiner: refiner,
    });
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async (raw) => { shipped = raw; return {}; } });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done', 'an unrendered candidate is not known-broken');
    assert.equal(shipped, REFINED);
    assert.equal(done.refineStatus, 'exhausted');
    assert.equal(done.refineRuntimeErrors, undefined,
      'the ORIGINAL artifact errors must not be attributed to the candidate that replaced it');
  });

  it('a PASS on a clean page is unaffected by the known-broken guard', async () => {
    const refiner = fakeRefiner([{ pass: true, verdict: 'VERDICT: PASS', issues: [] }]);
    const { runner } = runnerWith(refiner, [{ content: HTML, engine: 'hermes' }]);
    const job = runner.enqueue({ kind: 'build', prompt: 'a snake game', run: async () => ({}) });
    const done = await waitForFinish(runner, job);
    assert.equal(done.status, 'done');
    assert.equal(done.refineStatus, 'passed-first-look');
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

  // ---- measured facts in the critique prompt --------------------------------
  //
  // Third real end-to-end run (2026-08-14): the model returned "No visible
  // snake, food, score display" for a page whose screenshot plainly showed a
  // score line, a green snake segment and red food — they were just small. A
  // false FAIL costs a whole regeneration and mislabels a working build, so the
  // prompt now carries facts the model must not contradict.

  it('puts measured DOM/canvas facts in the critique prompt', async () => {
    let seenPrompt = null;
    const brain = { think: async (req) => {
      seenPrompt = req.messages[0].content.find((p) => p.type === 'text').text;
      return { content: 'VERDICT: PASS', provider: 'p', model: 'm' };
    } };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    await r.critique({
      screenshotB64: 'ZmFrZQ==',
      consoleErrors: [], pageErrors: [],
      spec: 'a snake game with a visible score',
      observations: {
        visibleText: 'Score: 0',
        canvases: [{ id: 'game-canvas', w: 500, h: 500, inkPct: 1.4 }],
        counts: { canvas: 1, button: 0, input: 0, img: 0 },
      },
    });
    assert.match(seenPrompt, /MEASURED FACTS/);
    assert.match(seenPrompt, /Score: 0/, 'the text actually on the page must reach the model');
    assert.match(seenPrompt, /game-canvas.*500x500.*HAS DRAWN CONTENT/,
      'a painted canvas is stated as a conclusion — a bare percentage was read as "empty"');
    assert.match(seenPrompt, /NOT an empty canvas/);
    assert.match(seenPrompt, /Small is not absent, and sparse is not blank/, 'the rule that killed the false FAIL must be stated');
    assert.match(seenPrompt, /ONE STILL FRAME/, 'a still frame cannot show motion — say so');
  });

  it('omits the facts block entirely when nothing could be measured', async () => {
    let seenPrompt = null;
    const brain = { think: async (req) => {
      seenPrompt = req.messages[0].content.find((p) => p.type === 'text').text;
      return { content: 'VERDICT: PASS', provider: 'p', model: 'm' };
    } };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    await r.critique({ screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'x', observations: null });
    assert.doesNotMatch(seenPrompt, /MEASURED FACTS/,
      'an empty facts heading would invite the model to invent facts under it');
  });

  it('states a blank canvas as COMPLETELY BLANK and a sparse one as having content', async () => {
    // The fifth real build failed a snake game holding three snake segments and
    // one piece of food, because the prompt handed it a bare "0.9% painted" and
    // it read that as empty. 0.0% is the only measurement that means blank.
    let prompts = [];
    const brain = { think: async (req) => {
      prompts.push(req.messages[0].content.find((p) => p.type === 'text').text);
      return { content: 'VERDICT: PASS', provider: 'p', model: 'm' };
    } };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const base = { screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'a snake game' };
    // Assert on the FACT line, not the whole prompt: the standing rules below it
    // legitimately quote both phrases, so a whole-prompt match proves nothing.
    const canvasFact = (p) => p.split('\n').find((l) => l.indexOf('- <canvas') === 0);
    await r.critique(Object.assign({}, base, {
      observations: { visibleText: 'Score: 0', canvases: [{ id: 'c', w: 500, h: 500, inkPct: 0.9 }], counts: null },
    }));
    assert.match(canvasFact(prompts[0]), /HAS DRAWN CONTENT/);
    assert.doesNotMatch(canvasFact(prompts[0]), /COMPLETELY BLANK/);
    await r.critique(Object.assign({}, base, {
      observations: { visibleText: '', canvases: [{ id: 'c', w: 500, h: 500, inkPct: 0 }], counts: null },
    }));
    assert.match(canvasFact(prompts[1]), /COMPLETELY BLANK/);
    assert.doesNotMatch(canvasFact(prompts[1]), /HAS DRAWN CONTENT/);
  });

  it('reports an unmeasurable canvas as unmeasured, never as 0% painted', async () => {
    let seenPrompt = null;
    const brain = { think: async (req) => {
      seenPrompt = req.messages[0].content.find((p) => p.type === 'text').text;
      return { content: 'VERDICT: PASS', provider: 'p', model: 'm' };
    } };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    await r.critique({
      screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'x',
      observations: { visibleText: '', canvases: [{ id: 'gl', w: 300, h: 150, inkPct: null }], counts: null },
    });
    assert.match(seenPrompt, /could not be measured/);
    assert.doesNotMatch(seenPrompt, /0% of its pixels/,
      'a webgl/tainted canvas is unknown — reporting 0% would be a fabricated measurement');
  });

  // ---- dead on arrival: a code-decided failure -----------------------------
  //
  // Sixth real build: the vision model returned VERDICT: PASS for a snake game
  // whose screenshot showed a "Game Over!" overlay and a Restart button. The
  // output contract forbids exactly that, and a false PASS ships — so terminal
  // state on first render is now decided in code, not by the model.

  it('detects terminal-state text, and only terminal-state text', () => {
    // The captured phrase is the match itself — punctuation around it is not
    // part of the pattern, and asserting on '!' would pin the wrong thing.
    assert.equal(deadOnArrival({ visibleText: 'Score: 0 Game Over! Restart' }), 'Game Over');
    assert.equal(deadOnArrival({ visibleText: 'You lost — final score 12' }), 'You lost');
    assert.equal(deadOnArrival({ visibleText: 'Try Again' }), 'Try Again');
    // Idle screens that must NOT trip it: a restart button or a score readout is
    // normal furniture on a game waiting to be played.
    assert.equal(deadOnArrival({ visibleText: 'Score: 0 Press an arrow key to start' }), null);
    assert.equal(deadOnArrival({ visibleText: 'Snake — Restart  Pause  Score: 0' }), null);
    assert.equal(deadOnArrival({ visibleText: '' }), null);
    assert.equal(deadOnArrival(null), null);
  });

  it('a model PASS is overridden when the page opens on a terminal state', async () => {
    const brain = { think: async () => ({ content: 'VERDICT: PASS\nlooks good', provider: 'p', model: 'm' }) };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({
      screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'a playable snake game',
      observations: { visibleText: 'Game Over! Score: 0 Restart', canvases: [{ id: 'c', w: 400, h: 400, inkPct: 3 }], counts: null },
    });
    assert.equal(out.pass, false, 'a false PASS ships a dead-on-arrival artifact — code must win here');
    assert.match(out.issues.join(' '), /opens on a terminal state/);
    assert.match(out.issues.join(' '), /Game Over/);
  });

  it('an idle ready-state page still passes — the guard must not eat good builds', async () => {
    const brain = { think: async () => ({ content: 'VERDICT: PASS', provider: 'p', model: 'm' }) };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({
      screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'a playable snake game',
      observations: { visibleText: 'Score: 0 Press an arrow key to begin', canvases: [{ id: 'c', w: 400, h: 400, inkPct: 1.1 }], counts: null },
    });
    assert.equal(out.pass, true);
  });

  it('an offline vision lane yields pass:null (blind), never a silent pass', async () => {
    const brain = { think: async () => ({ offline: true }) };
    const r = createBuildRefiner({ vault: vault, brain: brain, launcher: {}, chainFor: async () => ['fake'] });
    const out = await r.critique({ screenshotB64: 'ZmFrZQ==', consoleErrors: [], pageErrors: [], spec: 'x' });
    assert.equal(out.pass, null);
    assert.equal(out.blind, true);
  });
});
