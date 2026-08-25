#!/usr/bin/env node
'use strict';

/**
 * triage-incidents.js — BUG-252: close the incident -> BUGS.md loop.
 *
 * MYTHOS records every operator-reported defect into the vault
 * (Semantic/incidents.md, one line per incident, each carrying an
 * `inc-<ms>-<n>` id). A 2026-08-15 audit of 31 recorded incidents found only
 * TWO closed with their incident id cited in BUGS.md — the rest, including six
 * copies of one voice-node loop, whatsapp typing into the wrong window, both
 * camera misidentifications and the HUD colour mismatch, had no BUGS.md entry
 * at all. Nothing was hiding them; there was simply no mechanical way to ask
 * "which of these did we ever write down?", so it was never asked.
 *
 * This is that question, as a script. It is a REPORTER, not a daemon and not a
 * writer: it reads the vault's incident ledger and BUGS.md, and prints which
 * incident ids appear in neither. Deciding what deserves a BUG entry stays a
 * human call — an automated filer would produce 31 entries and a triage
 * problem one layer up, which is the exact shape of the bug it exists to fix
 * (see memory/lessons.js's header: "wrote Incidents/ that nothing read back").
 *
 * Usage:
 *   node mythos/scripts/triage-incidents.js            # full table
 *   node mythos/scripts/triage-incidents.js --check    # exit 1 if any untracked
 *   node mythos/scripts/triage-incidents.js --json     # machine-readable
 *
 * Vault resolution matches vault-sync.js/src/main.js: MYTHOS_VAULT_ROOT wins
 * (Electron sets it to the userData vault), else mythos/vault. Never a
 * hardcoded path — the operator's real vault lives outside the repo.
 *
 * Zero dependencies — node:fs, node:path only.
 */

const fs = require('fs');
const path = require('path');

const MYTHOS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');

function resolveVaultRoot() {
  const explicit = process.env.MYTHOS_VAULT_ROOT;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(MYTHOS_DIR, 'vault');
}

// `- Incident inc-1786236236673-2 (warn, 2026-08-09): text...`
const INCIDENT_RE = /^-\s+Incident\s+(inc-\d+-\d+)\s*\(([^,)]+),\s*([^)]*)\):\s*(.*)$/;

function parseIncidents(markdown) {
  const out = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = INCIDENT_RE.exec(lines[i].trim());
    if (!m) continue;
    out.push({ id: m[1], severity: m[2].trim(), date: m[3].trim(), text: m[4].trim() });
  }
  return out;
}

// An incident counts as tracked when BUGS.md cites its id verbatim. Deliberately
// not fuzzy text matching: a BUG that describes a similar symptom is not proof
// that THIS report was triaged, and a false "tracked" is worse than a false
// "untracked" — one hides work, the other only costs a second look.
function findUntracked(incidents, bugsText) {
  const bugs = String(bugsText || '');
  return incidents.filter(function(inc) { return !bugs.includes(inc.id); });
}

function readIncidentsFile(vaultRoot) {
  const p = path.join(vaultRoot, 'Semantic', 'incidents.md');
  try { return { path: p, text: fs.readFileSync(p, 'utf8') }; }
  catch (_) { return { path: p, text: null }; }
}

function main(argv) {
  const wantJson = argv.includes('--json');
  const checkOnly = argv.includes('--check');
  const vaultRoot = resolveVaultRoot();
  const ledger = readIncidentsFile(vaultRoot);

  if (ledger.text === null) {
    // No ledger is not a failure: a fresh clone has no vault, and CI has no
    // operator. Say which path was looked at so a wrong MYTHOS_VAULT_ROOT is
    // visible rather than silently reported as "nothing to triage".
    const msg = 'no incident ledger at ' + ledger.path + ' — nothing to triage';
    if (wantJson) console.log(JSON.stringify({ vaultRoot, incidents: 0, untracked: [], note: msg }, null, 2));
    else console.log(msg);
    return 0;
  }

  let bugsText = '';
  try { bugsText = fs.readFileSync(path.join(REPO_ROOT, 'BUGS.md'), 'utf8'); }
  catch (err) {
    console.error('triage-incidents: cannot read BUGS.md: ' + err.message);
    return 2;
  }

  const incidents = parseIncidents(ledger.text);
  const untracked = findUntracked(incidents, bugsText);

  if (wantJson) {
    console.log(JSON.stringify({ vaultRoot, incidents: incidents.length, untracked }, null, 2));
    return (checkOnly && untracked.length) ? 1 : 0;
  }

  console.log('Incident ledger: ' + ledger.path);
  console.log('Recorded: ' + incidents.length + '   cited in BUGS.md: ' +
    (incidents.length - untracked.length) + '   untracked: ' + untracked.length);

  if (untracked.length) {
    console.log('');
    console.log('| Incident | Severity | Date | Report |');
    console.log('|---|---|---|---|');
    for (const inc of untracked) {
      console.log('| `' + inc.id + '` | ' + inc.severity + ' | ' + inc.date + ' | ' +
        inc.text.replace(/\|/g, '\\|').slice(0, 160) + ' |');
    }
    console.log('');
    console.log('Cite the id in a BUGS.md entry (or record why it needs none) to clear it.');
  }

  return (checkOnly && untracked.length) ? 1 : 0;
}

module.exports = { parseIncidents, findUntracked, resolveVaultRoot };

if (require.main === module) process.exit(main(process.argv.slice(2)));
