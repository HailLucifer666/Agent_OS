'use strict';

// effectors/build-refine.js — render the artifact, LOOK at it, critique it.
//
// THE PROBLEM THIS EXISTS FOR (operator, 2026-08-14, the "snake game test"):
// a build was accepted on its first generation. The verifier reads the SOURCE
// (rule checks + an LLM judge on the text), so an artifact that parses, passes
// every rule and throws a TypeError on line 1 at runtime shipped as done —
// and one that ran but looked like model slop shipped as done too. Nothing in
// the pipeline had ever seen the thing rendered.
//
// So this module is deliberately only two capabilities, both oracle-backed:
//   render()   — open the artifact in a real headless Chrome, collect real
//                console errors and page errors, take a real screenshot.
//   critique() — hand that screenshot to the vision lane and ask whether it
//                runs, meets the spec, and looks designed rather than generated.
//
// It decides nothing. build-runner.js owns the loop, the iteration bound and
// the ship/fail decision, so the policy lives next to the job record it stamps.
//
// DEGRADATION (repo rule: optional binaries degrade, they never fail a boot).
// playwright-core ships no browser, so this needs the operator's installed
// Chrome — exactly like from-docs.js's PDF path. No Chrome, or no vision lane,
// means available() is false and the runner skips refinement and says so on the
// job record. A build is never blocked by a missing refiner; it just doesn't
// get refined, visibly rather than silently.

const fs = require('fs');
const path = require('path');
const { visionThink } = require('./vision-call');

// Same probe shape as from-docs.js's resolveChromePath (Windows-first, per
// CLAUDE.md), kept separate rather than exported across effectors because this
// one also accepts an explicit override for tests.
function resolveChromePath(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

// Only web artifacts can be rendered. A python library or a markdown report has
// no visual truth to check, and pretending otherwise would put a vision call in
// front of every build for nothing.
function looksRenderable(content) {
  const s = String(content || '').slice(0, 4000).toLowerCase();
  return s.indexOf('<!doctype html') !== -1 || s.indexOf('<html') !== -1
    || (s.indexOf('<body') !== -1 && s.indexOf('<') !== -1);
}

const RENDER_TIMEOUT_MS = 20000;
// After load, give scripts a beat to actually run: a canvas game's TypeError
// happens on the first animation frame, not at parse time. Short, because this
// sits inside a build the operator is waiting on.
const SETTLE_MS = 1200;
const VIEWPORT = { width: 1280, height: 800 };

// MEASURED FACTS ABOUT THE LIVE PAGE, so the critique cannot deny what is
// demonstrably there (2026-08-14, third real end-to-end build). The vision model
// returned "No visible snake, food, score display" for a page whose screenshot
// plainly showed a score line, a green snake segment and red food — the game
// elements were simply small. A false FAIL costs a whole regeneration and
// mislabels a working build, so the model is handed observations it must not
// contradict: the page's own visible text, and how much of each canvas is
// actually painted.
//
// Canvas ink is the repo's existing discipline for exactly this (a canvas cannot
// be judged from a screenshot alone — measure pixels). Sampled every 4th pixel:
// enough to distinguish "blank" from "drawn" without moving megabytes.
async function observe(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, 4).map((c, i) => {
        const out = { id: c.id || ('canvas' + i), w: c.width, h: c.height, inkPct: null };
        try {
          const ctx = c.getContext('2d');
          if (!ctx) return out;                       // webgl or unavailable — say null, never 0
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const counts = new Map();
          let sampled = 0;
          for (let p = 0; p < d.length; p += 16) {    // every 4th pixel (4 bytes each)
            const key = (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
            counts.set(key, (counts.get(key) || 0) + 1);
            sampled += 1;
          }
          let dominant = 0;
          counts.forEach((n) => { if (n > dominant) dominant = n; });
          out.inkPct = sampled ? Math.round(((sampled - dominant) / sampled) * 1000) / 10 : null;
        } catch (_) { /* tainted or unreadable canvas — null, not a fake number */ }
        return out;
      });
      return {
        visibleText: text.slice(0, 400),
        canvases: canvases,
        counts: {
          canvas: document.querySelectorAll('canvas').length,
          button: document.querySelectorAll('button').length,
          input: document.querySelectorAll('input,select,textarea').length,
          img: document.querySelectorAll('img,svg').length,
        },
      };
    });
  } catch (_) {
    return null;   // observation is a bonus; never fail a render over it
  }
}

// Render the observations into prompt lines. Returns '' when there is nothing
// measured, so the prompt never carries an empty "facts" heading.
function observedFactsBlock(obs) {
  if (!obs) return '';
  const lines = [];
  if (obs.visibleText) lines.push('- Text actually rendered on the page: "' + obs.visibleText + '"');
  // A RAW PERCENTAGE GETS MISREAD, so the fact is stated as a conclusion with
  // the number as support (2026-08-14, fifth real build). Handing the model a
  // bare "0.9% of pixels painted" for a snake board holding three snake
  // segments and one piece of food produced "no game elements are visible or
  // rendered" — a false FAIL against a screenshot that plainly showed them. A
  // sparse game board IS a low percentage: a few dozen small shapes on 500x500
  // is well under 2%. Only 0.0% means nothing was drawn at all, so that is the
  // distinction worth stating, rather than leaving the model to invent a
  // threshold from a number it has no reference for.
  (obs.canvases || []).forEach((c) => {
    var size = c.w + 'x' + c.h;
    if (c.inkPct === null) {
      lines.push('- <canvas id="' + c.id + '"> is ' + size + ' — its pixels could not be measured');
    } else if (c.inkPct <= 0) {
      lines.push('- <canvas id="' + c.id + '"> is ' + size + ' and is COMPLETELY BLANK'
        + ' (0% of pixels differ from the background — nothing was drawn)');
    } else {
      lines.push('- <canvas id="' + c.id + '"> is ' + size + ' and HAS DRAWN CONTENT on it'
        + ' (' + c.inkPct + '% of pixels differ from the background; a handful of small game pieces on a'
        + ' board this size is expected to measure only 1-3%, so this is NOT an empty canvas)');
    }
  });
  if (obs.counts) {
    lines.push('- Element counts: ' + obs.counts.canvas + ' canvas, ' + obs.counts.button + ' button, '
      + obs.counts.input + ' input, ' + obs.counts.img + ' image/svg');
  }
  if (!lines.length) return '';
  return ['MEASURED FACTS about the live page (from the DOM, not opinions — do NOT contradict these):']
    .concat(lines).join('\n');
}

// DEAD ON ARRIVAL, decided in code (2026-08-14, sixth real build). The output
// contract forbids an artifact that opens on a game-over/error screen, and the
// vision model returned VERDICT: PASS for a snake game whose screenshot showed a
// "Game Over!" overlay and a Restart button. A false PASS is strictly worse than
// a false FAIL — it ships — so this stops being the model's judgement call.
//
// Nothing has touched the keyboard at this point: the render loads the page,
// waits, and looks. Terminal-state text on screen therefore means the artifact
// reached that state on its own, which is the failure by definition. Kept
// deliberately tight (no bare "restart" or "score" — both are normal furniture on
// an idle screen) so it cannot fire on a game that is simply waiting to be played.
var DEAD_ON_ARRIVAL_RE = /\bgame over\b|\byou (?:lose|lost|died)\b|\bfinal score\b|\btry again\b/i;

function deadOnArrival(observations) {
  if (!observations || !observations.visibleText) return null;
  var m = String(observations.visibleText).match(DEAD_ON_ARRIVAL_RE);
  return m ? m[0] : null;
}

function createBuildRefiner(opts) {
  const o = opts || {};
  const vault = o.vault;
  const brain = o.brain;
  const config = o.config || {};
  const logger = o.logger || null;
  const chromePath = resolveChromePath(o.chromePath);
  // Test seam. Production passes nothing and gets the real playwright-core.
  const launcher = o.launcher || null;
  // Second test seam, and it is not optional for a fake brain: visionThink
  // preflights the vision lane through the REAL registry, so an injected
  // brain.think is never reached on a machine with no vision keys — the
  // critique comes back laneEmpty/blind and a test asserting on the model's
  // verdict is really asserting on this machine's .env. vision-call.js
  // documents exactly this ("a caller passing a different/fake brain should
  // inject a stub here too"). Production passes nothing.
  const chainFor = typeof o.chainFor === 'function' ? o.chainFor : null;

  function chromium() {
    if (launcher) return launcher;
    // Lazy: a require at module scope would make an absent/broken
    // playwright-core a boot failure instead of a missing capability.
    return require('playwright-core').chromium;
  }

  function available() {
    if (!vault || typeof vault.vaultPath !== 'function') return false;
    if (!brain || typeof brain.think !== 'function') return false;
    if (launcher) return true;
    if (!chromePath) return false;
    try { require.resolve('playwright-core'); } catch (_) { return false; }
    return true;
  }

  function unavailableReason() {
    if (!vault || typeof vault.vaultPath !== 'function') return 'no vault store';
    if (!brain || typeof brain.think !== 'function') return 'no brain (vision lane unreachable)';
    if (!launcher && !chromePath) return 'no Chrome/Edge found — set CHROME_PATH to enable build refinement';
    return 'playwright-core is not installed';
  }

  /**
   * Render HTML in a real browser. Returns real observations only:
   * screenshot bytes, console errors, uncaught page errors.
   * Never throws — a render that fails IS an observation, and the caller has to
   * be able to tell the model why it saw nothing.
   */
  async function render(html, tag) {
    const dirRel = path.join('builds', 'refine');
    const stem = String(tag || 'artifact').replace(/[^\w.-]+/g, '-').slice(0, 60);
    const htmlAbs = vault.vaultPath(path.join(dirRel, stem + '.html'));
    const pngAbs = vault.vaultPath(path.join(dirRel, stem + '.png'));
    fs.mkdirSync(path.dirname(htmlAbs), { recursive: true });
    fs.writeFileSync(htmlAbs, String(html), 'utf8');

    let browser = null;
    const consoleErrors = [];
    const pageErrors = [];
    try {
      browser = await chromium().launch({ executablePath: chromePath || undefined, headless: true });
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(String(msg.text()).slice(0, 300));
      });
      page.on('pageerror', (err) => {
        pageErrors.push(String((err && err.message) || err).slice(0, 300));
      });
      await page.goto('file:///' + htmlAbs.replace(/\\/g, '/'), { timeout: RENDER_TIMEOUT_MS, waitUntil: 'load' });
      await page.waitForTimeout(SETTLE_MS);
      const observations = await observe(page);
      const shot = await page.screenshot({ path: pngAbs, fullPage: false });
      const payload = await page.screenshot({ type: 'jpeg', quality: 80 });
      await browser.close();
      browser = null;
      return {
        ok: true,
        screenshotPath: pngAbs,
        screenshotB64: Buffer.from(payload).toString('base64'),
        screenshotBytes: shot.length,
        consoleErrors: consoleErrors,
        pageErrors: pageErrors,
        observations: observations,
        htmlPath: htmlAbs,
      };
    } catch (err) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      return {
        ok: false,
        error: String((err && err.message) || err).slice(0, 300),
        screenshotPath: null,
        screenshotB64: null,
        consoleErrors: consoleErrors,
        pageErrors: pageErrors,
      };
    }
  }

  /**
   * Ask the vision lane whether the rendered artifact runs, matches the spec,
   * and looks designed. Returns { pass, verdict, issues, provider, model }.
   *
   * A runtime error is decided in CODE, not by the model: a page that threw is
   * a fail regardless of how good the screenshot looks, because the model
   * cannot see an exception. Everything else is the model's judgement, and its
   * prose is passed through verbatim so the regeneration prompt carries the
   * real critique rather than a summary of it.
   */
  async function critique(args) {
    const a = args || {};
    const runtimeErrors = (a.pageErrors || []).concat(a.consoleErrors || []);
    const doa = deadOnArrival(a.observations);
    if (!a.screenshotB64) {
      return {
        pass: false,
        verdict: 'the artifact could not be rendered' + (a.renderError ? ' (' + a.renderError + ')' : ''),
        issues: ['render failed' + (a.renderError ? ': ' + a.renderError : '')].concat(runtimeErrors),
        blind: true,
      };
    }

    const prompt = [
      'You are reviewing a screenshot of a web artifact that was just generated from this brief:',
      '"' + String(a.spec || '').slice(0, 600) + '"',
      '',
      runtimeErrors.length
        ? 'The page reported these runtime errors: ' + runtimeErrors.slice(0, 5).join(' | ')
        : 'The page loaded with no console or runtime errors.',
      observedFactsBlock(a.observations),
      '',
      'Judge it on three things, in this order:',
      '1. DOES IT WORK — is the thing the brief asked for actually visible and in a usable state,',
      '   or is the page blank/broken/half-rendered?',
      '2. DOES IT MEET THE BRIEF — every element the brief names, nothing invented that contradicts it.',
      '3. DOES IT LOOK DESIGNED — deliberate type hierarchy and spacing, a real colour decision,',
      '   no default-template slop, no fabricated metrics or placeholder lorem text.',
      '',
      // Both rules below were written against real false FAILs from the third
      // end-to-end run: the model called a visible score and visible game pieces
      // absent, and treated "nothing is moving" as "nothing works".
      'Two rules about what you are looking at:',
      '- This is ONE STILL FRAME. It cannot show motion, keyboard input or gameplay. Judge whether the',
      '  pieces are PRESENT and correctly laid out; never fail something for not appearing animated,',
      '  and never claim a control is missing merely because you cannot see it being used.',
      '- Small is not absent, and sparse is not blank. If the measured facts above say text is rendered',
      '  or a canvas HAS DRAWN CONTENT, that content EXISTS — say it is too small or low-contrast if',
      '  that is the problem, but never report it as missing, and never treat a low painted-pixel',
      '  percentage as an empty canvas. Only "COMPLETELY BLANK" means nothing was drawn.',
      '',
      'Answer in exactly this shape:',
      'VERDICT: PASS or FAIL',
      'ISSUES: one short line per concrete problem, each naming what to change. Omit if PASS.',
      'Be strict about 1 and 2 and honest about 3. Do not pass something you cannot see working.',
      // Blank lines are kept deliberately (they separate the sections for the
      // model); only the facts block collapses away when there is nothing
      // measured, and it emits '' for that case.
    ].join('\n');

    const visionOpts = {
      prompt: prompt,
      b64: a.screenshotB64,
      mime: 'image/jpeg',
      timeoutMs: config.VISION_CALL_TIMEOUT_MS,
      attemptTimeoutMs: config.VISION_ATTEMPT_TIMEOUT_MS,
      source: 'build-refine',
      logger: logger,
    };
    if (chainFor) visionOpts.chainFor = chainFor;
    // BUG-427: Sept 9's 1857ms loop stall overlapped vision. Reuse logged facts;
    // no second timer, no global maximum that attributes an old stall to this call.
    let maxLoopStallMs = 0, unsubscribe = null, res;
    try {
      if (logger && typeof logger.onLog === 'function') unsubscribe = logger.onLog(entry => {
        if (entry.msg === 'loop.stalled') maxLoopStallMs = Math.max(maxLoopStallMs, Number(entry.lagMs) || 0);
      });
    } catch (_) { /* telemetry must not disable refinement */ }
    try { res = await visionThink(brain, visionOpts); }
    finally {
      try { if (unsubscribe) unsubscribe(); } catch (_) { /* telemetry only */ }
      try { if (logger) logger.info('build-refine.vision-payload', {
        screenshotBytes: a.screenshotBytes ?? null,
        visionPayloadBytes: Buffer.from(a.screenshotB64, 'base64').length, maxLoopStallMs,
      }); } catch (_) { /* telemetry only */ }
    }

    if (res.offline || res.timedOut || !res.content) {
      // Honest unknown. NOT a pass (that would ship on silence) and NOT a fail
      // (that would fail a build because a free-tier vision lane was busy) —
      // the caller keeps the artifact and records that refinement was blind.
      return {
        pass: null,
        verdict: res.laneEmpty ? (res.reason || 'vision lane empty')
          : (res.timedOut ? 'the vision model did not answer in time' : 'the vision lane was unreachable'),
        issues: runtimeErrors,
        blind: true,
        provider: res.provider || null,
        model: res.model || null,
      };
    }

    const text = String(res.content);
    const modelPassed = /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text);
    // Code-decided failures, collected before the model's verdict is honoured.
    const hardFailures = runtimeErrors.slice();
    if (doa) {
      hardFailures.push('the artifact opens on a terminal state ("' + doa + '") with no input given —'
        + ' it must open in a ready state that waits for the user');
    }
    const issues = [];
    const issuesBlock = text.split(/ISSUES:/i)[1];
    if (issuesBlock) {
      issuesBlock.split(/\r?\n/).forEach((line) => {
        const t = line.replace(/^[-*\d.\s]+/, '').trim();
        if (t && t.length > 3) issues.push(t.slice(0, 300));
      });
    }
    // Code-decided failures override the model in BOTH directions of its error:
    // it cannot see an exception at all, and it demonstrably passed a page whose
    // own text said "Game Over!". Deterministic observations win.
    const pass = modelPassed && hardFailures.length === 0;
    return {
      pass: pass,
      verdict: text.slice(0, 800),
      issues: hardFailures.concat(issues).slice(0, 8),
      blind: false,
      provider: res.provider || null,
      model: res.model || null,
      ms: res.ms,
    };
  }

  return {
    available: available,
    unavailableReason: unavailableReason,
    looksRenderable: looksRenderable,
    render: render,
    critique: critique,
    _chromePath: chromePath,
  };
}

module.exports = {
  createBuildRefiner, looksRenderable, resolveChromePath,
  deadOnArrival, observedFactsBlock,
};
