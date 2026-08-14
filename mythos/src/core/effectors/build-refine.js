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

function createBuildRefiner(opts) {
  const o = opts || {};
  const vault = o.vault;
  const brain = o.brain;
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
      const shot = await page.screenshot({ path: pngAbs, fullPage: false });
      await browser.close();
      browser = null;
      return {
        ok: true,
        screenshotPath: pngAbs,
        screenshotB64: Buffer.from(shot).toString('base64'),
        consoleErrors: consoleErrors,
        pageErrors: pageErrors,
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
      '',
      'Judge it on three things, in this order:',
      '1. DOES IT WORK — is the thing the brief asked for actually visible and in a usable state,',
      '   or is the page blank/broken/half-rendered?',
      '2. DOES IT MEET THE BRIEF — every element the brief names, nothing invented that contradicts it.',
      '3. DOES IT LOOK DESIGNED — deliberate type hierarchy and spacing, a real colour decision,',
      '   no default-template slop, no fabricated metrics or placeholder lorem text.',
      '',
      'Answer in exactly this shape:',
      'VERDICT: PASS or FAIL',
      'ISSUES: one short line per concrete problem, each naming what to change. Omit if PASS.',
      'Be strict about 1 and 2 and honest about 3. Do not pass something you cannot see working.',
    ].join('\n');

    const visionOpts = {
      prompt: prompt,
      b64: a.screenshotB64,
      mime: 'image/png',
      source: 'build-refine',
      logger: logger,
    };
    if (chainFor) visionOpts.chainFor = chainFor;
    const res = await visionThink(brain, visionOpts);

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
    const issues = [];
    const issuesBlock = text.split(/ISSUES:/i)[1];
    if (issuesBlock) {
      issuesBlock.split(/\r?\n/).forEach((line) => {
        const t = line.replace(/^[-*\d.\s]+/, '').trim();
        if (t && t.length > 3) issues.push(t.slice(0, 300));
      });
    }
    // Runtime errors override the model: it cannot see an exception, and a
    // screenshot of a broken game can look perfectly reasonable.
    const pass = modelPassed && runtimeErrors.length === 0;
    return {
      pass: pass,
      verdict: text.slice(0, 800),
      issues: runtimeErrors.concat(issues).slice(0, 8),
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

module.exports = { createBuildRefiner, looksRenderable, resolveChromePath };
