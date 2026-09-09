'use strict';
// from-browser-use.js — ONE tool, `browser_task`: hand a multi-step browser job to the
// browser-use agent (services/browser-use-runner.py) in plain English and get back what it
// proved. "Play the second video on YouTube", "fill the form at <url> with ...", "search X
// and open the first result".
//
// Why a separate agent and not the 17 browser_* tools: measured Aug–Sep 2026, 149 completed
// browser_* calls, 28 failed, and the failures were never the tools — elements not ready in
// 8 s, stale refs, or the model failing to plan the next step at all ("I couldn't process
// that", zero calls). browser-use observes, acts, re-observes and retries as one loop. The
// browser_* tools stay for single deterministic steps; open_web stays for "open this URL".
//
// Contract (see also the plan of 2026-09-08):
//   input   { task: string <= 500 chars, url?: https URL }
//   output  ok:true  -> { summary, steps, final_url, final_title, model, seconds }
//           ok:false -> { result: <spoken-usable reason> }   one reason per failure mode
//   unverified:true when the runner says done but the page never left about:blank — a
//   "done" with nothing observable is a claim, not evidence (dispatch-action.js contract).
//
// Provider/model come from BROWSER_USE_MODEL ("<provider>/<model>", default
// google/gemini-3.6-flash). The key for that provider is the ONLY key handed to the child.
// The customer brings the key and pays for the calls; a quota hit comes back as a reason
// that names the provider so the spoken reply can say so.

const path = require('node:path');
const { effectorFromTool } = require('./adapter');
const location = require('../browser-use-location');

const MAX_TASK_CHARS = 500;
const DEFAULT_MODEL = 'google/gemini-3.6-flash';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_STEPS = 25;
const KEY_FOR_PROVIDER = { google: ['GOOGLE_API_KEY'], groq: ['GROQ_API_KEY'], mistral: ['MISTRAL_API_KEY'], openai: ['OPENAI_API_KEY'], 'openai-compatible': ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] };
const RUNNER = path.join(__dirname, '..', '..', '..', 'services', 'browser-use-runner.py');

const ok = (result) => ({ ok: true, result });
const fail = (reason, extra) => Object.assign({ ok: false, result: reason }, extra || {});

function parseModel(value) {
  const s = String(value || DEFAULT_MODEL).trim();
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

function parseUrl(url) {
  if (url === undefined || url === null || url === '') return null;
  let u; try { u = new URL(String(url)); } catch { return { error: 'url must be an absolute http(s) URL' }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { error: 'url must be a credential-free http(s) URL' };
  return { href: u.href, host: u.hostname };
}

// Exit code -> reason. One place, one mapping (defect class 15: a boolean on a multi-way
// failure hides which way it failed).
function reasonFor(code, payload, provider) {
  const err = payload && payload.error ? String(payload.error) : '';
  if (code === 4) return 'No debuggable browser was reachable for the browser task' + (err ? ' (' + err + ')' : '') + '.';
  if (code === 3) return 'The browser task stopped on a ' + provider + ' model error: ' + (err || 'provider refused the request') + '. That is the ' + provider + ' key\'s quota or plan, not the page.';
  if (code === 5) return 'The browser task runner rejected its input: ' + err;
  if (code === 2) {
    // Live 2026-09-08 13:58: the run reached the trailer's watch page, then the model 503'd on the
    // next step and this said only "stopped" — the operator was told nothing opened while it played.
    const reached = payload && payload.final_url && payload.final_url !== 'about:blank' ? ' The last page reached was ' + (payload.final_title ? JSON.stringify(payload.final_title) + ' at ' : '') + payload.final_url + ', which may already be what you asked for.' : '';
    return 'The browser task stopped before finishing' + (payload && payload.steps ? ' after ' + payload.steps + ' steps' : '') + (err ? ': ' + err : '') + '.' + reached;
  }
  return 'The browser task runner exited with code ' + code + (err ? ': ' + err : '') + '.';
}

function buildTools(deps = {}) {
  const config = deps.config || {};
  const browserAgent = deps.browserAgent || null;
  const launchDebug = deps.launchDebug || null;
  const findInstalled = deps.findInstalled || location.findInstalled;
  const spawn = deps.spawn || require('node:child_process').spawn;
  const env = deps.env || process.env;
  const timeoutMs = Number(config.BROWSER_USE_TIMEOUT_MS) > 0 ? Number(config.BROWSER_USE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const maxSteps = Number(config.BROWSER_USE_MAX_STEPS) > 0 ? Number(config.BROWSER_USE_MAX_STEPS) : DEFAULT_MAX_STEPS;

  function browserOnline() {
    try { const st = browserAgent && browserAgent.getStatus && browserAgent.getStatus(); return !!st && String(st.state || '').toUpperCase() === 'ONLINE'; }
    catch { return false; }
  }

  async function ensureBrowser() {
    if (browserOnline()) return { ok: true, launched: false };
    if (!launchDebug) return fail('No debuggable browser is attached and none can be launched from here.');
    const r = await launchDebug({ browser: config.BROWSER_USE_BROWSER || 'brave' });
    if (!r || r.ok !== true) return fail('Could not start a debug browser for the task: ' + (r && (r.result || r.error) || 'launch refused') + '.');
    return { ok: true, launched: true };
  }

  function runRunner(installed, req, keyEnv, signal) {
    return new Promise((resolve) => {
      const command = deps.runnerCommand || installed.python;
      const args = deps.runnerArgs || [RUNNER];
      let child;
      try { child = spawn(command, args, { cwd: path.dirname(RUNNER), env: keyEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return resolve({ code: null, error: e.message, stdout: '', stderr: '' }); }
      let stdout = '', stderr = '', settled = false;
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(v); };
      const kill = () => { try { child.kill(); } catch { /* already gone */ } };
      const timer = setTimeout(() => { kill(); finish({ code: null, timedOut: true, stdout, stderr }); }, timeoutMs);
      const onAbort = () => { kill(); finish({ code: null, aborted: true, stdout, stderr }); };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => finish({ code: null, error: e.message, stdout, stderr }));
      child.on('close', (code) => finish({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(req));
    });
  }

  async function browser_task(args = {}, ctx = {}) {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return fail('browser_task needs a task: say what to do in the browser in plain English.', { notExecuted: true });
    if (task.length > MAX_TASK_CHARS) return fail('browser_task takes at most ' + MAX_TASK_CHARS + ' characters of task text.', { notExecuted: true });
    const url = parseUrl(args.url);
    if (url && url.error) return fail(url.error, { notExecuted: true });
    const mm = parseModel(config.BROWSER_USE_MODEL);
    if (!mm) return fail('BROWSER_USE_MODEL must be "<provider>/<model>", e.g. ' + DEFAULT_MODEL + '.', { notExecuted: true });
    const keys = KEY_FOR_PROVIDER[mm.provider];
    if (!keys) return fail('BROWSER_USE_MODEL names an unsupported provider "' + mm.provider + '". Supported: ' + Object.keys(KEY_FOR_PROVIDER).join(', ') + '.', { notExecuted: true });
    if (!env[keys[0]]) return fail('browser_task needs ' + keys[0] + ' in mythos/.env for the ' + mm.provider + ' model it is configured to use.', { notExecuted: true });

    const installed = findInstalled();
    if (!installed.ok) return fail(installed.reason, { notExecuted: true });

    const browser = await ensureBrowser();
    if (!browser.ok) return browser;
    const cdpUrl = env.BROWSER_CDP_URL || config.BROWSER_CDP_URL || 'http://127.0.0.1:9222';

    // Only the provider's own key crosses into the child; nothing else from .env does.
    const keyEnv = { PATH: env.PATH, SYSTEMROOT: env.SYSTEMROOT, TEMP: env.TEMP, TMP: env.TMP, USERPROFILE: env.USERPROFILE, HOME: env.HOME, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    for (const k of keys) if (env[k]) keyEnv[k] = env[k];
    const req = { task, url: url ? url.href : undefined, cdp_url: cdpUrl, provider: mm.provider, model: mm.model, max_steps: maxSteps, timeout_s: Math.floor(timeoutMs / 1000) };

    const run = await runRunner(installed, req, keyEnv, ctx.signal);
    if (run.aborted) return fail('The browser task was cancelled.');
    if (run.timedOut) return fail('The browser task ran past ' + Math.round(timeoutMs / 1000) + ' seconds and was stopped.');
    if (run.error) return fail('The browser task runner could not start: ' + run.error);
    const line = String(run.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    let payload = null; try { payload = JSON.parse(line); } catch { payload = null; }
    if (!payload) {
      const tail = String(run.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
      return fail('The browser task runner exited with code ' + run.code + ' and no readable result' + (tail ? ': ' + tail : '') + '.');
    }
    if (run.code !== 0 || payload.ok !== true) return fail(reasonFor(run.code, payload, mm.provider), { steps: payload.steps || 0, final_url: payload.final_url || null });
    const result = { summary: payload.result || '', steps: payload.steps || 0, final_url: payload.final_url || null, final_title: payload.final_title || null, model: payload.model || (mm.provider + '/' + mm.model), seconds: payload.seconds || null, launchedBrowser: browser.launched };
    if (!result.final_url || result.final_url === 'about:blank') {
      return { ok: true, result, unverified: true, reason: 'The browser task reported done, but the page never left about:blank, so nothing observable happened.' };
    }
    return ok(result);
  }

  return [{
    name: 'browser_task',
    description: 'Do a MULTI-STEP job in the browser from a plain-English task: "play the second video on YouTube", "search YouTube for X and play the first result", "fill the form at <url> with name A, email B and submit", "find the price of X on site Y". An agent drives the debug browser, observing and retrying until done, and reports the final URL and title as evidence. Use this for anything that takes more than one browser step. Use open_web to merely open a URL; use browser_* tools for one deterministic step. It drives MYTHOS\'s own debug browser profile (signed out), so tasks behind the operator\'s login will stop and say so. Takes 30-120 s.',
    params: { task: 'string — the job, in plain English, at most 500 characters', url: 'string (optional) — page to start at (http/https)' },
    danger: false, needs_result: true, fn: browser_task,
  }];
}

function registerFromBrowserUse(hub, ctx) {
  const tools = buildTools(ctx);
  for (const tool of tools) hub.register(effectorFromTool(tool));
  return { count: tools.length };
}

module.exports = { buildTools, registerFromBrowserUse, parseModel, reasonFor, DEFAULT_MODEL, RUNNER };
