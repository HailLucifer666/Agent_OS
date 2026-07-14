'use strict';

// effectors/research-synthesis.js — the synthesis stage of the research
// orchestrator, split out to keep research.js under the file-size floor. Builds
// a numbered-source corpus and asks the brain (lane:'text') for a cited report
// {headline, summary, keyFindings:[{text,citations}], caveats}. If the corpus is
// large (>~9000 chars) each source is first condensed with a cheap lane:'simple'
// pass. Brain offline → a degraded report is still assembled from the source
// snippets/titles (the sources are real either way). Unparseable model output →
// degrade to a raw-summary block.

const CORPUS_LIMIT = 9000;
const PER_SOURCE_CAP = 2400;

async function condenseSource(brain, topic, src, n) {
  try {
    const res = await brain.think({
      lane: 'simple',
      messages: [{ role: 'user', content: 'For the research topic "' + topic + '", summarize the key relevant points from this source in 3-4 sentences.\n\nSOURCE [' + n + '] ' + (src.fetched.title || src.url) + ':\n' + String(src.fetched.text || '').slice(0, 6000) }],
      source: 'research:condense',
    });
    if (res && !res.offline && res.content) return String(res.content).slice(0, PER_SOURCE_CAP);
  } catch (_) { /* fall through to raw slice */ }
  return String(src.fetched.text || '').slice(0, PER_SOURCE_CAP);
}

async function buildCorpus(brain, topic, sources) {
  const raw = sources.map(function (s) { return String((s.fetched && s.fetched.text) || ''); }).join('');
  const large = raw.length > CORPUS_LIMIT;
  const parts = [];
  for (let i = 0; i < sources.length; i++) {
    const n = i + 1;
    const s = sources[i];
    const body = large && brain ? await condenseSource(brain, topic, s, n) : String((s.fetched && s.fetched.text) || '').slice(0, PER_SOURCE_CAP);
    parts.push('[' + n + '] ' + (s.fetched.title || s.title || s.url) + ' (' + s.url + ')\n' + body);
  }
  return parts.join('\n\n');
}

function degradedReport(topic, sources, reason) {
  const findings = sources.map(function (s, i) {
    return { text: (s.fetched && s.fetched.title ? s.fetched.title : s.title || s.url) + (s.snippet ? ' — ' + s.snippet : ''), citations: [i + 1] };
  });
  return {
    report: {
      headline: 'Research notes on ' + topic,
      summary: 'A full synthesis was unavailable (' + reason + '), so this report lists the sources gathered without an LLM-written narrative.',
      keyFindings: findings, caveats: ['Report is degraded: ' + reason + '.'],
    },
    degraded: true,
  };
}

function normalizeReport(parsed) {
  const findings = Array.isArray(parsed.keyFindings) ? parsed.keyFindings.map(function (k) {
    if (typeof k === 'string') return { text: k, citations: [] };
    return { text: String((k && k.text) || ''), citations: Array.isArray(k && k.citations) ? k.citations : [] };
  }).filter(function (k) { return k.text; }) : [];
  return {
    headline: String(parsed.headline || '').slice(0, 200) || 'Research report',
    summary: String(parsed.summary || '').slice(0, 4000),
    keyFindings: findings,
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.map(String) : (parsed.caveats ? [String(parsed.caveats)] : []),
  };
}

async function synthesize({ brain, topic, sources, id }) {
  if (!brain || typeof brain.think !== 'function') return degradedReport(topic, sources, 'no brain available');
  const corpus = await buildCorpus(brain, topic, sources);
  const schemaHint = '{"headline": "...", "summary": "...", "keyFindings": [{"text": "...", "citations": [1,2]}], "caveats": ["..."]}';
  let result;
  try {
    result = await brain.think({
      lane: 'text', schemaHint: schemaHint,
      messages: [{ role: 'user', content: 'Write a concise research report on "' + topic + '" using ONLY the numbered sources below. Cite every claim inline with [n] matching the source numbers. Respond ONLY with JSON: ' + schemaHint + '\n\nSOURCES:\n' + corpus }],
      source: 'research:' + id + ':synthesize',
    });
  } catch (_) { result = null; }
  if (!result || result.offline || result.aborted) return degradedReport(topic, sources, 'brain offline');
  const parsed = result.parsed || (brain.tryParseWithRepair && brain.tryParseWithRepair(result.content));
  if (!parsed || (!parsed.summary && !parsed.headline && !parsed.keyFindings)) {
    const deg = degradedReport(topic, sources, 'model output could not be parsed');
    if (result.content) deg.report.summary = String(result.content).slice(0, 4000);
    return deg;
  }
  return { report: normalizeReport(parsed), degraded: false };
}

module.exports = { synthesize, _internal: { buildCorpus, degradedReport, normalizeReport } };
