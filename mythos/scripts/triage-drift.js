#!/usr/bin/env node
/**
 * triage-drift.js
 *
 * Parses ROADMAP.md's structured drift tables into plain objects so drift
 * triage (checking whether a documented spec-vs-code gap is still real) is
 * mechanically repeatable, instead of re-reading a 1000+ line document by
 * hand every time.
 *
 * Deliberately general: this file does not hardcode any drift-item ID or
 * table location. It re-discovers whatever markdown pipe-tables in the
 * target file have a header row identifying an "ID" column (D-01, D-02, ...)
 * and parses each data row into a record. Point it at any ROADMAP.md-shaped
 * document and it works the same way next time the drift list changes.
 *
 * Recognized table shapes (root ROADMAP.md uses at least three):
 *   | ID | Severity | File:Line | Spec says | Code does |         (per-phase "Drift found" tables)
 *   | #  | ID | Fix required | Status |                            (Phase 4.5 remediation table)
 *   | ID | Severity | File:Line | Finding |                       (Known Deviations table)
 *
 * All three are folded into the same output shape:
 *   { id, severity, file, line, specSays, codeDoes, section, sourceLine }
 * with whichever column supplies "spec says" / "code does" content mapped in
 * (fixRequired -> specSays-ish "what should happen", status/finding -> codeDoes).
 * Zero npm dependencies — uses only Node's built-in fs/path.
 *
 * Usage:
 *   node mythos/scripts/triage-drift.js [path/to/ROADMAP.md]
 *   const { parseDriftTables } = require('./triage-drift');
 *   const items = parseDriftTables(fs.readFileSync('ROADMAP.md', 'utf8'));
 *
 * `items` is a flat array — the same ID can legitimately appear more than
 * once (once per table it's tracked in). Group by `id` (see `groupById`) to
 * spot double-recording: the same drift item described inconsistently in two
 * different tables is exactly the class of bug this tool exists to surface.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROADMAP_PATH = path.join(__dirname, '..', '..', 'ROADMAP.md');

// Header cell (lowercased, whitespace-collapsed) -> canonical role.
const HEADER_ALIASES = {
  id: ['id'],
  severity: ['severity'],
  fileline: ['file:line', 'file / line', 'file'],
  specsays: ['spec says', 'spec'],
  codedoes: ['code does', 'code'],
  finding: ['finding'],
  fixrequired: ['fix required'],
  status: ['status'],
  // The Phase 4.5 table's leading "#" column is just a row counter — ignored.
};

function normalizeHeaderCell(cell) {
  return cell.trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifyHeader(cell) {
  const norm = normalizeHeaderCell(cell);
  for (const canonical of Object.keys(HEADER_ALIASES)) {
    if (HEADER_ALIASES[canonical].includes(norm)) return canonical;
  }
  return null;
}

/**
 * Split one markdown table row into its cell strings. Pipes inside inline
 * code spans (`...`) or escaped with a backslash are not treated as
 * separators — drift rows routinely contain `path/to/file.js` cells and
 * escaped pipes in prose.
 */
function splitTableRow(line) {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);

  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/**
 * Split a "File:Line" cell (e.g. `` `mythos/src/main.js:46-61` `` or
 * `` `mythos/package.json` ``) into { file, line }. Falls back to
 * { file: <raw cell>, line: 'n/a' } when no trailing line number is present.
 */
function parseFileLine(cell) {
  if (!cell) return { file: 'n/a', line: 'n/a' };
  const backtickMatch = cell.match(/`([^`]+)`/);
  const target = (backtickMatch ? backtickMatch[1] : cell).trim();
  const m = target.match(/^(.+?):(\d[\d,\-]*)$/);
  if (m) return { file: m[1], line: m[2] };
  return { file: target || 'n/a', line: 'n/a' };
}

function nearestHeadingAbove(lines, rowIndex) {
  for (let i = rowIndex; i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Find every markdown pipe-table whose header row contains an "id" column
 * and parse its data rows into drift-item records. Tables that don't carry
 * an id column (most tables in the doc) are skipped entirely.
 *
 * @param {string} mdText raw ROADMAP.md contents
 * @returns {Array<{id:string, severity:?string, file:string, line:string,
 *   specSays:?string, codeDoes:?string, section:?string, sourceLine:number}>}
 */
function parseDriftTables(mdText) {
  const lines = mdText.split(/\r?\n/);
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;

    const headerCells = splitTableRow(line);
    const nextLine = lines[i + 1] || '';
    if (!nextLine.trim().startsWith('|')) continue;
    const sepCells = splitTableRow(nextLine);
    if (sepCells.length !== headerCells.length || !isSeparatorRow(sepCells)) continue;

    const roles = headerCells.map(classifyHeader);
    if (!roles.includes('id')) continue; // not a drift-style table — skip

    const section = nearestHeadingAbove(lines, i);
    let j = i + 2;
    for (; j < lines.length; j++) {
      const rowLine = lines[j];
      if (!rowLine.trim().startsWith('|')) break;

      const cells = splitTableRow(rowLine);
      if (cells.length !== roles.length) continue; // malformed row — skip, don't crash

      const record = {};
      roles.forEach((role, idx) => {
        if (role) record[role] = cells[idx];
      });

      const idMatch = (record.id || '').match(/D-\d+/);
      if (!idMatch) continue; // e.g. a stray repeated header or non-item row

      const fl = parseFileLine(record.fileline);

      items.push({
        id: idMatch[0],
        severity: record.severity ? record.severity.trim() : null,
        file: fl.file,
        line: fl.line,
        specSays: (record.specsays || record.fixrequired || null),
        codeDoes: (record.codedoes || record.finding || record.status || null),
        section,
        sourceLine: j + 1, // 1-indexed
      });
    }
    i = j - 1; // resume scanning after this table
  }

  return items;
}

/** Group a flat item list by drift ID — reveals double/triple-recording. */
function groupById(items) {
  const byId = {};
  for (const item of items) {
    if (!byId[item.id]) byId[item.id] = [];
    byId[item.id].push(item);
  }
  return byId;
}

/**
 * Flag IDs that appear in more than one table where the "code does" /
 * "status" / "finding" text disagrees about resolved-vs-open state. This is
 * a cheap heuristic (presence of a checkmark / "RESOLVED" is treated as
 * "closed"), meant to point a human/triage-agent at candidates to inspect,
 * not to be authoritative on its own.
 */
function findInconsistentRecordings(items) {
  const RESOLVED_HINT = /✅|RESOLVED|Fixed|fixed/;
  const byId = groupById(items);
  const inconsistent = [];
  for (const id of Object.keys(byId)) {
    const occurrences = byId[id];
    if (occurrences.length < 2) continue;
    const states = occurrences.map((o) => RESOLVED_HINT.test(o.codeDoes || ''));
    const allSame = states.every((s) => s === states[0]);
    if (!allSame) {
      inconsistent.push({ id, occurrences });
    }
  }
  return inconsistent;
}

function loadRoadmap(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function main(argv) {
  const target = (argv && argv[2]) || DEFAULT_ROADMAP_PATH;
  const text = loadRoadmap(target);
  const items = parseDriftTables(text);
  const byId = groupById(items);
  const inconsistent = findInconsistentRecordings(items);

  process.stdout.write(
    JSON.stringify(
      {
        source: target,
        totalRows: items.length,
        uniqueIds: Object.keys(byId).length,
        inconsistentIds: inconsistent.map((x) => x.id),
        items,
      },
      null,
      2
    ) + '\n'
  );
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  parseDriftTables,
  groupById,
  findInconsistentRecordings,
  splitTableRow,
  classifyHeader,
  parseFileLine,
};
