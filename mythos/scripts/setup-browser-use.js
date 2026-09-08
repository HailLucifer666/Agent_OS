#!/usr/bin/env node
'use strict';
// setup-browser-use.js — install or check the browser-use runner environment.
//
//   --check (default)  report home, python, installed version, and whether it equals the pin.
//   --install          create <home>/.venv with uv (Python 3.11 series) and install the
//                      PINNED browser-use version into it. Never `curl | bash`; never latest.
//
// browser-use (github.com/browser-use/browser-use, MIT) is the browser agent behind the
// `browser_task` tool: MYTHOS hands it a plain-English task and it drives the debug
// browser over CDP, observing and re-observing until done. It is Python, so it lives in
// its own venv beside the repo (or under MYTHOS_TOOLS_DIR in the packaged app), the same
// vendor-root rule DeepSeek Harness follows. Requires `uv` on PATH (https://docs.astral.sh/uv/).
//
// The customer brings their own model key (GOOGLE_API_KEY by default). Nothing here
// touches keys; see mythos/.env.example for BROWSER_USE_MODEL.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const loc = require('../src/core/browser-use-location');

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? cmd + ' is not on PATH' : r.error.message };
  return { ok: r.status === 0, code: r.status };
}

function check() {
  const found = loc.findInstalled();
  console.log('browser-use runner environment');
  console.log('  home      ' + found.home);
  console.log('  python    ' + found.python + (fs.existsSync(found.python) ? '' : '  (missing)'));
  console.log('  pinned    ' + loc.BROWSER_USE_PINNED_VERSION);
  console.log('  installed ' + (found.version || 'none'));
  if (!found.ok) { console.log('  ' + found.reason); return 1; }
  console.log('  ok: pinned version installed');
  return 0;
}

function install() {
  const home = loc.resolveBrowserUseHome();
  const venv = loc.venvDir(home);
  fs.mkdirSync(home, { recursive: true });
  console.log('installing browser-use==' + loc.BROWSER_USE_PINNED_VERSION + ' into ' + venv);
  const uvCheck = run('uv', ['--version'], { stdio: 'pipe' });
  if (!uvCheck.ok) { console.log('uv is required (' + (uvCheck.error || 'exit ' + uvCheck.code) + '). Install it from https://docs.astral.sh/uv/ and re-run.'); return 1; }
  if (!fs.existsSync(loc.pythonPath(home))) {
    const v = run('uv', ['venv', venv, '--python', loc.PYTHON_SERIES]);
    if (!v.ok) { console.log('uv venv failed (' + (v.error || 'exit ' + v.code) + ').'); return 1; }
  }
  const p = run('uv', ['pip', 'install', '--python', loc.pythonPath(home), 'browser-use==' + loc.BROWSER_USE_PINNED_VERSION]);
  if (!p.ok) { console.log('uv pip install failed (' + (p.error || 'exit ' + p.code) + ').'); return 1; }
  console.log('');
  return check();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  process.exitCode = args.includes('--install') ? install() : check();
}

module.exports = { check, install };
