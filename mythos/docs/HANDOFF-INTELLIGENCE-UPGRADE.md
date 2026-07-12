# MYTHOS Intelligence Upgrade — Architectural Handoff Document

> **Purpose:** Enable a less capable model (GLM-5-Turbo) to execute the 5-intelligence-integration plan with zero drift. Every code snippet is captured from the actual codebase at commit `6dc20ab`. Every modification is specified as before→after. Execute integrations in dependency order: 1 → 2 → 4 → 3 → 5.
>
> **Golden rule:** Match existing conventions. The codebase uses `var` in some files, `const/let` in others — match each file's prevailing style. No new npm dependencies. No new test framework. `node --test` only.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Integration 1: Jina Reader upgrade](#2-integration-1-jina-reader-upgrade)
3. [Integration 2: Design system engine](#3-integration-2-design-system-engine)
4. [Integration 3: Build verification](#4-integration-3-build-verification)
5. [Integration 4: Specialized agent personas](#5-integration-4-specialized-agent-personas)
6. [Integration 5: Exa web search](#6-integration-5-exa-web-search)
7. [main.js DI wiring (the map)](#7-mainjs-di-wiring)
8. [Verification & testing](#8-verification--testing)

---

## 1. Architecture Overview

MYTHOS is a dependency-injected entity OS. Every module is a `create*({deps})` factory. All wiring happens in `src/main.js` in a 14-step boot sequence. The key rule: **construct before use, inject via closure, never require singletons at runtime.**

### The dependency graph (effector subsystem only — what we touch)

```
main.js boot step 'leash' (line ~207):
  hub = createEffectorHub({ bus, config })
  pipelineEffector = createPipelineEffector({ fs: memory.fs })
  kanbanEffector = createKanbanEffector({ fs: memory.fs })
  buildRunner = createBuildRunner({ config, brain, bus, vault: memory.fs })
  agentActionsEffector = createAgentActions({ fs, pipeline, kanban, buildRunner })
  registerFromDashboard(hub, { ..., agentActions, buildRunner, probes, abtop, config, fs })
  registerFromProject(hub, { pipeline, agentActions })
  orchestrator = createOrchestrator({ buildRunner, kanban, agentActions, brain, bus, fs })
  registerFromMission(hub, { orchestrator })
```

### How a build works (the flow we're upgrading)

```
User says "build a landing page for AI news"
  → voice-agent calls start_project effector
  → from-project.js startProject() captures pipeline card + approves + calls agentActions.executePipelineCard()
  → agent-actions.js executePipelineCard() calls buildRunner.enqueue({ prompt: DELIVERABLE_PREAMBLE + card.text, run: saveDeliverable })
  → build-runner.js pump() calls brain.think({ lane: 'build', messages: [{role:'user', content: prompt}] })
  → brain/index.js injects identity.persona() as system message, calls chain.complete()
  → chain.js walks the provider list (Mistral→Cerebras→NIM→OpenRouter→Ollama), returns content
  → build-runner.js calls run(raw, job) → saveDeliverable() → writes HTML to vault/builds/pipeline/
  → NO verification, NO design system, NO persona specialization
```

### Key files and their roles

| File | Role | Lines that matter |
|------|------|-------------------|
| `src/core/brain/index.js` | `think({lane, messages})` — injects persona, calls chain, parses JSON | Lines 45-107 (the think function) |
| `src/core/brain/chain.js` | Provider chain walk — model selection only, no prompt mutation | Line 78 `complete()`, lines 85-119 (the loop) |
| `src/core/brain/lanes.default.js` | Lane → model preference table | Lines 65-72 `BRAIN_TABLES` |
| `src/core/effectors/agent-actions.js` | Build preambles + saveDeliverable + executePipelineCard + buildKanbanCard | Lines 12-38 (preambles), 46 (factory), 62-86 (saveDeliverable), 92-113 (executePipelineCard), 140-159 (buildKanbanCard) |
| `src/core/effectors/build-runner.js` | Job queue + pump() that calls brain.think | Line 19 (factory sig), 95-113 (enqueue), 116-159 (pump) |
| `src/core/effectors/orchestrator.js` | 3-stage mission pipeline: plan→build→synthesize | Line 156 (runMission), 88-150 (stages) |
| `src/core/effectors/from-dashboard.js` | Dashboard tools including web_fetch | Lines 239-286 (web_fetch impl) |
| `src/core/identity/index.js` | Single global persona | Lines 81-83 (persona()) |
| `src/main.js` | Boot sequence — constructs and wires everything | Lines 207-258 (effector wiring) |

---

## 2. Integration 1: Jina Reader Upgrade

**Goal:** Replace the crude regex HTML stripper in `web_fetch` with Jina Reader, which returns clean markdown.

### File: `src/core/effectors/from-dashboard.js`

#### CURRENT CODE (lines 239-286):

```js
  async function web_fetch({ url }) {
    try {
      if (!url || !String(url).trim()) return fail('A URL is required.');
      const raw = String(url).trim();
      if (!/^https?:\/\//i.test(raw)) return fail('URL must start with http:// or https://');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(raw, {
        signal: controller.signal,
        headers: { 'User-Agent': 'MYTHOS/1.0 (entity assistant)' },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) return fail('Fetch failed: HTTP ' + res.status + ' ' + res.statusText);
      const contentType = res.headers.get('content-type') || '';
      const body = await res.text();
      const maxChars = 4000;
      let text = body;
      if (contentType.includes('text/html')) {
        text = body
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
      }
      const truncated = text.length > maxChars;
      return ok({
        url: raw,
        status: res.status,
        contentType: contentType.split(';')[0].trim(),
        content: text.slice(0, maxChars),
        truncated: truncated,
        totalLength: text.length,
      });
    } catch (err) {
      return fail('Fetch failed: ' + err.message);
    }
  }
```

#### REPLACEMENT (the entire function body changes):

```js
  // web_fetch: retrieve readable text from a URL via Jina Reader.
  // Jina Reader (https://r.jina.ai/) returns clean markdown — no HTML stripping
  // needed, handles JS-rendered content, returns readable text. Free, no API key.
  // Falls back to direct fetch + regex strip if Jina is unavailable.
  async function web_fetch({ url }) {
    try {
      if (!url || !String(url).trim()) return fail('A URL is required.');
      const raw = String(url).trim();
      if (!/^https?:\/\//i.test(raw)) return fail('URL must start with http:// or https://');
      const maxChars = 4000;

      // Try Jina Reader first — prepend https://r.jina.ai/ to the URL
      try {
        const jinaController = new AbortController();
        const jinaTimer = setTimeout(() => jinaController.abort(), 15000);
        const jinaRes = await fetch('https://r.jina.ai/' + raw, {
          signal: jinaController.signal,
          headers: { 'Accept': 'text/plain' },
        });
        clearTimeout(jinaTimer);
        if (jinaRes.ok) {
          const text = await jinaRes.text();
          if (text && text.trim().length > 0) {
            const truncated = text.length > maxChars;
            return ok({
              url: raw,
              status: jinaRes.status,
              contentType: 'text/plain',
              content: text.slice(0, maxChars),
              truncated: truncated,
              totalLength: text.length,
              source: 'jina-reader',
            });
          }
        }
      } catch (_) { /* Jina failed — fall through to direct fetch */ }

      // Fallback: direct fetch + regex HTML strip
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(raw, {
        signal: controller.signal,
        headers: { 'User-Agent': 'MYTHOS/1.0 (entity assistant)' },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) return fail('Fetch failed: HTTP ' + res.status + ' ' + res.statusText);
      const contentType = res.headers.get('content-type') || '';
      const body = await res.text();
      let text = body;
      if (contentType.includes('text/html')) {
        text = body
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ').trim();
      }
      const truncated = text.length > maxChars;
      return ok({
        url: raw,
        status: res.status,
        contentType: contentType.split(';')[0].trim(),
        content: text.slice(0, maxChars),
        truncated: truncated,
        totalLength: text.length,
        source: 'direct',
      });
    } catch (err) {
      return fail('Fetch failed: ' + err.message);
    }
  }
```

**That's the entire Integration 1.** One function replacement. No new files.

---

## 3. Integration 2: Design System Engine

**Goal:** Port the ui-ux-pro-max-skill data + BM25 lookup into MYTHOS natively, then inject the looked-up design system into the build agent's prompt.

### Step 2a: Copy CSV data files

Create directory `vault/Design/data/` and download all 14 CSV files from the GitHub repo. These are static data — shipped with the repo.

```bash
mkdir -p vault/Design/data/stacks
cd vault/Design/data/
# Download from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/src/ui-ux-pro-max/data/
# Files needed:
#   ui-reasoning.csv  styles.csv  colors.csv  products.csv  typography.csv
#   landing.csv  charts.csv  ux-guidelines.csv  app-interface.csv
#   react-performance.csv  motion.csv  icons.csv  google-fonts.csv
#   stacks/ (22 subdirectory CSVs)
```

### Step 2b: BM25 search engine — NEW FILE

**File:** `src/core/design/bm25.js`

```js
'use strict';

// design/bm25.js — Pure JS BM25 search engine. Ported from ui-ux-pro-max-skill's
// core.py. Zero dependencies. Standard Okapi BM25 with k1=1.5, b=0.75.

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length >= 2; });
}

function createBM25Index(docs, searchFields) {
  // docs: array of objects. searchFields: array of field names to concatenate for indexing.
  var N = docs.length;
  var docTokens = [];
  var docLen = [];
  var df = {};       // term -> document frequency
  var tf = [];       // array of {term: count} per doc
  var avgdl = 0;

  for (var i = 0; i < N; i++) {
    var combinedText = searchFields.map(function(f) {
      return docs[i][f] || '';
    }).join(' ');
    var tokens = tokenize(combinedText);
    docTokens.push(tokens);
    docLen.push(tokens.length);
    avgdl += tokens.length;

    var termCounts = {};
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j];
      termCounts[t] = (termCounts[t] || 0) + 1;
    }
    tf.push(termCounts);
    for (var term in termCounts) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  avgdl = N > 0 ? avgdl / N : 0;

  // Precompute IDF: log((N - freq + 0.5) / (freq + 0.5) + 1)
  var idf = {};
  for (var term2 in df) {
    idf[term2] = Math.log((N - df[term2] + 0.5) / (df[term2] + 0.5) + 1);
  }

  function score(query) {
    var k1 = 1.5, b = 0.75;
    var queryTerms = tokenize(query);
    var results = [];

    for (var i = 0; i < N; i++) {
      var s = 0;
      for (var q = 0; q < queryTerms.length; q++) {
        var qt = queryTerms[q];
        if (!tf[i][qt]) continue;
        var termFreq = tf[i][qt];
        var idfVal = idf[qt] || 0;
        var denom = termFreq + k1 * (1 - b + b * (docLen[i] / (avgdl || 1)));
        s += idfVal * (termFreq * (k1 + 1)) / denom;
      }
      if (s > 0) results.push({ index: i, score: s, doc: docs[i] });
    }
    results.sort(function(a, b2) { return b2.score - a.score; });
    return results;
  }

  return { score: score, size: N };
}

module.exports = { tokenize: tokenize, createBM25Index: createBM25Index };
```

### Step 2c: CSV parser + domain config — NEW FILE

**File:** `src/core/design/data-loader.js`

```js
'use strict';

// design/data-loader.js — loads CSV files from vault/Design/data/ with a minimal
// quoted-field-aware parser (no external dependency). Caches parsed data in memory.

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', '..', '..', '..', 'vault', 'Design', 'data');
var cache = {};

// Minimal CSV parser: handles quoted fields with embedded commas and newlines.
function parseCsv(csvText) {
  var rows = [];
  var current = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  while (i < csvText.length) {
    var ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { current.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      current.push(field);
      if (current.some(function(c) { return c.trim() !== ''; })) rows.push(current);
      current = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  // Last field/row
  if (field !== '' || current.length > 0) {
    current.push(field);
    if (current.some(function(c) { return c.trim() !== ''; })) rows.push(current);
  }
  if (rows.length === 0) return [];
  // First row = headers
  var headers = rows[0].map(function(h) { return h.trim(); });
  var records = [];
  for (var r = 1; r < rows.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = rows[r][c] !== undefined ? rows[r][c].trim() : '';
    }
    records.push(obj);
  }
  return records;
}

function loadCsv(filename) {
  if (cache[filename]) return cache[filename];
  var fullPath = path.join(DATA_DIR, filename);
  try {
    var text = fs.readFileSync(fullPath, 'utf8');
    var records = parseCsv(text);
    cache[filename] = records;
    return records;
  } catch (err) {
    return []; // data file missing — degrade to empty
  }
}

// Domain config: maps each search domain to {file, searchCols}
// Ported from core.py CSV_CONFIG. searchCols = which fields to concatenate for BM25 indexing.
var DOMAIN_CONFIG = {
  product:     { file: 'products.csv',      searchCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'] },
  style:       { file: 'styles.csv',        searchCols: ['Style Category', 'Keywords', 'Best For', 'Type', 'AI Prompt Keywords'] },
  color:       { file: 'colors.csv',        searchCols: ['Product Type', 'Notes'] },
  landing:     { file: 'landing.csv',       searchCols: ['Pattern Name', 'Keywords', 'Conversion Optimization', 'Section Order'] },
  typography:  { file: 'typography.csv',    searchCols: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'] },
  reasoning:   { file: 'ui-reasoning.csv',  searchCols: ['UI_Category', 'Recommended_Pattern', 'Key_Effects', 'Decision_Rules'] },
  chart:       { file: 'charts.csv',        searchCols: ['Data Type', 'Keywords', 'Best Chart Type', 'When to Use'] },
  ux:          { file: 'ux-guidelines.csv', searchCols: ['Category', 'Issue', 'Description', 'Keywords'] },
};

function searchDomain(domain, query, maxResults) {
  var cfg = DOMAIN_CONFIG[domain];
  if (!cfg) return [];
  var records = loadCsv(cfg.file);
  if (!records.length) return [];
  var bm25 = require('./bm25').createBM25Index(records, cfg.searchCols);
  var results = bm25.score(query);
  return results.slice(0, maxResults || 3).map(function(r) { return r.doc; });
}

module.exports = { loadCsv: loadCsv, parseCsv: parseCsv, searchDomain: searchDomain, DOMAIN_CONFIG: DOMAIN_CONFIG, DATA_DIR: DATA_DIR };
```

### Step 2d: Design system generator — NEW FILE

**File:** `src/core/design/system.js`

```js
'use strict';

// design/system.js — the design system generator. Given a product/idea description,
// looks up the matching industry rules, style, color palette, typography, and
// landing page pattern via BM25 search. Returns a structured design system the
// build agent uses to generate professional-looking deliverables.

var loader = require('./data-loader');

// 3-stage reasoning-rule cascade: exact match → substring → keyword tokens
function findReasoningRule(category) {
  var rules = loader.loadCsv('ui-reasoning.csv');
  if (!rules.length) return null;
  var cat = (category || '').toLowerCase().trim();

  // Stage 1: exact match
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].UI_Category && rules[i].UI_Category.toLowerCase().trim() === cat) {
      return rules[i];
    }
  }
  // Stage 2: substring containment
  for (var j = 0; j < rules.length; j++) {
    var ruleCat = (rules[j].UI_Category || '').toLowerCase();
    if (ruleCat && (ruleCat.includes(cat) || cat.includes(ruleCat))) {
      return rules[j];
    }
  }
  // Stage 3: keyword token match
  var queryTokens = cat.split(/[\s,]+/).filter(function(t) { return t.length >= 2; });
  var bestScore = 0;
  var bestRule = null;
  for (var k = 0; k < rules.length; k++) {
    var ruleTokens = (rules[k].UI_Category || '').toLowerCase().split(/[\s,]+/);
    var hits = 0;
    for (var q = 0; q < queryTokens.length; q++) {
      if (ruleTokens.indexOf(queryTokens[q]) !== -1) hits++;
    }
    if (hits > bestScore) { bestScore = hits; bestRule = rules[k]; }
  }
  return bestRule;
}

// Re-rank style results by exact-name and keyword match against the reasoning's Style_Priority
function rerankStyles(styles, stylePriority) {
  if (!stylePriority) return styles;
  var priorityNames = stylePriority.toLowerCase().split('+').map(function(s) { return s.trim(); });
  return styles.map(function(s) {
    var score = 0;
    var styleName = (s['Style Category'] || '').toLowerCase();
    var keywords = (s['Keywords'] || '').toLowerCase();
    for (var i = 0; i < priorityNames.length; i++) {
      var pn = priorityNames[i].trim();
      if (pn && styleName.includes(pn)) score += 10;
      if (pn && keywords.includes(pn)) score += 3;
    }
    return { doc: s, score: score };
  }).sort(function(a, b) { return b.score - a.score; })
    .map(function(item) { return item.doc; });
}

function generateDesignSystem(query) {
  // 1. Find the product type
  var productResults = loader.searchDomain('product', query, 1);
  var category = productResults.length > 0 ? (productResults[0]['Product Type'] || '') : '';

  // 2. Find the reasoning rule for this category
  var reasoning = category ? findReasoningRule(category) : null;

  // 3. Run BM25 across style, color, landing, typography
  var styleQuery = query;
  if (reasoning && reasoning.Style_Priority) {
    styleQuery = query + ' ' + reasoning.Style_Priority;
  }
  var styles = loader.searchDomain('style', styleQuery, 3);
  if (reasoning && reasoning.Style_Priority) {
    styles = rerankStyles(styles, reasoning.Style_Priority);
  }
  var colors = loader.searchDomain('color', category || query, 1);
  var landing = loader.searchDomain('landing', query, 1);
  var typography = loader.searchDomain('typography', query, 1);

  // 4. Build the design system object
  var ds = {
    category: category || 'General',
    style: styles[0] || null,
    colors: colors[0] || null,
    typography: typography[0] || null,
    landingPattern: landing[0] || null,
    keyEffects: reasoning ? reasoning.Key_Effects : null,
    antiPatterns: reasoning ? reasoning.Anti_Patterns : null,
    checklist: [
      'No emojis as icons (use SVG: Heroicons/Lucide)',
      'cursor-pointer on all clickable elements',
      'Hover states with smooth transitions (150-300ms)',
      'Light mode: text contrast 4.5:1 minimum',
      'Focus states visible for keyboard nav',
      'prefers-reduced-motion respected',
      'Responsive: 375px, 768px, 1024px, 1440px',
    ],
  };

  return ds;
}

// Format the design system as a prompt-injectable string for the build agent
function formatDesignSystemForPrompt(ds) {
  if (!ds) return '';
  var lines = ['DESIGN SYSTEM (use these exact values — do not improvise):'];

  if (ds.category) lines.push('Industry: ' + ds.category);

  if (ds.style) {
    lines.push('Style: ' + (ds.style['Style Category'] || '') +
      ' — ' + (ds.style['Keywords'] || ''));
    if (ds.style['Effects & Animation']) lines.push('Effects: ' + ds.style['Effects & Animation']);
  }

  if (ds.colors) {
    lines.push('Colors:');
    if (ds.colors.Primary) lines.push('  Primary: ' + ds.colors.Primary);
    if (ds.colors.Secondary) lines.push('  Secondary: ' + ds.colors.Secondary);
    if (ds.colors.Accent) lines.push('  Accent: ' + ds.colors.Accent);
    if (ds.colors.Background) lines.push('  Background: ' + ds.colors.Background);
    if (ds.colors.Foreground) lines.push('  Foreground: ' + ds.colors.Foreground);
    if (ds.colors.Muted) lines.push('  Muted: ' + ds.colors.Muted);
    if (ds.colors.Border) lines.push('  Border: ' + ds.colors.Border);
  }

  if (ds.typography) {
    lines.push('Typography:');
    if (ds.typography['Heading Font']) lines.push('  Heading: ' + ds.typography['Heading Font']);
    if (ds.typography['Body Font']) lines.push('  Body: ' + ds.typography['Body Font']);
    if (ds.typography['CSS Import']) lines.push('  CSS Import: ' + ds.typography['CSS Import']);
  }

  if (ds.landingPattern) {
    lines.push('Layout Pattern: ' + (ds.landingPattern['Pattern Name'] || ''));
    if (ds.landingPattern['Section Order']) lines.push('  Sections: ' + ds.landingPattern['Section Order']);
    if (ds.landingPattern['Primary CTA Placement']) lines.push('  CTA: ' + ds.landingPattern['Primary CTA Placement']);
  }

  if (ds.keyEffects) lines.push('Key Effects: ' + ds.keyEffects);
  if (ds.antiPatterns) lines.push('AVOID (anti-patterns for this industry): ' + ds.antiPatterns);

  if (ds.checklist && ds.checklist.length) {
    lines.push('Pre-delivery checklist:');
    for (var i = 0; i < ds.checklist.length; i++) {
      lines.push('  [ ] ' + ds.checklist[i]);
    }
  }

  return lines.join('\n');
}

module.exports = { generateDesignSystem: generateDesignSystem, formatDesignSystemForPrompt: formatDesignSystemForPrompt, findReasoningRule: findReasoningRule };
```

### Step 2e: Inject into build agent prompt

**File:** `src/core/effectors/agent-actions.js`

#### CURRENT factory signature (line 46):
```js
function createAgentActions({ fs, pipeline, kanban, buildRunner }) {
```

#### CHANGE TO:
```js
function createAgentActions({ fs, pipeline, kanban, buildRunner, designSystem }) {
```

#### Add designSystem require at top of file (after line 10 `var path = require('path');`):
```js
var designSystemEngine = require('../design/system');
```

#### CURRENT executePipelineCard prompt construction (line 104):
```js
      prompt: DELIVERABLE_PREAMBLE + card.text,
```

#### CHANGE TO:
```js
      prompt: (function() {
        var base = DELIVERABLE_PREAMBLE + card.text;
        if (designSystem) {
          try {
            var ds = designSystemEngine.generateDesignSystem(card.text);
            var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
            if (dsBlock) return dsBlock + '\n\n' + base;
          } catch (_) { /* design system lookup is best-effort */ }
        }
        return base;
      })(),
```

#### CURRENT buildKanbanCard prompt construction (line 150):
```js
      prompt: BUILDER_PREAMBLE + card.title + '\n' + (card.detail || ''),
```

#### CHANGE TO:
```js
      prompt: (function() {
        var base = BUILDER_PREAMBLE + card.title + '\n' + (card.detail || '');
        if (designSystem) {
          try {
            var ds = designSystemEngine.generateDesignSystem(card.title + ' ' + (card.detail || ''));
            var dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
            if (dsBlock) return dsBlock + '\n\n' + base;
          } catch (_) { /* best-effort */ }
        }
        return base;
      })(),
```

#### Wire `designSystem: true` flag in main.js construction (line 212-214):

CURRENT:
```js
      var agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector, buildRunner: buildRunner
      });
```

CHANGE TO:
```js
      var agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector, buildRunner: buildRunner,
        designSystem: true  // enables design-system prompt injection
      });
```

---

## 4. Integration 3: Build Verification

**Goal:** After the brain generates HTML, verify it before saving. If it fails, regenerate once with the issues appended.

### Step 3a: Verifier module — NEW FILE

**File:** `src/core/design/verify.js`

```js
'use strict';

// design/verify.js — post-generation verification for build deliverables.
// Runs a quick brain.think({lane:'simple'}) self-check against the generated
// content. Returns {pass, issues}. If fail, the build runner retries once with
// the issues appended to the prompt.

function createVerifier({ brain }) {
  if (!brain || typeof brain.think !== 'function') {
    return { verify: function() { return Promise.resolve({ pass: true, issues: [] }); } };
  }

  async function verify(raw, spec) {
    // Quick structural checks first (no LLM call)
    var issues = [];
    var content = String(raw || '');

    if (!content.trim()) {
      return { pass: false, issues: ['empty output'] };
    }
    if (/<!DOCTYPE html/i.test(content)) {
      if (!/<title>[^<]+<\/title>/i.test(content)) issues.push('missing <title> tag');
      if (!/<meta[^>]+viewport/i.test(content)) issues.push('missing viewport meta tag (not responsive)');
      if (!/@media/i.test(content)) issues.push('no @media queries (not responsive)');
    }

    // If structural checks pass, do a quick LLM self-check
    if (issues.length === 0) {
      try {
        var result = await brain.think({
          lane: 'simple',
          messages: [{ role: 'user', content:
            'Check this HTML deliverable against the spec. Spec: "' +
            String(spec || '').slice(0, 200) +
            '". Does the deliverable match the spec topic? Is the title derived from the spec (not an invented brand name)? ' +
            'Respond as JSON: {"pass": true/false, "issues": ["issue1", "issue2"]}\n\n' +
            'Deliverable (first 500 chars): ' + content.slice(0, 500)
          }],
          schemaHint: '{ pass: boolean, issues: string[] }',
          source: 'build-verifier',
        });
        if (result && !result.offline && result.parsed) {
          if (result.parsed.pass === false && Array.isArray(result.parsed.issues)) {
            issues = issues.concat(result.parsed.issues);
          }
        }
      } catch (_) { /* verifier LLM call is best-effort — don't block builds on it */ }
    }

    return { pass: issues.length === 0, issues: issues };
  }

  return { verify: verify };
}

module.exports = { createVerifier: createVerifier };
```

### Step 3b: Integrate into build-runner.js pump()

**File:** `src/core/effectors/build-runner.js`

#### CURRENT factory signature (line 19):
```js
function createBuildRunner({ config, brain, bus, vault }) {
```

#### CHANGE TO:
```js
function createBuildRunner({ config, brain, bus, vault, verifier }) {
```

#### CURRENT pump() core (lines 127-145):
```js
    try {
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id
      });

      if (!result || result.offline) {
        throw new Error('brain offline — chain exhausted for lane "build"');
      }
      if (result.aborted) {
        throw new Error('build aborted');
      }

      job.stage = 'writing-artifact';
      notify(job);

      var raw = result.content;
      var runResult = await run(raw, job);
```

#### CHANGE TO (insert verification between brain return and run()):
```js
    try {
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id
      });

      if (!result || result.offline) {
        throw new Error('brain offline — chain exhausted for lane "build"');
      }
      if (result.aborted) {
        throw new Error('build aborted');
      }

      // Verification gate — check the output before saving. If it fails and we
      // haven't retried yet, regenerate once with the issues appended.
      var raw = result.content;
      if (verifier && typeof verifier.verify === 'function') {
        job.stage = 'verifying';
        notify(job);
        var verification = await verifier.verify(raw, prompt);
        if (!verification.pass && !job._retried) {
          job._retried = true;
          var retryResult = await brain.think({
            lane: 'build',
            messages: [{ role: 'user', content:
              prompt + '\n\nYour previous output had these problems: ' +
              verification.issues.join('; ') + '. Fix them and regenerate.'
            }],
            source: 'build-runner-retry:' + job.id
          });
          if (retryResult && !retryResult.offline) {
            raw = retryResult.content;
          }
        } else if (!verification.pass) {
          // Retried already or retry failed — save anyway but record issues
          job.verificationIssues = verification.issues;
        }
      }

      job.stage = 'writing-artifact';
      notify(job);

      var runResult = await run(raw, job);
```

#### Wire verifier in main.js (line 211):

CURRENT:
```js
      buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs });
```

CHANGE TO:
```js
      var verifier = require('./core/design/verify').createVerifier({ brain: brain });
      buildRunner = createBuildRunner({ config: config, brain: brain, bus: bus, vault: memory.fs, verifier: verifier });
```

---

## 5. Integration 4: Specialized Agent Personas

**Goal:** Allow per-call persona override so the mission orchestrator can dispatch specialized agents (frontend-builder, backend-builder, reviewer).

### Step 4a: Add persona parameter to brain.think()

**File:** `src/core/brain/index.js`

#### CURRENT think() signature (line 45):
```js
    async think({ lane, messages, schemaHint, budget, signal, source, onToken }) {
```

#### CHANGE TO:
```js
    async think({ lane, messages, schemaHint, budget, signal, source, onToken, persona }) {
```

#### CURRENT persona injection (lines 59-67):
```js
      if (['voice', 'build', 'simple'].indexOf(lane) !== -1) {
        const personaLine = identity && typeof identity.persona === 'function'
          ? identity.persona() + ' Be concise and actionable.'
          : 'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + '. Be concise and actionable.';
        msgs = [
          { role: 'system', content: personaLine },
          ...msgs
        ];
      }
```

#### CHANGE TO (add persona override check):
```js
      if (['voice', 'build', 'simple'].indexOf(lane) !== -1) {
        // Per-call persona override — when the caller passes a `persona` string,
        // use it instead of the global identity persona. This enables specialized
        // agent seats (frontend-builder, backend-builder, reviewer) without
        // changing the global identity. When persona is absent, keep the default.
        var personaLine;
        if (persona) {
          personaLine = persona + ' Be concise and actionable.';
        } else if (identity && typeof identity.persona === 'function') {
          personaLine = identity.persona() + ' Be concise and actionable.';
        } else {
          personaLine = 'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + '. Be concise and actionable.';
        }
        msgs = [
          { role: 'system', content: personaLine },
          ...msgs
        ];
      }
```

### Step 4b: Persona registry — NEW FILE

**File:** `src/core/agents/personas.js`

```js
'use strict';

// agents/personas.js — specialized agent persona registry. Each role has a
// markdown file in vault/Personas/ defining its expertise, process, and style.
// Loaded on demand and cached. Used by the mission orchestrator to dispatch
// specialized builder/reviewer agents.

var fs = require('fs');
var path = require('path');

var PERSONAS_DIR = path.join(__dirname, '..', '..', '..', 'vault', 'Personas');
var cache = {};

function loadPersona(role) {
  if (!role) return null;
  if (cache[role]) return cache[role];
  var filePath = path.join(PERSONAS_DIR, role + '.md');
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    cache[role] = content.trim();
    return cache[role];
  } catch (err) {
    return null; // persona not found — caller falls back to global identity
  }
}

function listPersonas() {
  try {
    return fs.readdirSync(PERSONAS_DIR)
      .filter(function(f) { return f.endsWith('.md'); })
      .map(function(f) { return f.replace('.md', ''); });
  } catch (err) {
    return [];
  }
}

// Pick the best persona for a kanban card based on its title/detail content
function pickBuilderPersona(cardTitle, cardDetail) {
  var text = ((cardTitle || '') + ' ' + (cardDetail || '')).toLowerCase();
  var frontendKeywords = ['ui', 'ux', 'page', 'landing', 'frontend', 'design', 'css', 'layout', 'component', 'navigation', 'dashboard', 'form', 'button', 'hero', 'sidebar', 'interface'];
  for (var i = 0; i < frontendKeywords.length; i++) {
    if (text.includes(frontendKeywords[i])) return 'frontend-builder';
  }
  return 'backend-builder';
}

module.exports = { loadPersona: loadPersona, listPersonas: listPersonas, pickBuilderPersona: pickBuilderPersona };
```

### Step 4c: Create persona markdown files

Create directory `vault/Personas/` and add these files:

**`vault/Personas/frontend-builder.md`:**
```markdown
You are the Frontend Builder agent for MYTHOS. You specialize in creating professional, responsive, accessible user interfaces. You use the provided DESIGN SYSTEM values exactly — colors, fonts, layout patterns. You never improvise colors or fonts when a design system is provided. Every HTML page you produce is self-contained, mobile-first, includes proper viewport meta, semantic HTML, WCAG-compliant contrast ratios, hover/focus states, and responsive breakpoints at 375px/768px/1024px/1440px. You test mentally against the pre-delivery checklist before outputting.
```

**`vault/Personas/backend-builder.md`:**
```markdown
You are the Backend Builder agent for MYTHOS. You specialize in logic, data models, APIs, and server-side code. You produce clean, well-structured, documented code that follows best practices for the target language/framework. You handle error states, edge cases, and security boundaries properly. When building markdown deliverables (specs, plans, documentation), you are thorough and precise.
```

**`vault/Personas/reviewer.md`:**
```markdown
You are the Reviewer agent for MYTHOS. You check built deliverables against their spec. You are thorough and honest — you flag missing requirements, broken patterns, hallucinated content, accessibility issues, and design system violations. You never rubber-stamp. If the deliverable is good, you say so briefly. If it has problems, you list them precisely so the builder can fix them.
```

**`vault/Personas/reality-checker.md`:**
```markdown
You are the Reality Checker agent for MYTHOS. You verify that claims and content in deliverables are factually accurate. You flag hallucinated statistics, invented brand names, fabricated quotes, and content that appears made up rather than sourced. You are especially vigilant about titles and names — if the user didn't specify a name, the deliverable should use a descriptive title from the idea, not an invented brand.
```

### Step 4d: Wire personas into buildKanbanCard

**File:** `src/core/effectors/agent-actions.js`

At the top of the file, add:
```js
var personas = require('../agents/personas');
```

In `buildKanbanCard`, the `buildRunner.enqueue` call needs a persona passed through. Currently the prompt is a string. We need to also pass a persona. The cleanest way: add an optional `persona` field to the enqueue object, which build-runner passes to brain.think.

#### In agent-actions.js buildKanbanCard, CHANGE the enqueue call (line 147):

CURRENT:
```js
    var job = buildRunner.enqueue({
      kind: 'kanban-build',
      goalId: goalId,
      prompt: BUILDER_PREAMBLE + card.title + '\n' + (card.detail || ''),
      run: async function(raw, j) {
```

CHANGE TO (add persona selection):
```js
    var builderPersonaRole = personas.pickBuilderPersona(card.title, card.detail);
    var builderPersona = personas.loadPersona(builderPersonaRole);
    var job = buildRunner.enqueue({
      kind: 'kanban-build',
      goalId: goalId,
      prompt: BUILDER_PREAMBLE + card.title + '\n' + (card.detail || ''),
      persona: builderPersona,  // passed through to brain.think
      run: async function(raw, j) {
```

### Step 4e: Pass persona through build-runner to brain.think

**File:** `src/core/effectors/build-runner.js`

#### CURRENT enqueue signature (line 95):
```js
  function enqueue({ kind, prompt, run, goalId }) {
    var job = {
```

#### CHANGE TO:
```js
  function enqueue({ kind, prompt, run, goalId, persona }) {
    var job = {
```

#### Add persona to the queue entry (line 108):

CURRENT:
```js
    queue.push({ job: job, prompt: prompt, run: run });
```

CHANGE TO:
```js
    queue.push({ job: job, prompt: prompt, run: run, persona: persona });
```

#### In pump(), extract and pass persona (line 122):

CURRENT:
```js
    var job = next.job, prompt = next.prompt, run = next.run;
```

CHANGE TO:
```js
    var job = next.job, prompt = next.prompt, run = next.run, persona = next.persona;
```

#### In pump(), pass persona to brain.think (line 128-132):

CURRENT:
```js
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id
      });
```

CHANGE TO:
```js
      var result = await brain.think({
        lane: 'build',
        messages: [{ role: 'user', content: prompt }],
        source: 'build-runner:' + job.id,
        persona: persona || undefined
      });
```

---

## 6. Integration 5: Exa Web Search

**Goal:** Give the entity real web search capability (not just URL fetch).

### Step 5a: Web search module — NEW FILE

**File:** `src/core/effectors/web-search.js`

```js
'use strict';

// effectors/web-search.js — web search effector. Uses Exa's free search API
// (no key needed for basic tier), falls back to DuckDuckGo HTML scraping if
// Exa is unavailable. Returns titles, URLs, and snippets.

var EXA_SEARCH_URL = 'https://api.exa.ai/search';
var DDG_HTML_URL = 'https://html.duckduckgo.com/html/?q=';

async function web_search({ query, numResults }) {
  try {
    if (!query || !String(query).trim()) return { ok: false, result: 'A search query is required.' };
    var q = String(query).trim();
    var maxResults = Math.min(numResults || 5, 10);

    // Try Exa first (free tier, no key required for basic search)
    try {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, 10000);
      var exaRes = await fetch(EXA_SEARCH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          numResults: maxResults,
          contents: { text: true },
        }),
      });
      clearTimeout(timer);
      if (exaRes.ok) {
        var exaData = await exaRes.json();
        if (exaData.results && exaData.results.length) {
          var results = exaData.results.map(function(r) {
            return {
              title: r.title || '',
              url: r.url || '',
              snippet: (r.text || '').slice(0, 300),
            };
          });
          return { ok: true, result: { query: q, results: results.slice(0, maxResults), source: 'exa' } };
        }
      }
    } catch (_) { /* Exa unavailable — fall through to DuckDuckGo */ }

    // Fallback: DuckDuckGo HTML scraping via Jina Reader for clean text
    try {
      var ddgController = new AbortController();
      var ddgTimer = setTimeout(function() { ddgController.abort(); }, 12000);
      var ddgRes = await fetch('https://r.jina.ai/' + DDG_HTML_URL + encodeURIComponent(q), {
        signal: ddgController.signal,
        headers: { 'Accept': 'text/plain' },
      });
      clearTimeout(ddgTimer);
      if (ddgRes.ok) {
        var ddgText = await ddgRes.text();
        // Parse DuckDuckGo result snippets from the markdown text
        var ddgResults = [];
        var lines = ddgText.split('\n');
        for (var i = 0; i < lines.length && ddgResults.length < maxResults; i++) {
          var line = lines[i].trim();
          // Jina returns links as [text](url) — extract result links
          var linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
          if (linkMatch && !linkMatch[2].includes('duckduckgo.com')) {
            ddgResults.push({
              title: linkMatch[1],
              url: linkMatch[2],
              snippet: (lines[i + 1] || '').trim().slice(0, 300),
            });
          }
        }
        if (ddgResults.length) {
          return { ok: true, result: { query: q, results: ddgResults, source: 'duckduckgo' } };
        }
      }
    } catch (_) { /* DuckDuckGo also unavailable */ }

    return { ok: false, result: 'All search providers are unavailable.' };
  } catch (err) {
    return { ok: false, result: 'Search failed: ' + err.message };
  }
}

module.exports = { web_search: web_search };
```

### Step 5b: Register in from-dashboard.js and voice CATALOG

**File:** `src/core/effectors/from-dashboard.js`

Add at the top (after line 26 `const { ALL_ROUTES, SYNONYMS } = require('./routes');`):
```js
const { web_search } = require('./web-search');
```

In the TOOLS array (after the `web_fetch` entry), add:
```js
    { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets. Use for research, news, or any question requiring current data.', params: { query: 'string - the search query', numResults: 'number (optional, default 5)' }, danger: false, fn: async function(args) { return web_search(args); } },
```

**File:** `src/core/voice/voice-agent.js`

In the CATALOG array (after the `web_fetch` entry), add:
```js
  { name: 'web_search', description: 'Search the web for real-time information. Returns titles, URLs, and snippets.', params: { query: 'string', numResults: 'number (optional)' }, danger: false },
```

### Step 5c: Update test assertions

The hub count test needs bumping from 47 to 48 (one new tool):

**File:** `test/effectors-hub.test.js`

CURRENT (line 127):
```js
    assert.equal(hub.count(), 47);
```

CHANGE TO:
```js
    assert.equal(hub.count(), 48);
```

And the describe/it titles:
```js
describe('gate: 48 registered count', () => {
  it('booting a hub with all five register* functions against the real TOOLS arrays yields exactly 48', () => {
```

---

## 7. main.js DI Wiring

Here is the COMPLETE wiring for all 5 integrations in `src/main.js`, in the effector boot step (lines ~207-258).

### The complete wiring block (REPLACE lines 211-214 with this):

```js
      // Integration 3: build verifier (needs brain)
      var verifier = require('./core/design/verify').createVerifier({ brain: brain });

      buildRunner = createBuildRunner({
        config: config, brain: brain, bus: bus, vault: memory.fs,
        verifier: verifier  // Integration 3
      });

      // Integration 2 + 4: agent actions with design system + persona dispatch
      var agentActionsEffector = createAgentActions({
        fs: memory.fs, pipeline: pipelineEffector, kanban: kanbanEffector,
        buildRunner: buildRunner,
        designSystem: true  // Integration 2: enables design-system prompt injection
      });
```

Everything else in main.js stays the same. The orchestrator (line 253-256) already takes `agentActions` and `buildRunner`, so personas (Integration 4) and verification (Integration 3) flow through automatically.

---

## 8. Verification & Testing

### After each integration, run:

```bash
cd mythos
node -e "require('./src/core/design/bm25')" && echo "bm25 OK"
node -e "require('./src/core/design/data-loader')" && echo "data-loader OK"
node -e "require('./src/core/design/system')" && echo "system OK"
node -e "require('./src/core/design/verify')" && echo "verify OK"
node -e "require('./src/core/agents/personas')" && echo "personas OK"
node -e "require('./src/core/effectors/web-search')" && echo "web-search OK"
```

### Full test suite:

```bash
node --test
```

Expected: 4 pre-existing failures (boot.test.js Windows signal, identity.test.js old-persona assertions × 3). Zero new failures.

### After Integration 5 (web_search), bump the hub count test:

```bash
# The test at test/effectors-hub.test.js line 127 must equal 48 (was 47)
# The test titles must say "48" not "47"
```

### Design system smoke test:

```js
// Run this to verify the design system lookup works:
node -e "
var ds = require('./src/core/design/system');
var result = ds.generateDesignSystem('beauty spa wellness service');
console.log('Category:', result.category);
console.log('Style:', result.style && result.style['Style Category']);
console.log('Colors:', result.colors && result.colors.Primary);
console.log('Typography:', result.typography && result.typography['Heading Font']);
console.log('Pattern:', result.landingPattern && result.landingPattern['Pattern Name']);
"
```

### What NOT to change:
- Do NOT modify the voice loop, VAD, or pre-roll buffer
- Do NOT modify the OODA loop, leash, or immune system
- Do NOT modify the event bus or conformance test (no new events in these integrations)
- Do NOT add npm dependencies — everything is Node.js built-in (`fs`, `path`, `fetch`)
- Do NOT modify the 4 pre-existing test failures

### File creation checklist:
```
NEW FILES:
  vault/Design/data/*.csv           (14+ CSV data files from the ui-ux-pro-max repo)
  src/core/design/bm25.js           (BM25 search engine)
  src/core/design/data-loader.js    (CSV parser + domain config)
  src/core/design/system.js         (design system generator + prompt formatter)
  src/core/design/verify.js         (build verifier)
  src/core/agents/personas.js       (persona registry)
  src/core/effectors/web-search.js  (Exa/DDG search)
  vault/Personas/frontend-builder.md
  vault/Personas/backend-builder.md
  vault/Personas/reviewer.md
  vault/Personas/reality-checker.md

MODIFIED FILES:
  src/core/effectors/from-dashboard.js   (Jina upgrade + web_search registration)
  src/core/effectors/agent-actions.js    (design system injection + persona dispatch)
  src/core/effectors/build-runner.js     (verifier gate + persona passthrough)
  src/core/brain/index.js               (persona parameter in think())
  src/core/voice/voice-agent.js         (web_search in CATALOG)
  src/main.js                           (DI wiring: verifier, designSystem flag)
  test/effectors-hub.test.js            (count 47 → 48)
```
