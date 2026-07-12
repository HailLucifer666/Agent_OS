'use strict';

// design/data-loader.js — loads CSV files from vault/Design/data/ with a minimal
// quoted-field-aware parser (no external dependency). Caches parsed data in memory.

var fs = require('fs');
var path = require('path');

var DATA_DIR = path.join(__dirname, '..', '..', '..', 'vault', 'Design', 'data');
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
