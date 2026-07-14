'use strict';

// effectors/research.js — the research orchestrator (P23). Mirrors the mission
// orchestrator (orchestrator.js): a factory that persists to a JSON file, emits
// bus updates on every transition, and marks in-flight work 'interrupted' on a
// crash-restart (honest-inert). Pipeline stages (each emits bus 'research.update'):
//   plan-queries → (optional scope checkpoint) → searching → (select) → fetching
//   → synthesizing → persisting → (announce) → done.  Any dead-end (no queries
//   survive, all searches fail, all fetches fail, brain offline at synthesis) is
//   surfaced honestly: 'failed', or 'done' + degraded:true with real sources.
//
// run_research is T1 (writes only vault/Semantic + a local HTML artifact);
// research_status is T0. Deep depth + an ONLINE browser agent falls back to
// browserFallbackFetch when a primary fetch fails.

const { synthesize } = require('./research-synthesis');
const { buildReportHtml, slugify } = require('./research-report');

const FILE = 'Checkpoints/research.json';
const DEPTH_SOURCES = { quick: 3, standard: 5, deep: 8 };
const TERMINAL = { done: true, failed: true };

function normalizeUrlForDedupe(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const drop = [];
    u.searchParams.forEach(function (_v, k) { if (/^utm_|^fbclid$|^gclid$/i.test(k)) drop.push(k); });
    drop.forEach(function (k) { u.searchParams.delete(k); });
    return u.origin + u.pathname + (u.search || '') + '/';
  } catch (_) { return String(url || '').trim(); }
}

function createResearch({ config, brain, bus, memory, search, fetchPage, checkpoints, fs, browserAgent }) {
  if (!bus) throw new Error('createResearch requires bus');
  if (typeof search !== 'function') throw new Error('createResearch requires search fn');
  if (typeof fetchPage !== 'function') throw new Error('createResearch requires fetchPage fn');
  if (!fs || typeof fs.writeText !== 'function') throw new Error('createResearch requires vault fs-store');

  config = config || {};
  const MAX_SOURCES = config.RESEARCH_MAX_SOURCES || 8;
  const FETCH_CONCURRENCY = config.RESEARCH_FETCH_CONCURRENCY || 3;
  const MAX_PERSISTED = config.RESEARCH_MAX_PERSISTED || 50;
  const SCOPE_CHECKPOINT = config.RESEARCH_SCOPE_CHECKPOINT === true;

  const runs = new Map();

  // ---- views + persistence ----
  function publicView(r) {
    return {
      id: r.id, topic: r.topic, depth: r.depth, stage: r.stage, status: r.stage,
      sourceCount: r.sources.length, reportUrl: r.reportUrl || null,
      headline: (r.report && r.report.headline) || null,
      degraded: !!r.degraded, error: r.error || null,
      createdAt: r.createdAt, finishedAt: r.finishedAt || null,
      report: r.report || null, sources: r.sources.map(function (s) { return { title: s.title, url: s.url }; }),
    };
  }

  function persist() {
    try { fs.writeJSON(FILE, Array.from(runs.values()).slice(-MAX_PERSISTED).map(serialize)); }
    catch (err) { bus.emit('health.anomaly', { kind: 'research-persist-failed', error: err.message }); }
  }

  function serialize(r) {
    return {
      id: r.id, topic: r.topic, depth: r.depth, stage: r.stage,
      queries: r.queries, sources: r.sources, reportUrl: r.reportUrl,
      report: r.report, degraded: r.degraded, error: r.error,
      createdAt: r.createdAt, finishedAt: r.finishedAt,
    };
  }

  function notify(r, detail) {
    const view = publicView(r);
    view.detail = detail || null;
    bus.emit('research.update', view);
    persist();
  }

  function fail(r, message, detail) {
    r.stage = 'failed'; r.error = message; r.finishedAt = Date.now();
    notify(r, detail || message);
  }

  // ---- stage 1: plan queries ----
  async function planQueries(r) {
    r.stage = 'plan-queries'; notify(r, 'Planning search queries');
    if (!brain || typeof brain.think !== 'function') { r.queries = [r.topic]; return; }
    let result;
    try {
      result = await brain.think({
        lane: 'simple',
        schemaHint: '{"queries": ["query one", "query two"]}',
        messages: [{ role: 'user', content: 'Break this research topic into 3 to 5 focused web-search queries that together cover it well. Topic: "' + r.topic + '". Respond ONLY with a JSON object {"queries": [...]}.' }],
        source: 'research:' + r.id + ':plan',
      });
    } catch (_) { result = null; }
    const parsed = result && (result.parsed || (result.content && brain.tryParseWithRepair && brain.tryParseWithRepair(result.content)));
    let queries = parsed && Array.isArray(parsed.queries) ? parsed.queries : null;
    if (!queries || !queries.length) { r.queries = [r.topic]; return; }
    queries = queries.map(function (q) { return String(q || '').trim(); }).filter(Boolean).slice(0, 5);
    r.queries = queries.length ? queries : [r.topic];
  }

  // ---- stage 2: optional scope checkpoint ----
  function waitForCheckpoint(id) {
    return new Promise(function (resolve) {
      const unsub = bus.subscribe('checkpoint.resolved', function (e) {
        const p = e && e.payload;
        if (!p || p.id !== id) return;
        unsub();
        resolve(p.status === 'approved');
      });
    });
  }

  async function scopeGate(r) {
    if (!SCOPE_CHECKPOINT || !checkpoints || typeof checkpoints.create !== 'function') return true;
    r.stage = 'scope-approval'; notify(r, 'Awaiting scope approval');
    const view = checkpoints.create({
      kind: 'research-scope-approval', title: 'Research scope for "' + r.topic + '"',
      body: 'Planned queries:\n' + r.queries.map(function (q) { return '- ' + q; }).join('\n'),
      connectionId: 'system',
    });
    r.checkpointId = view.id;
    const approved = await waitForCheckpoint(view.id);
    if (!approved) { fail(r, 'research scope was not approved', 'Scope rejected'); return false; }
    return true;
  }

  // ---- stage 3: search + dedupe/rank ----
  async function runSearch(r) {
    r.stage = 'searching'; notify(r, 'Searching the web');
    const byKey = new Map();
    let anyOk = false;
    for (let i = 0; i < r.queries.length; i++) {
      let res;
      try { res = await search({ query: r.queries[i] }); } catch (_) { res = { ok: false }; }
      if (!res || !res.ok) continue;
      anyOk = true;
      const results = (res.result && res.result.results) || [];
      for (let j = 0; j < results.length; j++) {
        const hit = results[j];
        if (!hit || !hit.url) continue;
        const key = normalizeUrlForDedupe(hit.url);
        const existing = byKey.get(key);
        if (existing) { existing.hits += 1; }
        else byKey.set(key, { title: hit.title || hit.url, url: hit.url, snippet: hit.snippet || '', hits: 1 });
      }
    }
    if (!anyOk) { fail(r, 'all search providers failed', 'Search failed'); return false; }
    r.ranked = Array.from(byKey.values()).sort(function (a, b) { return b.hits - a.hits; });
    return true;
  }

  // ---- stage 4: select top N ----
  function selectSources(r) {
    const cap = Math.min(DEPTH_SOURCES[r.depth] || DEPTH_SOURCES.standard, MAX_SOURCES);
    r.sources = r.ranked.slice(0, cap);
  }

  // ---- stage 5: fetch (bounded concurrency) ----
  async function browserFallbackFetch(url) {
    if (r_isBrowserOnline() !== true) return null;
    try {
      return await browserAgent.withPage(async function (page) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const text = await page.evaluate(function () { return document.body ? document.body.innerText : ''; });
        const title = await page.title().catch(function () { return ''; });
        return { url: url, finalUrl: url, title: title || '', text: String(text || '').slice(0, 20000), truncated: false };
      });
    } catch (_) { return null; }
  }

  function r_isBrowserOnline() {
    if (!browserAgent || typeof browserAgent.getStatus !== 'function') return false;
    try { return browserAgent.getStatus().state === 'ONLINE'; } catch (_) { return false; }
  }

  async function fetchOne(r, source) {
    let res;
    try { res = await fetchPage({ url: source.url }); } catch (_) { res = { ok: false }; }
    if (res && res.ok && res.result && res.result.text) {
      source.fetched = res.result; return true;
    }
    if (r.depth === 'deep' && r_isBrowserOnline()) {
      const fb = await browserFallbackFetch(source.url);
      if (fb && fb.text) { source.fetched = fb; return true; }
    }
    source.fetchError = (res && res.result) || 'fetch failed';
    return false;
  }

  async function runFetch(r) {
    r.stage = 'fetching'; notify(r, 'Reading sources');
    const queue = r.sources.slice();
    let active = 0, ok = 0;
    await new Promise(function (resolve) {
      function pump() {
        if (!queue.length && active === 0) return resolve();
        while (active < FETCH_CONCURRENCY && queue.length) {
          const src = queue.shift();
          active += 1;
          fetchOne(r, src).then(function (good) { if (good) ok += 1; active -= 1; notify(r, 'Read ' + ok + ' sources'); pump(); });
        }
      }
      pump();
    });
    r.sources = r.sources.filter(function (s) { return s.fetched; });
    if (r.sources.length === 0) { fail(r, 'could not fetch any source', 'Fetch failed'); return false; }
    return true;
  }

  // ---- stage 6: synthesize ----
  async function runSynthesis(r) {
    r.stage = 'synthesizing'; notify(r, 'Synthesizing report');
    const out = await synthesize({ brain: brain, topic: r.topic, sources: r.sources, id: r.id });
    r.report = out.report;
    r.degraded = out.degraded;
  }

  // ---- stage 7: persist ----
  function persistArtifacts(r) {
    r.stage = 'persisting'; notify(r, 'Saving report');
    const facts = reportToFacts(r.report);
    const urls = r.sources.map(function (s) { return s.url; });
    try {
      if (memory && memory.semantic && typeof memory.semantic.write === 'function') {
        memory.semantic.write(r.topic, facts, { confidence: r.degraded ? 0.4 : 0.7, sources: urls });
      }
    } catch (err) { bus.emit('health.anomaly', { kind: 'research-semantic-write-failed', error: err.message }); }
    const rel = 'builds/research/' + slugify(r.topic) + '-' + r.id + '.html';
    try {
      fs.writeText(rel, buildReportHtml(r));
      r.reportUrl = '/vault/' + rel;
    } catch (err) { bus.emit('health.anomaly', { kind: 'research-artifact-write-failed', error: err.message }); }
  }

  function reportToFacts(report) {
    if (!report) return ['No findings.'];
    const facts = [];
    if (report.headline) facts.push(report.headline);
    (report.keyFindings || []).forEach(function (k) { if (k && k.text) facts.push(k.text); });
    if (!facts.length && report.summary) facts.push(String(report.summary).slice(0, 500));
    return facts.length ? facts : ['No findings.'];
  }

  // ---- stage 8: announce (fire-and-forget, NOT a gate) ----
  function announce(r) {
    if (checkpoints && typeof checkpoints.create === 'function') {
      try {
        checkpoints.create({
          kind: 'research-report-ready', title: 'Research ready: "' + r.topic + '"',
          body: (r.report && r.report.headline) || 'Report generated.', connectionId: 'system',
        });
      } catch (_) { /* announcement is garnish */ }
    }
    r.stage = 'done'; r.finishedAt = Date.now();
    notify(r, 'Done');
  }

  // ---- pipeline driver ----
  async function pipeline(r) {
    await planQueries(r);
    if (r.stage === 'failed') return;
    if (!(await scopeGate(r))) return;
    if (!(await runSearch(r))) return;
    selectSources(r);
    if (!(await runFetch(r))) return;
    await runSynthesis(r);
    persistArtifacts(r);
    announce(r);
  }

  // ---- public API ----
  function runResearch(topic, depth, opts) {
    opts = opts || {};
    const t = String(topic || '').trim();
    if (!t) throw new Error('topic required');
    const d = DEPTH_SOURCES[depth] ? depth : 'standard';
    const r = {
      id: 'research-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      topic: t, depth: d, stage: 'queued', queries: [], ranked: [], sources: [],
      report: null, reportUrl: null, degraded: false, error: null,
      goalId: opts.goalId != null ? opts.goalId : null,
      connectionId: opts.connectionId || null, checkpointId: null,
      createdAt: Date.now(), finishedAt: null,
    };
    runs.set(r.id, r);
    persist();
    queueMicrotask(function () {
      pipeline(r).catch(function (err) { fail(r, (err && err.message) || 'research error', 'Pipeline error'); });
    });
    return { id: r.id, stage: r.stage };
  }

  function lastRun() { let last = null; for (const r of runs.values()) last = r; return last; }
  function getResearch(id) { const r = id ? runs.get(id) : lastRun(); return r ? publicView(r) : null; }
  function listResearch() { return Array.from(runs.values()).map(publicView); }

  function init() {
    let saved;
    try { saved = fs.readJSON(FILE, []); } catch (_) { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    let changed = false;
    for (let i = 0; i < saved.length; i++) {
      const r = Object.assign({ queries: [], ranked: [], sources: [], report: null }, saved[i]);
      if (!TERMINAL[r.stage]) {
        r.stage = 'interrupted'; r.error = 'entity restarted mid-research'; r.finishedAt = r.finishedAt || Date.now(); changed = true;
      }
      runs.set(r.id, r);
    }
    if (changed) persist();
    return { loaded: runs.size };
  }

  return { init, runResearch, getResearch, listResearch, _internal: { runs, normalizeUrlForDedupe } };
}

module.exports = { createResearch, normalizeUrlForDedupe };
