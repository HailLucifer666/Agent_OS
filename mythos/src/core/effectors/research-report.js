'use strict';

// effectors/research-report.js — renders a research run into a self-contained
// HTML artifact (no external assets, everything escaped) written under
// vault/builds/research/. Also owns slugify (shared with research.js for the
// artifact filename + semantic topic). Kept separate so research.js stays under
// the file-size floor.

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function findingsHtml(report) {
  const items = (report.keyFindings || []).map(function (k) {
    const cites = (k.citations || []).map(function (c) { return '<sup>[' + esc(c) + ']</sup>'; }).join(' ');
    return '<li>' + esc(k.text) + ' ' + cites + '</li>';
  }).join('');
  return items ? '<ul class="findings">' + items + '</ul>' : '';
}

function caveatsHtml(report) {
  const items = (report.caveats || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('');
  return items ? '<h2>Caveats</h2><ul class="caveats">' + items + '</ul>' : '';
}

function sourcesHtml(sources) {
  const items = (sources || []).map(function (s, i) {
    const title = esc((s.fetched && s.fetched.title) || s.title || s.url);
    return '<li><span class="n">[' + (i + 1) + ']</span> <a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + title + '</a></li>';
  }).join('');
  return '<h2>Sources</h2><ol class="sources">' + items + '</ol>';
}

function buildReportHtml(run) {
  const report = run.report || { headline: run.topic, summary: '', keyFindings: [], caveats: [] };
  const degraded = run.degraded ? '<div class="degraded">This report is degraded — see caveats below.</div>' : '';
  const ts = new Date(run.finishedAt || run.createdAt || Date.now()).toISOString();
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(report.headline || run.topic) + '</title>' +
    '<style>' +
    'body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a2e;background:#fafafd}' +
    'h1{font-size:1.6rem;margin-bottom:.2rem}h2{font-size:1.15rem;margin-top:1.6rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}' +
    '.meta{color:#666;font-size:.85rem;margin-bottom:1.2rem}.degraded{background:#fff3cd;border:1px solid #ffe08a;padding:.6rem .8rem;border-radius:6px;margin:1rem 0}' +
    'sup{color:#5b6cff;font-weight:600}.sources a{color:#3344cc}.n{color:#888;font-family:monospace}' +
    '.summary{white-space:pre-wrap}ul.caveats{color:#8a6d00}' +
    '</style></head><body>' +
    '<h1>' + esc(report.headline || run.topic) + '</h1>' +
    '<div class="meta">Topic: ' + esc(run.topic) + ' · Depth: ' + esc(run.depth) + ' · ' + esc(run.sources ? run.sources.length : 0) + ' sources · Generated ' + esc(ts) + '</div>' +
    degraded +
    '<div class="summary">' + esc(report.summary) + '</div>' +
    (report.keyFindings && report.keyFindings.length ? '<h2>Key findings</h2>' + findingsHtml(report) : '') +
    caveatsHtml(report) +
    sourcesHtml(run.sources) +
    '</body></html>';
}

module.exports = { buildReportHtml, slugify, _internal: { esc } };
