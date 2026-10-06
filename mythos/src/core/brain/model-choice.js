'use strict';

// model-choice.js — which model, on which key, each JOB may use.
//
// WHY THIS EXISTS (operator decision, 2026-10-06, closing BUG-467). Wave 0c
// (2026-09-24) added MODEL_BILLING_POLICY: unset meant "every configured route",
// so the moment a premium key appeared in mythos/.env, premium models headed six
// lanes and were billed — a key's PRESENCE decided what got charged. free-only was
// opt-in. The operator asked for the opposite default and a per-job decision:
// each job (voice, build, images, embeddings, speech-to-text, ...) may use a paid
// route only when the operator has CHOSEN that route for that job. A job with no
// choice uses free models only. A key alone never causes a bill.
//
// WHAT A CHOICE IS. { provider, model }. The provider names the key: every key
// the brain lanes can use is its own provider here (NVIDIA's two keys are `nim`
// and `nim2`), so choosing the provider IS choosing the key. A choice ALLOWS that
// one route for that job, paid or not, and in a brain-lane job it also heads the
// lane. The free routes behind it stay as the fallback — a choice is a
// preference plus a permission, not a restriction (the same shape as the picked
// voice in config/voice-choice.js). Every other paid route stays refused.
//
// WHERE IT IS KEPT: <vault>/Config/model-choice.json, beside voice-choice.json —
// the precedent (config/voice-choice-store.js). The vault is per-install,
// excluded from the installer and kept across upgrades, and it is readable
// before memory exists. config.json (settings-store.js) was the other candidate
// and was rejected: it is a flat KEY -> "value" overlay onto the env schema, and a
// per-job {provider, model} map is neither flat nor a schema key.
//
// THE DELIBERATE DIFFERENCE FROM voice-choice-store.js: that store never throws,
// because a lost voice preference is cheap. A spending guard is not: an invalid
// file here (bad JSON, an unknown job, a provider the job cannot call, a model
// the job would never send) is a LOAD ERROR that stops boot through the same
// "Config errors:" path as an invalid .env value, naming the file and the fix
// (FIX-PROTOCOL stage 2 items 2 and 4). Silently ignoring it would read as
// "nothing chosen", which is safe for billing but leaves the operator believing a
// choice applies that does not. A MISSING file is the normal case: no choices.
//
// THE JOB LIST IS DERIVED, never typed as a list of names: every brain lane in
// lanes.default.js's BRAIN_TABLES, plus the jobs whose requests go out through
// their own sender rather than a lane (CALL_SITE_JOBS below). Each call-site job
// reads its routes from the sender's own export, so what this file reports is
// what the sender judges. test/bug-467-per-job-model-choice.test.js scans the
// runtime tree and fails if a sender judges a job name that is not here, or if a
// job here has no sender.
//
// NO WRITER IN THIS FILE, on purpose. A Settings screen will write choices, but
// every key/setting write must go through the native confirmation path (PR #141,
// unmerged at the time of writing). Until then the file is hand-edited and the
// only HTTP surface is a GET (server/routes/config.js /api/config/model-choice).

const fs = require('fs');
const path = require('path');
const { BRAIN_TABLES } = require('./lanes.default');

const REL_DIR = 'Config';
const REL_FILE = 'model-choice.json';
const SCHEMA_VERSION = 1;
const MAX_MODEL_LEN = 200;
// Real ids carry these: 'kimi-k2.5:cloud', 'meta/llama:free',
// 'models/gemini-3.1-flash-live-preview', 'deepseek-ai/deepseek-v4-flash-0731'.
const MODEL_RE = /^[A-Za-z0-9._:/@+-]+$/;
const PROVIDER_RE = /^[a-z0-9]+$/;
const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'jobs', 'updatedAt']);
const CHOICE_KEYS = Object.freeze(['provider', 'model']);

class ModelChoiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelChoiceError';
    this.code = 'model-choice-invalid';
  }
}

function stripModelsPrefix(model) {
  return String(model || '').replace(/^models\//, '');
}

// One comparison, used by the policy, the lanes and the validator alike, so a
// choice that validates is the same choice the policy honours.
function sameRoute(a, b) {
  return Boolean(a && b)
    && String(a.provider || '').toLowerCase() === String(b.provider || '').toLowerCase()
    && stripModelsPrefix(a.model) === stripModelsPrefix(b.model);
}

// The Live session builds its route inside a closure; this is the same model and
// socket host it judges (live-session.js open(): config.GEMINI_LIVE_MODEL, WS_URL).
function liveRoute(config) {
  const { SCHEMA } = require('../config/schema');
  const model = (config && config.GEMINI_LIVE_MODEL) || SCHEMA.GEMINI_LIVE_MODEL.default;
  return { provider: 'google', model, endpoint: require('../voice/live-session')._internal.WS_URL, mode: 'live' };
}

// Jobs whose requests do NOT go through a brain lane. Each sender judges its own
// route; routes(config) returns exactly those routes, read from the sender's
// export. Required lazily: every sender requires route-policy, which requires
// this file.
const CALL_SITE_JOBS = Object.freeze({
  live: Object.freeze({ routes: (config) => [liveRoute(config)] }),
  image: Object.freeze({ routes: () => [require('../effectors/from-image-gen').billingRoute()] }),
  stt: Object.freeze({
    routes: () => [require('../../../providers/gemini-stt').billingRoute(), require('../../../providers/groq-stt').billingRoute()],
  }),
  tts: Object.freeze({ routes: () => [require('../../../providers/gemini-tts').billingRoute()] }),
  // Also a BRAIN_TABLES key, but the requests that matter go out through
  // providers/embeddings.js's own chain, not registry.chainFor('embed').
  embed: Object.freeze({ routes: () => require('../../../providers/embeddings')._internal.CHAIN.map((e) => e.route) }),
});

function jobNames() {
  return [...new Set([...Object.keys(BRAIN_TABLES), ...Object.keys(CALL_SITE_JOBS)])];
}

function isJob(name) {
  return jobNames().includes(String(name));
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function fail(file, message) {
  return new ModelChoiceError((file ? file + ': ' : '') + message);
}

function validateOneChoice(job, raw, file, config) {
  const where = 'jobs.' + job;
  if (!isPlainObject(raw)) throw fail(file, where + ' must be an object {"provider": ..., "model": ...}');
  const extra = Object.keys(raw).filter((k) => !CHOICE_KEYS.includes(k));
  if (extra.length) throw fail(file, where + ' has unknown field(s) ' + extra.join(', ') + '; only provider and model are read');
  const { provider, model } = raw;
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) {
    throw fail(file, where + '.provider must be a lower-case provider name such as "mistral" (got ' + JSON.stringify(provider) + ')');
  }
  if (typeof model !== 'string' || !model || model.length > MAX_MODEL_LEN || !MODEL_RE.test(model)) {
    throw fail(file, where + '.model must be a model id of at most ' + MAX_MODEL_LEN + ' characters with no spaces (got ' + JSON.stringify(model) + ')');
  }
  const choice = Object.freeze({ provider, model });
  if (CALL_SITE_JOBS[job]) {
    // A call-site job sends only the routes its sender is configured for. A choice
    // naming anything else would never be used — refused here rather than sitting
    // in the file looking applied.
    const routes = CALL_SITE_JOBS[job].routes(config);
    if (!routes.some((r) => sameRoute(r, choice))) {
      throw fail(file, where + ' chooses ' + provider + ':' + model + ', but the ' + job + ' job only ever calls '
        + routes.map((r) => r.provider + ':' + r.model).join(', ') + '. Choose one of those, or change the model that job is configured to call first.');
    }
    return choice;
  }
  const laneProviders = require('./registry').laneProviders();
  if (!laneProviders.includes(provider)) {
    throw fail(file, where + '.provider "' + provider + '" is not a provider the ' + job + ' lane can call (' + laneProviders.join(', ') + ')');
  }
  return choice;
}

// validateChoices(parsed, {file, config}) -> frozen {job: {provider, model}}. Throws
// ModelChoiceError naming the file and the field on anything it cannot honour.
function validateChoices(parsed, opts) {
  const o = opts || {};
  const file = o.file || null;
  if (!isPlainObject(parsed)) throw fail(file, 'must be a JSON object {"schemaVersion": 1, "jobs": {...}}');
  const extra = Object.keys(parsed).filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (extra.length) throw fail(file, 'unknown top-level field(s) ' + extra.join(', ') + '; expected ' + TOP_LEVEL_KEYS.join(', '));
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw fail(file, 'schemaVersion must be ' + SCHEMA_VERSION + ' (got ' + JSON.stringify(parsed.schemaVersion) + ')');
  }
  const jobs = parsed.jobs === undefined ? {} : parsed.jobs;
  if (!isPlainObject(jobs)) throw fail(file, 'jobs must be an object keyed by job name');
  const out = {};
  for (const job of Object.keys(jobs)) {
    if (!isJob(job)) throw fail(file, 'jobs.' + job + ' is not a job MYTHOS has. Jobs: ' + jobNames().join(', '));
    out[job] = validateOneChoice(job, jobs[job], file, o.config);
  }
  return Object.freeze(out);
}

function choiceFilePath(vaultRoot) {
  return path.join(String(vaultRoot || ''), REL_DIR, REL_FILE);
}

// loadModelChoices({vaultRoot, config, fs}) -> {file, choices}. Throws
// ModelChoiceError on anything but a missing file (see the header for why).
function loadModelChoices(opts) {
  const o = opts || {};
  const fsImpl = o.fs || fs;
  const file = o.file || choiceFilePath(o.vaultRoot);
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, choices: Object.freeze({}) };
    throw fail(file, 'cannot be read (' + (err && err.message) + ')');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw fail(file, 'is not valid JSON (' + err.message + '). Fix it, or delete the file to return every job to free models only.');
  }
  return { file, choices: validateChoices(parsed, { file, config: o.config }) };
}

// MODEL_BILLING_POLICY is RETIRED (2026-10-06). It was the second source of the
// same answer — "any" let a key alone bill again, beside a per-job choice that
// said otherwise — so it is no longer read by anything that routes. '' and
// 'free-only' are accepted (free-only is now simply the default, and a .env that
// set it must keep booting). Anything else fails boot with this message.
function retiredPolicyError(raw) {
  const value = String(raw === undefined ? '' : raw).trim().toLowerCase();
  if (value === '' || value === 'free-only') return null;
  return 'MODEL_BILLING_POLICY="' + raw + '" is retired (2026-10-06, BUG-467): a key being present no longer decides what is billed. '
    + 'Every job uses free models only until a model is chosen for it in <vault>/' + REL_DIR + '/' + REL_FILE + '. Remove the setting'
    + (value === 'any' ? ', and choose a model for each job that should use a paid key.' : '.');
}

// Boot installs the validated choices once; route-policy reads them on every
// decision. Never installed (tests, scripts) = no choices = free only.
let installed = Object.freeze({ file: null, choices: Object.freeze({}) });
function install(result) {
  installed = Object.freeze({ file: (result && result.file) || null, choices: (result && result.choices) || Object.freeze({}) });
}
function current() { return installed.choices; }
function currentFile() { return installed.file; }

// withChoice(job, prefs, choices) -> prefs with the job's chosen route at the head,
// and any identical entry further down removed. No choice -> prefs unchanged.
function withChoice(job, prefs, choices) {
  const choice = (choices || current())[job];
  if (!choice) return prefs;
  return [{ provider: choice.provider, model: choice.model }, ...prefs.filter((p) => !sameRoute(p, choice))];
}

function hostOf(endpoint) {
  try { return new URL(String(endpoint)).hostname; } catch (_) { return null; }
}

// statusReport({config, choices}) — per job, what it may use and why, and what is
// refused. Built from the SAME inputs the senders use: registry.lanePrefs (the
// list chainFor walks) and each call-site sender's billingRoute. It does not
// probe keys or networks, so a route listed under `uses` is permitted, not
// promised: a lane still skips a provider whose key is unset or that is down
// (registry.getStatus().chains shows that live view).
function statusReport(opts) {
  const o = opts || {};
  const choices = o.choices || current();
  const policy = require('./route-policy');
  const registry = require('./registry');
  const jobs = jobNames().map((job) => {
    const choice = choices[job] || null;
    const served = CALL_SITE_JOBS[job] ? 'call-site' : 'lane';
    const routes = served === 'lane'
      ? registry.lanePrefs(job, choices).map((p) => registry.routeOf(p, job))
      : CALL_SITE_JOBS[job].routes(o.config);
    const judged = routes.map((r) => {
      const d = policy.decide(r, choices);
      return { route: r.provider + ':' + r.model, host: hostOf(r.endpoint), allowed: d.allowed, basis: d.basis, classification: d.classification, reason: d.reason || null };
    });
    return {
      job,
      served,
      basis: choice ? 'chosen' : 'free-only (no choice)',
      choice,
      // What validateOneChoice accepts: a call-site job only the routes it calls;
      // a lane job any model on a lane provider (null = not a fixed list).
      choosable: served === 'call-site' ? routes.map((r) => r.provider + ':' + r.model) : null,
      uses: judged.filter((j) => j.allowed).map((j) => j.route),
      refused: judged.filter((j) => !j.allowed).map((j) => ({ route: j.route, reason: j.reason })),
      routes: judged,
    };
  });
  return { file: o.file !== undefined ? o.file : currentFile(), writable: false, limitations: LIMITATIONS, jobs };
}

// Known limits of this slice, shown to the operator rather than discovered by a
// refused choice (operator decision 2026-10-06: kept as known limitations).
const LIMITATIONS = Object.freeze([
  'A provider only the build engine can call (one that is not a brain-lane provider) cannot be chosen for the build job yet.',
  'A call-site job (' + Object.keys(CALL_SITE_JOBS).join(', ') + ') can only be given a model it is already configured to call; change that job\'s model setting first, then choose it.',
  'Choices are read once at startup; a changed model-choice.json applies after a restart.',
]);

module.exports = {
  REL_DIR,
  REL_FILE,
  SCHEMA_VERSION,
  CALL_SITE_JOBS,
  ModelChoiceError,
  jobNames,
  isJob,
  sameRoute,
  stripModelsPrefix,
  validateChoices,
  choiceFilePath,
  loadModelChoices,
  retiredPolicyError,
  install,
  current,
  currentFile,
  withChoice,
  statusReport,
};
