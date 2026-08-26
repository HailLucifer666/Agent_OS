#!/usr/bin/env node
'use strict';

// scripts/verify-packaged.js — drive every feature area against a MYTHOS that is
// ALREADY RUNNING, and print one ranked table.
//
// WHY. The operator now runs the installed MYTHOS.exe exclusively, so every fix
// reaches them only through a release. Meanwhile all 34 scripts/verify-*.js
// harnesses call verify-lib's bootMythos(), which spawns a fresh DEV-TREE
// process — none of them has ever touched the packaged application. BUG-360 is
// what that gap costs: an installer shipped in which all 14 phone_* tools were
// absent from the model's capability list, and every check in the repo passed.
//
// WHAT IT DOES. Attaches (never boots — see verify-lib's attachMythos for why),
// runs parity-check's own assertions, then invokes ONE representative tool per
// feature area through the test hatch and reports what each actually returned.
//
// Usage:
//   MYTHOS_TEST_HATCH=1  on the SERVER being tested, then here:
//   node scripts/verify-packaged.js --attach 4478 --token <MYTHOS_AUTH_TOKEN>
//   node scripts/verify-packaged.js --attach 4478 --token <t> --no-network
//   node scripts/verify-packaged.js --attach 4478 --token <t> --json
//
// ── THE PROBE RULES, and why the list looks conservative ─────────────────────
//
// EVERY probe is Tier 0 and read-only. Not caution for its own sake: this runs
// against the operator's REAL install, with their real vault, their real
// desktop and their real phone. A sweep that typed, clicked, sent or deleted
// would be a worse problem than the one it detects. T3/T4 tools are excluded by
// construction — the hatch refuses them with requireConfirm rather than
// auto-approving (server/test-hatch.js, lock 3), so including one would only
// produce a guaranteed red row that teaches nothing.
//
// A FAILING PROBE IS NOT AUTOMATICALLY A BUG, and the table says which is which.
// browser_get_title is expected to fail while the debug browser is not running;
// phone_list_devices legitimately returns an empty list with no handset paired.
// The failure that MATTERS is a tool the server does not offer at all — that is
// the BUG-360 shape, where an adapter is down and its tools are withheld, so the
// model is told the tool does not exist rather than that it failed.

const path = require('path');
const {
  openMythos, parseHarnessTarget, openToolSession,
} = require(path.join(__dirname, 'verify-lib.js'));
const parity = require(path.join(__dirname, 'parity-check.js'));

// area          — the feature the operator would name
// tool/args     — a Tier-0, read-only probe for it
// network       — needs the internet, so --no-network skips it rather than
//                 reporting someone's captive portal as a MYTHOS defect
// expectOffline — a known degraded mode on a machine like this one; reported as
//                 DEGRADED, never as a failure, because a check that is red for
//                 an expected reason is a check people learn to ignore
const PROBES = [
  { area: 'server',          tool: 'read_status',        args: {} },
  { area: 'system metrics',  tool: 'read_system_specs',  args: {} },
  { area: 'system health',   tool: 'system_status',      args: {} },
  { area: 'self-knowledge',  tool: 'self_capabilities',  args: {} },
  { area: 'persona',         tool: 'persona_status',     args: {} },
  { area: 'time',            tool: 'get_time',           args: {} },

  { area: 'desktop windows', tool: 'list_windows',       args: {} },
  { area: 'desktop (cua)',   tool: 'cua_list_windows',   args: {} },
  { area: 'clipboard',       tool: 'clipboard_read',     args: {} },
  { area: 'volume',          tool: 'get_volume',         args: {} },
  { area: 'media',           tool: 'media_status',       args: {} },

  { area: 'phone bridge',    tool: 'phone_list_devices', args: {} },
  { area: 'whatsapp',        tool: 'whatsapp_contacts',  args: {} },

  { area: 'browser',         tool: 'browser_get_title',  args: {}, expectOffline: true,
    why: 'the debug browser is only up after browser_launch_debug' },

  { area: 'files',           tool: 'list_folder',        args: { path: '.' } },
  // {root, pattern} — NOT {path, query}. The first draft guessed, and the guess
  // was reported as a PASS whose own note read "A path is required." Probe args
  // are copied from the effector's registered `params`, never invented.
  { area: 'file search',     tool: 'search_files',       args: { root: '.', pattern: 'package.json' } },
  { area: 'documents',       tool: 'document_list',      args: {} },

  { area: 'memory',          tool: 'recall_memory',      args: { query: 'operator' } },
  { area: 'notes',           tool: 'note_search',        args: { query: 'a' } },
  { area: 'incidents',       tool: 'list_incidents',     args: {} },
  { area: 'reminders',       tool: 'reminder_list',      args: {} },

  { area: 'goals',           tool: 'list_goals',         args: {} },
  { area: 'kanban',          tool: 'kanban_status',      args: {} },
  { area: 'pipeline',        tool: 'pipeline_status',    args: {} },
  { area: 'mission',         tool: 'mission_status',     args: {} },
  { area: 'projects',        tool: 'project_status',     args: {} },

  { area: 'mcp',             tool: 'mcp_list_servers',   args: {} },

  { area: 'web search',      tool: 'web_search',         args: { query: 'mythos test probe' }, network: true },
  { area: 'weather',         tool: 'get_weather',        args: {}, network: true },
];

const PASS = 'PASS';
const DEGRADED = 'DEGRADED';
const FAIL = 'FAIL';
const WITHHELD = 'WITHHELD';

// A tool the server does not offer AT ALL is the BUG-360 shape and gets its own
// verdict, because it is a categorically different problem from a tool that ran
// and failed. Matched on the dispatch layer's own words for an unknown tool.
function looksWithheld(res) {
  const text = String((res && (res.error || res.refused)) || '');
  return /unknown tool|no such tool|not registered|unavailable|not found in (the )?registry/i.test(text);
}

function classify(probe, res) {
  if (res && res.hatchDisabled) return { verdict: FAIL, note: res.error };
  if (res && res.ok) return { verdict: PASS, note: summarize(res.result) };
  if (looksWithheld(res)) {
    return { verdict: WITHHELD, note: (res && res.error) || 'the server does not offer this tool' };
  }
  if (probe.expectOffline) {
    return { verdict: DEGRADED, note: ((res && res.error) || 'offline') + (probe.why ? ' — ' + probe.why : '') };
  }
  if (res && res.requireConfirm) {
    return { verdict: FAIL, note: 'unexpectedly needs a confirm (tier ' + res.tier + ') — a probe must be Tier 0' };
  }
  return { verdict: FAIL, note: (res && res.error) || 'no result' };
}

// One short line per result. The full payload is available with --json; a table
// that wraps is a table nobody reads.
function summarize(result) {
  if (result === undefined || result === null) return 'ok';
  const inner = result && typeof result === 'object' && 'result' in result ? result.result : result;
  if (inner === undefined || inner === null) return 'ok';
  if (typeof inner === 'string') return inner.slice(0, 70).replace(/\s+/g, ' ');
  if (Array.isArray(inner)) return `${inner.length} item(s)`;
  if (typeof inner === 'object') {
    const keys = Object.keys(inner);
    const counted = keys
      .filter((k) => Array.isArray(inner[k]))
      .map((k) => `${k}: ${inner[k].length}`);
    return (counted.length ? counted : keys.slice(0, 4)).join(', ').slice(0, 70) || 'ok';
  }
  return String(inner).slice(0, 70);
}

async function main() {
  const argv = process.argv.slice(2);
  const target = parseHarnessTarget(argv, process.env);
  const asJson = argv.includes('--json');
  const skipNetwork = argv.includes('--no-network');

  if (!target.attach) {
    // Refusing rather than defaulting to a boot. The point of this script is the
    // running install; silently booting a dev copy would produce a green table
    // that says nothing about the .exe, which is the exact failure mode it exists
    // to end.
    console.error('verify-packaged: pass --attach [port] — this harness tests a RUNNING MYTHOS.');
    console.error('  start the app, then: node scripts/verify-packaged.js --attach 4478 --token <MYTHOS_AUTH_TOKEN>');
    console.error('  the server must have been started with MYTHOS_TEST_HATCH=1');
    process.exitCode = 2;
    return;
  }

  const handle = await openMythos(target);

  // ---- parity first: config, vault, adapters, components ----------------------
  const parityChecks = await parity.runChecks({ host: '127.0.0.1', port: handle.port, token: handle.token, json: false });
  const parityFailed = parityChecks.filter((c) => c.ok === false);

  // ---- then one tool per feature area -----------------------------------------
  // ONE socket for the whole sweep, not one per probe. The /ws upgrade is rate
  // limited by a token bucket, and opening a fresh socket per tool starts
  // failing with `Unexpected server response: 429` at around the fourth — which
  // presents as the TOOL being rejected rather than the connection rate, so a
  // per-socket sweep would print reds that go green on a re-run. A harness that
  // teaches the reader to re-run reds is worse than no harness.
  const session = openToolSession(handle.port, { token: handle.token, timeoutMs: 30000 });
  try {
    await session.ready;
  } catch (err) {
    console.error('verify-packaged: could not open a tool session — ' + err.message);
    process.exitCode = 2;
    return;
  }

  const rows = [];
  for (const probe of PROBES) {
    if (probe.network && skipNetwork) {
      rows.push({ area: probe.area, tool: probe.tool, verdict: 'SKIPPED', note: '--no-network' });
      continue;
    }
    let res;
    try {
      res = await session.call(probe.tool, probe.args);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    const { verdict, note } = classify(probe, res);
    rows.push({ area: probe.area, tool: probe.tool, verdict, note });

    // A disabled hatch makes every remaining row identical and meaningless.
    // Stop and say so rather than printing 30 copies of the same mistake.
    if (res && res.hatchDisabled) {
      console.error('\nverify-packaged: the server is not running with MYTHOS_TEST_HATCH=1 — nothing below this point was executed.\n');
      break;
    }
  }
  session.close();

  const withheld = rows.filter((r) => r.verdict === WITHHELD);
  const failed = rows.filter((r) => r.verdict === FAIL);

  if (asJson) {
    console.log(JSON.stringify({
      ok: failed.length === 0 && withheld.length === 0 && parityFailed.length === 0,
      port: handle.port, parity: parityChecks, probes: rows,
    }, null, 2));
  } else {
    console.log('\nMYTHOS packaged-app verification');
    console.log('=================================');
    console.log(`attached to 127.0.0.1:${handle.port}\n`);

    console.log('PARITY');
    for (const c of parityChecks) {
      const mark = c.ok === true ? ' ok ' : c.ok === false ? 'FAIL' : ' ?? ';
      console.log(`  [${mark}] ${c.name}${c.detail ? '  —  ' + c.detail : ''}`);
    }

    console.log('\nFEATURE AREAS');
    const width = Math.max(...rows.map((r) => r.area.length));
    // Worst first. A table sorted by severity is a deliverable; one in
    // declaration order is a log, and the operator has to read all of it.
    const rank = { [WITHHELD]: 0, [FAIL]: 1, [DEGRADED]: 2, SKIPPED: 3, [PASS]: 4 };
    for (const r of rows.slice().sort((a, b) => rank[a.verdict] - rank[b.verdict])) {
      console.log(`  [${r.verdict.padEnd(8)}] ${r.area.padEnd(width)}  ${r.tool.padEnd(20)} ${r.note}`);
    }

    console.log('');
    if (withheld.length) {
      console.log(`WITHHELD (${withheld.length}): ${withheld.map((r) => r.tool).join(', ')}`);
      console.log('  These tools are not offered by this install at all. That is the BUG-360 shape:');
      console.log('  an adapter is down, its tools are withheld, and the model is told they do not');
      console.log('  exist rather than that they failed. Check the adapter rows in PARITY above.');
    }
    if (failed.length) console.log(`FAILED (${failed.length}): ${failed.map((r) => r.tool).join(', ')}`);
    if (parityFailed.length) console.log(`PARITY FAILED (${parityFailed.length}): ${parityFailed.map((c) => c.name).join(', ')}`);
    if (!withheld.length && !failed.length && !parityFailed.length) console.log('Every probe and parity check passed.');
  }

  process.exitCode = (failed.length || withheld.length || parityFailed.length) ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('verify-packaged failed to run:', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = { PROBES, classify, summarize, looksWithheld, PASS, FAIL, DEGRADED, WITHHELD };
