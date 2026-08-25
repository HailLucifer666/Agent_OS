'use strict';

// levenshtein.js — edit distance between two strings.
//
// Extracted verbatim from voice-agent.js on 2026-08-21 (it had lived there
// since suggestTool's "did you mean" needed it) so from-whatsapp.js's
// resolveRecipient can reuse the same implementation for contact names. Two
// copies of a distance function is how two callers quietly end up disagreeing
// about what "close enough" means, and one of those callers decides which
// human receives a message.
//
// Deliberately dependency-free and side-effect-free: no config, no logger, no
// platform imports. That is what makes it testable on its own and safe to call
// from an effector's hot path.
//
// O(m*n) time, O(n) space (two rolling rows). Case sensitivity is the caller's
// business — both current callers lower-case before calling.
function levenshtein(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  var prev = [];
  var curr = [];
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (var j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

module.exports = { levenshtein };
