#!/usr/bin/env node
'use strict';

// live-logs.js — real-time backend log viewer for the split-pane terminal.
// Tails the MYTHOS episodic + audit + stderr output and formats it into clean,
// structured, color-coded lines. Polls the JSONL files for new entries.

var fs = require('fs');
var path = require('path');

var VAULT = path.resolve(__dirname, '..', 'vault');
var EPISODIC_DIR = path.join(VAULT, 'Episodic');
var AUDIT_DIR = path.join(VAULT, 'Audit');

// ANSI colors
var C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', brightRed: '\x1b[91m', brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m', brightBlue: '\x1b[94m', brightCyan: '\x1b[96m',
};

var seenEpisodic = 0;
var seenAudit = 0;

function fmtTime(ts) {
  if (!ts) return C.gray('--:--:--') + C.reset;
  var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return C.gray('--:--:--') + C.reset;
  var h = String(d.getHours()).padStart(2, '0');
  var m = String(d.getMinutes()).padStart(2, '0');
  var s = String(d.getSeconds()).padStart(2, '0');
  return C.gray(h + ':' + m + ':' + s) + C.reset;
}

function levelTag(level) {
  switch (level) {
    case 'error': return C.brightRed + 'ERROR' + C.reset;
    case 'warn': return C.brightYellow + ' WARN' + C.reset;
    case 'info': return C.dim + ' info' + C.reset;
    case 'debug': return C.gray + 'debug' + C.reset;
    default: return C.dim + level + C.reset;
  }
}

function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max) + C.gray('…') + C.reset : s;
}

function readJsonlTail(filepath, alreadySeen) {
  var lines = [];
  try {
    var content = fs.readFileSync(filepath, 'utf8');
    var all = content.split('\n').filter(function(l) { return l.trim(); });
    if (all.length > alreadySeen) {
      lines = all.slice(alreadySeen);
    }
    return { lines: lines, total: all.length };
  } catch (_) {
    return { lines: [], total: alreadySeen };
  }
}

function todayFilepath(dir) {
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return path.join(dir, y + '-' + m + '-' + day + '.jsonl');
}

function printHeader() {
  console.clear();
  console.log(C.bold + C.cyan + '╔══════════════════════════════════════════════════════════════╗' + C.reset);
  console.log(C.bold + C.cyan + '║' + C.reset + '           MYTHOS BACKEND — LIVE LOG STREAM' + C.bold + C.cyan + '               ║' + C.reset);
  console.log(C.bold + C.cyan + '╚══════════════════════════════════════════════════════════════╝' + C.reset);
  console.log(C.gray + '  Watching: episodic + audit + actions + anomalies' + C.reset);
  console.log(C.gray + '  ' + '─'.repeat(62) + C.reset);
  console.log('');
}

function printEpisodic(entry) {
  var ts = entry.ts || entry.createdAt || Date.now();
  var kind = entry.kind || '?';
  var outcome = entry.outcome || '';
  var summary = entry.summary || '';
  var channel = entry.channel || '';
  var tokens = entry.tokensSpent || 0;

  var kindCol = {
    conversation: C.brightCyan,
    action: C.brightBlue,
    thought: C.magenta,
    'working-snapshot': C.gray,
    perception: C.dim,
  }[kind] || C.dim;

  var outcomeStr = '';
  if (outcome === 'ok') outcomeStr = ' ' + C.brightGreen + '✓' + C.reset;
  else if (outcome === 'fail') outcomeStr = ' ' + C.brightRed + '✗' + C.reset;

  var tokenStr = tokens > 0 ? ' ' + C.gray + '(' + tokens + ' tok)' + C.reset : '';

  console.log(
    fmtTime(ts) + ' ' +
    kindCol + truncate(kind.padEnd(13), 13) + C.reset +
    outcomeStr + tokenStr + ' ' +
    truncate(summary, 80)
  );
}

function printAudit(entry) {
  var ts = entry.ts || Date.now();
  var actor = entry.actor || '?';
  var kind = entry.kind || '?';
  var outcome = entry.outcome || '';
  var playbookId = entry.playbookId || '';
  var target = entry.target || '';

  var kindCol = {
    'cortex-stall': C.brightRed,
    'budget-exhausted': C.brightYellow,
    'provider-down': C.brightRed,
    'quota-low': C.brightYellow,
    'effector-flapping': C.yellow,
    'identity-boundaries-malformed': C.yellow,
    'planner-hallucinated-tool': C.brightRed,
  }[kind] || C.yellow;

  var outcomeCol = {
    applied: C.brightGreen,
    'no-match': C.gray,
    cooldown: C.dim,
    error: C.brightRed,
  }[outcome] || C.gray;

  var detail = '';
  if (playbookId) detail = playbookId;
  else if (target) detail = String(target);

  console.log(
    fmtTime(ts) + ' ' +
    C.gray + truncate(('[' + actor + ']').padEnd(12), 12) + C.reset + ' ' +
    kindCol + truncate(kind.padEnd(36), 36) + C.reset + ' ' +
    outcomeCol + truncate(outcome.padEnd(9), 9) + C.reset + ' ' +
    C.gray + detail + C.reset
  );
}

// Periodic poll loop
var firstRun = true;
function poll() {
  var epFile = todayFilepath(EPISODIC_DIR);
  var auFile = todayFilepath(AUDIT_DIR);

  if (firstRun) {
    printHeader();
    // On first run, seed the seen counters so we only show NEW entries going forward
    try {
      var epContent = fs.readFileSync(epFile, 'utf8');
      seenEpisodic = epContent.split('\n').filter(function(l) { return l.trim(); }).length;
    } catch (_) {}
    try {
      var auContent = fs.readFileSync(auFile, 'utf8');
      seenAudit = auContent.split('\n').filter(function(l) { return l.trim(); }).length;
    } catch (_) {}
    console.log(C.gray + '  ↳ Streaming live... (' + seenEpisodic + ' episodic, ' + seenAudit + ' audit entries buffered)' + C.reset);
    console.log('');
    firstRun = false;
    return;
  }

  // Read new episodic entries
  var ep = readJsonlTail(epFile, seenEpisodic);
  if (ep.lines.length > 0) {
    seenEpisodic = ep.total;
    for (var i = 0; i < ep.lines.length; i++) {
      try { printEpisodic(JSON.parse(ep.lines[i])); } catch (_) {}
    }
  }

  // Read new audit entries
  var au = readJsonlTail(auFile, seenAudit);
  if (au.lines.length > 0) {
    seenAudit = au.total;
    for (var j = 0; j < au.lines.length; j++) {
      try { printAudit(JSON.parse(au.lines[j])); } catch (_) {}
    }
  }
}

// Start polling every 500ms
setInterval(poll, 500);
poll();

// Handle Ctrl+C cleanly
process.on('SIGINT', function() {
  console.log(C.gray + '\n  Log stream stopped.' + C.reset);
  process.exit(0);
});
