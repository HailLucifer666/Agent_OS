'use strict';

// BUG-301 (found live 2026-08-22, in the real desktop app — never by the suite).
//
// `dsh-agent` spawns the build engine with `process.execPath`. Inside MYTHOS's
// server that path is `electron.exe`, not `node`, because the server runs under
// Electron. Electron acts as a Node interpreter ONLY when ELECTRON_RUN_AS_NODE
// is set, and scrubbedEnv() deliberately builds a fresh allowlisted env instead
// of copying process.env — which stripped exactly that variable. dsh's bin.js
// was therefore handed to Electron as an APP: it threw during load, never
// emitted a terminal turn, and the adapter waited its full 600s task timeout.
// Three consecutive real builds died that way in one session, each after ten
// minutes, and every one of them reported the engine as ONLINE.
//
// WHY NOTHING CAUGHT IT, which is the reason this file exists at all: under
// plain `node` — this suite, verify-dsh-build.js's 5/5 stages, the dsh-vs-Hermes
// spike — `process.execPath` IS node and the bug is unreachable. It lives only
// on the path a user takes. The probe is no help either: `bin.js --version`
// printed the pinned version and matched even under Electron, so the adapter
// reported ONLINE with evidence "version-printed-and-matched-pin" while no build
// could succeed.
//
// Measured under electron.exe 43.3.0 with ELECTRON_RUN_AS_NODE=1:
//   no fix            -> killed at 600000ms
//   env fix only      -> honest failure in 1858ms (the HMR error below)
//   env + flag        -> 5058ms, same as plain node

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../adapters/dsh-agent');
const ADAPTER_SRC = path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js');

test('BUG-301 — scrubbedEnv forwards ELECTRON_RUN_AS_NODE so execPath behaves as node', () => {
  const env = adapter.scrubbedEnv({});
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1',
    'without this the engine spawned from the Electron-hosted server is Electron itself, '
    + 'which loads dsh as an app, hangs, and is killed after the full task timeout');
});

test('BUG-301 — it is SET by MYTHOS, not inherited: a parent value cannot turn it off', () => {
  // The allowlist is the whole point — it must not become a passthrough for this
  // key either. A parent that had it unset (a plain `node` host) or explicitly
  // disabled must still produce a child that runs as node.
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  try {
    process.env.ELECTRON_RUN_AS_NODE = '0';
    assert.equal(adapter.scrubbedEnv({}).ELECTRON_RUN_AS_NODE, '1', 'a parent 0 must not win');
    delete process.env.ELECTRON_RUN_AS_NODE;
    assert.equal(adapter.scrubbedEnv({}).ELECTRON_RUN_AS_NODE, '1', 'an absent parent value must not leave it unset');
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
  }
});

test('BUG-301 — the spawn passes --expose-internals ahead of the script', () => {
  // dsh's own plugin graph loads @deepseek-ai/cordis-plugin-hmr, which refuses
  // to initialise without it: "failed to apply loader entry ... --expose-internals
  // is required for HMR service". Under plain node dsh arranges this itself;
  // under Electron-as-node it does not, so the adapter passes it explicitly.
  //
  // This is a source assertion because the alternative cannot give real
  // coverage: driving a genuine spawn needs BOTH electron and a project-local
  // dsh install, and CI has no dsh — the test would skip there and this repo has
  // already been bitten by guards that only ever skip. The window is kept wide
  // (one line, two substrings, no exact spacing) so ordinary edits do not
  // break it while a DROPPED flag still does.
  const src = fs.readFileSync(ADAPTER_SRC, 'utf8');
  const spawnLine = src.split(/\r?\n/).find(l => l.includes('spawn(process.execPath'));
  assert.ok(spawnLine, 'the spawn call moved — re-point this assertion rather than deleting it');
  assert.ok(spawnLine.includes('--expose-internals'),
    'the interpreter flag must be prepended to the args, or dsh dies on the HMR loader entry '
    + 'whenever the host is Electron');
});

test('BUG-301 — the permission mode still decides writes, so the flag widens nothing', () => {
  // --expose-internals makes node internals visible; it must not be mistaken for
  // a sandbox change. Pin that the two are independent.
  assert.equal(adapter.scrubbedEnv({}).DSH_PERMISSION_MODE, 'read-only');
  assert.equal(adapter.scrubbedEnv({ autoApprove: true }).DSH_PERMISSION_MODE, 'workspace-write');
});

// ---------------------------------------------------------------------------
// Audit item 3, Phase 3 (2026-08-22): the case this file was missing.
//
// Everything above pins what scrubbedEnv DECIDES. Nothing pinned that the
// decision survives to the caller — and it did not. The last line of the
// function was:
//
//     return Object.assign(env, opts.extra || {});
//
// Later keys win in Object.assign, so anything the caller passed overwrote every
// setting the function had just deliberately chosen. MEASURED before the fix,
// with autoApprove:false and a hostile extra:
//
//     DSH_PERMISSION_MODE    = "workspace-write"   (asked for read-only)
//     ELECTRON_RUN_AS_NODE   = ""                  (BUG-301, reintroduced)
//     DSH_TELEMETRY_DISABLED = ""                  (the privacy opt-out, off)
//
// Three settings, including the one this whole file exists to protect.
//
// THE FIX IS DELETION, NOT DEFENCE. The option had no callers: a search across
// src/ and adapters/ found exactly one mention, the forwarding line inside
// runTask that fed it (extra: opts.env || null), and no runTask caller passed
// env — build-engine, forge-runner and from-dsh all express intent structurally
// (cwd, writeRoot, autoApprove) rather than by naming another program's
// variables. An unused option that can switch off a sandbox is surface to
// remove, not a hole to guard.
//
// If a real need for it appears, the merge goes ABOVE the decided settings so
// they still win, and the reason goes in a comment. It does not come back below
// them.

test('audit item 3 — a caller cannot override the settings scrubbedEnv decides', () => {
  const forced = adapter.scrubbedEnv({
    autoApprove: false,
    extra: {
      DSH_PERMISSION_MODE: 'workspace-write',
      ELECTRON_RUN_AS_NODE: '',
      DSH_TELEMETRY_DISABLED: '',
    },
  });
  assert.equal(forced.DSH_PERMISSION_MODE, 'read-only',
    'a caller asked for the read-only sandbox and got workspace-write. The permission mode is '
    + "MYTHOS's call — that is why it is SET rather than inherited");
  assert.equal(forced.ELECTRON_RUN_AS_NODE, '1',
    'BUG-301 straight back: with this blank the engine spawned from the Electron-hosted '
    + 'server is Electron itself, and every build dies at the task timeout');
  assert.equal(forced.DSH_TELEMETRY_DISABLED, '1',
    "dsh's shipped bundle has no redaction rule, so an enabled export can carry message text, "
    + 'tool arguments and workspace paths');
});

test('audit item 3 — the unused escape hatch is gone from the source, not merely outranked', () => {
  // Behaviour above proves the settings survive TODAY. This proves the mechanism
  // is absent, because "the merge happens earlier now" is one careless reorder
  // away from being wrong again, and the option has no callers to justify it.
  const code = fs.readFileSync(ADAPTER_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.ok(!/opts\.extra/.test(code),
    'opts.extra is back in scrubbedEnv. It had no callers and it could switch off the sandbox');
  assert.ok(!/extra\s*:\s*opts\.env/.test(code),
    'runTask is forwarding opts.env into scrubbedEnv again — that was the only feeder');
});
