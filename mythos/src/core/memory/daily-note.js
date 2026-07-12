'use strict';

// memory/daily-note.js — Daily note exporter for Obsidian graph view.
// Writes a markdown file to vault/Memory/Daily/YYYY-MM-DD.md at consolidation time,
// recording goals touched, builds shipped, reminders fired, anomalies.
// Nothing reads these notes — they are for the human's graph view only.

var fs = require('fs');
var path = require('path');

function createDailyNoteExporter({ vaultFs }) {
  if (!vaultFs) return { exportNote: function() {} };

  function exportNote(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return;

    var now = new Date();
    var dateStr = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0');
    var relPath = 'Memory/Daily/' + dateStr + '.md';

    try { vaultFs.ensureDir('Memory/Daily'); } catch (_) {}

    var lines = [];
    lines.push('# ' + dateStr);
    lines.push('');

    // Group entries by kind
    var groups = {};
    for (var i = 0; i < entries.length; i++) {
      var kind = entries[i].kind || 'note';
      if (!groups[kind]) groups[kind] = [];
      groups[kind].push(entries[i]);
    }

    var kinds = Object.keys(groups);
    for (var k = 0; k < kinds.length; k++) {
      lines.push('## ' + kinds[k]);
      lines.push('');
      var items = groups[kinds[k]];
      for (var j = 0; j < items.length; j++) {
        var text = items[j].text || items[j].summary || '(no detail)';
        if (items[j].link) text += ' [[' + items[j].link + ']]';
        lines.push('- ' + text);
      }
      lines.push('');
    }

    var content = lines.join('\n');

    // Append if file exists (consolidation may run multiple times per day)
    try {
      var existing = vaultFs.readText(relPath, '');
      if (existing) {
        // Don't duplicate — check if last entry is already there
        content = existing.trimEnd() + '\n\n' + content;
      }
    } catch (_) {}

    try { vaultFs.writeText(relPath, content); } catch (_) {}
  }

  return { exportNote: exportNote };
}

module.exports = { createDailyNoteExporter };
