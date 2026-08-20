#!/usr/bin/env node
'use strict';

// scripts/setup-websearch.js — installs the adopted local search daemon
// (open-webSearch, Apache-2.0) project-local, into <repo>/open-websearch/.
// effectors/websearch-child.js starts it from there; effectors/web-search.js
// asks it first, before any keyed provider.
//
// WHY IT EXISTS (2026-08-21). BUG-280 adopted the daemon and shipped the rung
// that talks to it, and left the install as two commented-out lines in
// .env.example. Measured a day later from the operator's audit vault: eight
// `web_search` calls, eight `ok`, every one of them answered by the chain's last
// rung — Wikipedia — because the daemon had never been installed on the machine
// that needed it. "Optional dependency" and "dependency nothing can install"
// look identical from the outside and are not the same thing.
//
// SAME CONVENTION AS setup-hermes.js: a third-party checkout, project-local and
// gitignored, installed on demand and never committed or redistributed in the
// installer. Never a global install — see the project-isolation rule in
// CLAUDE.md. The daemon is genuinely optional: with it absent the search rung
// records the refused connection and the chain carries on.
//
// LICENSING: open-webSearch is Apache-2.0 (LICENSE file in the published
// package). Note its package.json omits the `license` field, so tooling may
// report "unknown" — see THIRD_PARTY_NOTICES.md. This script installs it on the
// operator's machine from npm; nothing is vendored here.
//
// Usage:
//   node scripts/setup-websearch.js --install    # install (or update) the daemon
//   node scripts/setup-websearch.js --check      # report status, install nothing
//   node scripts/setup-websearch.js --serve      # run it in the foreground (debug)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE = 'open-websearch';
const MYTHOS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');
const HOME = path.join(REPO_ROOT, 'open-websearch');
const ENTRY = path.join(HOME, 'node_modules', PACKAGE, 'build', 'index.js');
const DEFAULT_PORT = 3100;

function installed() {
  try { return fs.statSync(ENTRY).isFile(); } catch (_) { return false; }
}

function installedVersion() {
  try {
    return require(path.join(HOME, 'node_modules', PACKAGE, 'package.json')).version || 'unknown';
  } catch (_) { return null; }
}

// npm is a batch script on Windows, which Node will only execute through a shell.
// Passing an args ARRAY together with shell:true is what raises DEP0190 — the args
// are concatenated rather than escaped — so the Windows branch builds the fixed
// command as one string instead. Nothing operator-supplied reaches it: PACKAGE is a
// module constant and cwd is passed out-of-band rather than interpolated.
function npm(args, cwd) {
  if (process.platform === 'win32') {
    return spawnSync('npm.cmd ' + args.join(' '), { cwd, stdio: 'inherit', shell: true });
  }
  return spawnSync('npm', args, { cwd, stdio: 'inherit' });
}

function install() {
  fs.mkdirSync(HOME, { recursive: true });

  // A bare directory with no package.json makes npm walk UP and install into the
  // repo root instead — which would put a third-party dependency into MYTHOS's
  // own tree. Private + no name so it can never be published by accident.
  const manifest = path.join(HOME, 'package.json');
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, JSON.stringify({
      name: 'mythos-websearch-host',
      private: true,
      description: 'Project-local host for the open-webSearch daemon. Created by mythos/scripts/setup-websearch.js — not part of MYTHOS.',
    }, null, 2) + '\n');
  }

  console.log('Installing ' + PACKAGE + ' into ' + HOME + ' ...');
  const r = npm(['install', PACKAGE, '--no-audit', '--no-fund'], HOME);
  if (r.status !== 0) {
    console.error('\nnpm install failed (exit ' + r.status + ').');
    console.error('Search will keep working through the other providers — badly. Retry, or set EXA_API_KEY.');
    process.exit(1);
  }

  if (!installed()) {
    console.error('\nnpm reported success but ' + ENTRY + ' is missing.');
    console.error('Refusing to report an install that did not produce a runnable daemon.');
    process.exit(1);
  }

  console.log('\nInstalled ' + PACKAGE + ' ' + installedVersion() + '.');
  console.log('MYTHOS starts it automatically on boot (websearch.started in the log).');
  console.log('Set WEB_SEARCH_LOCAL_AUTOSTART=false to manage it yourself.');
}

// Foreground run, for diagnosing an install that boots but does not answer.
// `serve` is the load-bearing argument: without it the entrypoint starts the MCP
// server on the same port and answers POST /search with a 404 page.
function serve(port) {
  if (!installed()) {
    console.error('Not installed. Run: node mythos/scripts/setup-websearch.js --install');
    process.exit(1);
  }
  console.log('Running ' + PACKAGE + ' ' + installedVersion() + ' on 127.0.0.1:' + port + ' (Ctrl-C to stop)');
  const r = spawnSync(process.execPath, [ENTRY, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(r.status === null ? 0 : r.status);
}

function check() {
  if (!installed()) {
    console.log('open-webSearch: NOT INSTALLED');
    console.log('  expected at: ' + ENTRY);
    console.log('  install with: node mythos/scripts/setup-websearch.js --install');
    console.log('  without it, web_search falls through to the keyed providers and finally Wikipedia');
    return 1;
  }
  console.log('open-webSearch: installed (' + installedVersion() + ')');
  console.log('  entry: ' + ENTRY);
  return 0;
}

function portFromEnv() {
  const raw = String(process.env.WEB_SEARCH_LOCAL_URL || '').trim();
  if (!raw) return DEFAULT_PORT;
  try {
    const port = Number(new URL(raw).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  } catch (_) { return DEFAULT_PORT; }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) process.exit(check());
  if (argv.includes('--serve')) return serve(portFromEnv());
  if (argv.includes('--install') || argv.length === 0) return install();
  console.error('Usage: node scripts/setup-websearch.js [--install | --check | --serve]');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { HOME, ENTRY, DEFAULT_PORT, installed, installedVersion, _portFromEnv: portFromEnv };
