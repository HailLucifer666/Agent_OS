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
