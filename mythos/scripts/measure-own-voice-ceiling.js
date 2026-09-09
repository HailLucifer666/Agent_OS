#!/usr/bin/env node
'use strict';
// BUG-428: read-only replay. Server logs carry releases; Episodic carries the
// anomalies (acknowledgement rows are duplicates, not new missing transcripts).
// framesZeroed is a session counter: the requested sum is explicitly labelled
// a SNAPSHOT sum, never presented as a count of distinct lost frames.
const fs = require('node:fs');

function time(row) { return typeof row.ts === 'number' ? row.ts : Date.parse(row.ts); }
function measure(rows, { from = -Infinity, to = Infinity } = {}) {
  const selected = rows.filter(row => time(row) >= from && time(row) <= to);
  const releases = selected.filter(row => row.msg === 'voice.capture-suspend'
    && row.ownVoiceGate === false && Number.isFinite(row.heldMs));
  const byReason = {};
  for (const row of releases) {
    const group = byReason[row.reason] ||= { releases: 0, heldMs: 0, framesZeroedSnapshotSum: 0 };
    group.releases += 1;
    group.heldMs += row.heldMs;
    group.framesZeroedSnapshotSum += Number.isFinite(row.framesZeroed) ? row.framesZeroed : 0;
  }
  const ceilings = releases.filter(row => row.reason.startsWith('own-voice-ceiling'));
  const seen = new Set();
  const anomalies = selected.filter(row => {
    if (row.detail?.kind !== 'live-turn-no-user-transcript' || row.outcome !== 'anomaly') return false;
    const key = row.detail.eventId || row.id || time(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const near = (a, b) => Math.abs(time(a) - time(b)) <= 2000;
  const checks = selected.filter(row => row.msg === 'live.echo-check');
  return {
    byReason, ceilingReleases: ceilings.length,
    ceilingHeldMs: ceilings.reduce((sum, row) => sum + row.heldMs, 0),
    noUserTranscript: anomalies.length,
    anomaliesNearCeiling: anomalies.filter(a => ceilings.some(c => near(a, c))).length,
    ceilingsNearAnomaly: ceilings.filter(c => anomalies.some(a => near(a, c))).length,
    echoChecks: checks.length, matchedEchoChecks: checks.filter(row => row.decision === 'dropped').length,
  };
}

function main(args) {
  const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const serverLog = option('--server-log');
  const episodic = option('--episodic');
  if (!serverLog || !episodic) throw new Error('Usage: --server-log PATH --episodic PATH [--from ISO --to ISO]');
  let malformedLines = 0;
  const rows = [serverLog, episodic].flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { malformedLines += 1; return []; }
  }));
  const from = option('--from');
  const to = option('--to');
  if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to)))) throw new Error('Invalid ISO time range');
  console.log(JSON.stringify({ from: from || null, to: to || null, malformedLines,
    ...measure(rows, { from: from ? Date.parse(from) : -Infinity, to: to ? Date.parse(to) : Infinity }) }, null, 2));
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { measure };
