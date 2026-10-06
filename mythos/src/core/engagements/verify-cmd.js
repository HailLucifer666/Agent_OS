'use strict';

// verify-cmd.js — moved out of executor.js unchanged (2026-10-06) because that file is on
// the size ratchet and BUG-446's goal check had to land in it. Pure, no imports.

// Minimal shell-like split for v.cmd: respects single + double quotes,
// backslash escapes. Returns null if the command parses to nothing.
// (The run_command effector re-checks each arg for shell metachars and
// allowlist compliance — this parser is just for splitting.)
function parseVerifyCmd(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  var tokens = [];
  var cur = '';
  var quote = null;
  for (var i = 0; i < cmd.length; i++) {
    var c = cmd[i];
    if (quote) {
      if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  if (quote) return null;          // unterminated quote → unparseable
  if (!tokens.length) return null;
  return { command: tokens[0], args: tokens.slice(1) };
}

module.exports = { parseVerifyCmd };
