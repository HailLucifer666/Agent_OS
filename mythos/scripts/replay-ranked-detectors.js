#!/usr/bin/env node
'use strict';

// replay-ranked-detectors.js — the acceptance gate for BUG-275's detector family.
//
// WHY THIS EXISTS. A detector tested only on the turn it was written for tells
// you it catches that turn. It does not tell you how often it fires on the other
// two hundred. This repo has the lesson on record: a detector shipped after
// passing on its own fixture caught 1 of 9 real cases, and the cause it named
// was wrong. So before H1's detector is trusted, it is replayed over a whole
// measured session and the hit count is read off, not predicted.
//
// WHAT IT DOES. Walks an Episodic vault day file, rebuilds each assistant
// reply's evidence window from the action records around it (the same 120s rule
// the live ledger uses), and runs both ranked detectors over every reply. Prints
// one line per hit and a count.
//
// THE SCHEMA WAS READ, NOT GUESSED, and the first version of this script is why
// that sentence is here. It looked for `row.tool` and `row.assistantText`, found
// neither, and reported "0 replies, 0 hits" — a clean-looking result from a
// reader that had not parsed a single row. The real shape, from the 2026-08-19
// file: `kind:"conversation"` carries the reply at `detail.reply`, and
// `kind:"action"` carries the tool name inside `summary` ("media_status({})") and
// the RAW RESULT at `detail.result`. So digests here are built from the same
// bytes the live path digests, not from a summary.
//
// WHAT A ZERO STILL DOES NOT PROVE. A reply whose evidence window holds no
// usable result is skipped, and the count of those is printed beside the hits.
// Read both numbers or read neither: hits=0 with withEvidence=0 measured
// nothing, and the script says so in as many words.
//
// BUG-275, 2026-09-23 — A THIRD PASS, AND ITS OWN RULE ABOUT EVIDENCE. The
// unsearched-current-fact detector fires on replies WITHOUT a web lookup, so it
// cannot use the evidence filter above (which skips exactly those replies). It
// runs over EVERY reply, against every action in the window plus the turn's own
// detail.actions. An archived day (Episodic/_archive/<day>.md.gz — the vault's
// own archive format, raw rows inside a code fence) is read too, because
// 2026-08-19, BUG-275's evidence session, is archived now.
//
// Usage:
//   node scripts/replay-ranked-detectors.js                       # today
//   node scripts/replay-ranked-detectors.js 2026-08-19            # one day
//   node scripts/replay-ranked-detectors.js 2026-08-19 --verbose
//   node scripts/replay-ranked-detectors.js path/to/day.jsonl     # a file

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectUnsourcedRankedEntities, detectPromotedRankedEntities, EVIDENCE_TOOLS,
} = require('../src/core/voice/ranked-claim-check');
const { buildEvidenceDigest } = require('../src/core/voice/evidence-digest');
const { detectUnsearchedCurrentFacts } = require('../src/core/voice/unsearched-current-fact');
const zlib = require('node:zlib');

const WINDOW_MS = 120000; // the live recent-action ledger's window

function vaultDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MYTHOS', 'vault', 'Episodic');
}

function readDay(day) {
  let file = /\.jsonl$/.test(day) ? path.resolve(day) : path.join(vaultDir(), day + '.jsonl');
  let body = null;
  if (fs.existsSync(file)) body = fs.readFileSync(file, 'utf8');
  else {
    const archived = path.join(vaultDir(), '_archive', day + '.md.gz');
    if (!fs.existsSync(archived)) {
      console.error('no such day file: ' + file + ' (nor ' + archived + ')');
      process.exit(2);
    }
    file = archived;
    body = zlib.gunzipSync(fs.readFileSync(archived)).toString('utf8');
  }
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a partial last line is normal */ }
  }
  return { file, rows };
}

// ts is epoch milliseconds in this vault, not an ISO string.
const at = (row) => (typeof row.ts === 'number' ? row.ts : Date.parse(row.ts || row.at || 0) || 0);
const isAction = (row) => row && row.kind === 'action';
// summary is `tool({json})`; the tool name is everything before the first '('.
const toolOf = (row) => {
  const s = String(row.summary || '');
  const i = s.indexOf('(');
  return i > 0 ? s.slice(0, i).trim() : s.trim();
};
const replyOf = (row) => (row && row.kind === 'conversation' && row.detail
  && typeof row.detail.reply === 'string' && row.detail.reply.trim() ? row.detail.reply : null);
// The result content the digest needs, at the path this vault actually uses.
const resultOf = (row) => (row.detail && row.detail.result !== undefined ? row.detail.result : undefined);

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a) || /\.jsonl$/.test(a)) || new Date().toISOString().slice(0, 10);
  const { file, rows } = readDay(day);

  const actions = rows.filter(isAction).map((row) => ({
    tool: toolOf(row), at: at(row),
    ok: row.outcome === 'ok' || (row.detail && row.detail.ok === true),
    unverified: !!(row.detail && row.detail.unverified === true),
    evidence: buildEvidenceDigest(resultOf(row)),
  })).filter((a) => EVIDENCE_TOOLS.indexOf(a.tool) !== -1);

  const allActions = rows.filter(isAction).map((row) => ({ tool: toolOf(row), at: at(row) }));
  let replies = 0, withEvidence = 0;
  const hits = { promoted: [], unsourced: [], unsearched: [] };

  for (const row of rows) {
    const text = replyOf(row);
    if (!text) continue;
    replies += 1;
    const when = at(row);
    const turnActions = ((row.detail && row.detail.actions) || []).filter((a) => a && a.tool);
    const recent = allActions.filter((a) => a.at <= when && when - a.at <= WINDOW_MS);
    for (const hit of detectUnsearchedCurrentFacts(text, turnActions, recent)) hits.unsearched.push({ when, hit });
    const window = actions.filter((a) => a.at <= when && when - a.at <= WINDOW_MS && a.evidence);
    if (!window.length) continue;
    withEvidence += 1;
    for (const hit of detectPromotedRankedEntities(text, [], window)) hits.promoted.push({ when, hit });
    for (const hit of detectUnsourcedRankedEntities(text, [], window)) hits.unsourced.push({ when, hit });
  }

  console.log('replay-ranked-detectors: ' + path.basename(file));
  console.log('  rows=' + rows.length + ' evidence-actions=' + actions.length
    + ' replies=' + replies + ' replies-with-rebuildable-evidence=' + withEvidence);
  console.log('  promoted-ranked-entity hits: ' + hits.promoted.length);
  console.log('  unsourced-ranked-entity hits: ' + hits.unsourced.length);
  console.log('  unsearched-current-fact hits: ' + hits.unsearched.length + ' (over all ' + replies + ' replies)');
  if (!withEvidence) {
    console.log('  NOTE: no reply had rebuildable evidence in this file, so zero hits above');
    console.log('        measured NOTHING. Check the reader before reading the numbers.');
  }
  for (const kind of ['promoted', 'unsourced', 'unsearched']) {
    for (const h of hits[kind]) {
      const names = h.hit.promoted || h.hit.absent || [h.hit.phrase];
      console.log('  ' + kind + ' @' + new Date(h.when).toISOString() + ': ' + names.join(', '));
      if (verbose) console.log('      ' + String(h.hit.sentence).slice(0, 160));
    }
  }
}

main();
