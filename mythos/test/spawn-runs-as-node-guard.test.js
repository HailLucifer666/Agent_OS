'use strict';

// test/spawn-runs-as-node-guard.test.js — audit item 9, Phase 4 (2026-08-22).
//
// THE RULE, and why it needs a guard rather than another individual test.
//
// `process.execPath` is not node. Inside the packaged app it is the Electron
// binary, and Electron behaves as a Node interpreter ONLY when
// ELECTRON_RUN_AS_NODE is set in the child's environment. Spawn it without that
// and you do not run your script — you launch a second copy of MYTHOS, which
// then sits there until something times out.
//
// This has now caused two separate bugs:
//
//   * the local web-search daemon (a second MYTHOS instead of the daemon), and
//   * BUG-301, the build engine — three real ten-minute build failures, found by
//     using the app rather than by any test, because under plain `node`
//     process.execPath IS node and the bug is unreachable.
//
// Each got its own regression test, each pinning its own call site. Nobody wrote
// the RULE down anywhere that would catch the third one. This file is the rule.
//
// WHAT COUNTS AS CORRECT. Not "sets the variable" — that would report a false
// alarm on the very first run, because two of the four real call sites are
// correct by INHERITANCE rather than by assignment:
//
//   * no `env` option at all      -> the child inherits the parent's whole
//                                    environment, flag included
//   * env: process.env            -> same, passed explicitly
//   * env: { ...process.env, … }  -> same, plus overrides
//   * env: someFunction(…)        -> correct if that function sets the flag;
//                                    dsh-agent's scrubbedEnv does, and it has to,
//                                    because it builds a FRESH allowlisted env
//                                    rather than copying process.env — which is
//                                    precisely how BUG-301 happened
//
// So the only shape this rejects is a constructed environment that neither
// derives from process.env nor sets the flag. That is the bug, exactly, and
// nothing wider.
//
// PROVEN BY BREAKING SOMETHING. A guard that has never gone red is not known to
// work — four of roughly twenty guards checked during this audit turned out to
// catch nothing. The flag was temporarily deleted from websearch-child.js and
// this file was confirmed to fail, naming that file and line, before being
// restored. The self-check at the bottom re-runs that proof on every run against
// a synthetic source, so the demonstration cannot rot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

// Everything that runs INSIDE the desktop app. mythos/scripts/ is deliberately
// out of scope and that is a decision, not an oversight: those are operator-run
// developer tools invoked with a real `node`, never spawned by Electron. The one
// script the app itself launches (vault-sync) is launched from electron/main.js,
// which IS scanned — so the call site that matters is covered where it lives.
const SCANNED_DIRS = [
  path.join(REPO, 'mythos', 'src'),
  path.join(REPO, 'mythos', 'adapters'),
  path.join(REPO, 'mythos', 'server'),
  path.join(REPO, 'electron'),
];

const SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// The call expression starting at the '(' after the spawner name, balanced so a
// nested object or a callback cannot truncate it. A line-count window would
// silently stop reading mid-options and call a missing flag "absent".
function callTextAt(src, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIndex, i + 1);
    }
  }
  return src.slice(openParenIndex);
}

// The value of the `env:` property, balanced the same way.
function envExpression(callText) {
  const m = /\benv\s*:/.exec(callText);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  const start = i;
  for (; i < callText.length; i++) {
    const ch = callText[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
  }
  return callText.slice(start, i);
}

function bodyOfFunction(src, name) {
  const decl = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = decl.exec(src);
  if (!m) return null;
  const brace = src.indexOf('{', m.index);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(brace, i + 1);
    }
  }
  return null;
}

// null when the site is fine; a reason string when it is not.
function violationAt(src, callText) {
  const env = envExpression(callText);
  // No env option: the child inherits the parent's environment wholesale.
  if (env === null) return null;
  if (/ELECTRON_RUN_AS_NODE/.test(env)) return null;
  if (/process\.env/.test(env)) return null;

  const call = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(env);
  if (call) {
    const body = bodyOfFunction(src, call[1]);
    if (body && /ELECTRON_RUN_AS_NODE/.test(body)) return null;
    if (body) {
      return 'env comes from ' + call[1] + '(), which builds an environment without '
        + 'ELECTRON_RUN_AS_NODE. That is BUG-301 exactly: a fresh allowlisted env drops it.';
    }
    return 'env comes from ' + call[1] + '(), which is not defined in this file, so this '
      + 'guard cannot tell whether the flag survives. Set it at the call site.';
  }

  // env is a plain identifier or member expression — the environment was built
  // somewhere else and handed in. dsh-agent's real shape: spawnDsh() takes
  // `spawnOpts` and does `env: spawnOpts.env`, while the object itself is built
  // by scrubbedEnv() in the same file, one call up.
  //
  // Following that across function boundaries statically is more machinery than
  // this is worth, so the check drops to FILE level here: the module that spawns
  // its own executable with a hand-built environment must set the flag
  // somewhere in its own code. Weaker than the object-literal case, and stated
  // as such rather than hidden — but it still catches the bug it exists for.
  // BUG-301's dsh-agent did not mention ELECTRON_RUN_AS_NODE anywhere in the
  // file, so this rule would have failed on it, which is the point.
  if (/^\s*[A-Za-z_$][\w$.]*\s*$/.test(env)) {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    if (/ELECTRON_RUN_AS_NODE/.test(code)) return null;
    return 'env is handed in as `' + env.trim() + '` and nothing in this file ever sets '
      + 'ELECTRON_RUN_AS_NODE, so whatever built that object almost certainly dropped it. '
      + 'This is the shape BUG-301 had.';
  }

  return 'env is a constructed object that neither derives from process.env nor sets '
    + 'ELECTRON_RUN_AS_NODE, so the child gets a second Electron app instead of a script.';
}

function findSites(src, file) {
  const sites = [];
  for (const fn of SPAWNERS) {
    const re = new RegExp('\\b' + fn + '\\s*\\(\\s*process\\.execPath', 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('(', m.index + fn.length - 1);
      const callText = callTextAt(src, open);
      sites.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        fn,
        callText,
      });
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------

test('every spawn of our own executable can actually run as node', () => {
  const violations = [];
  let siteCount = 0;

  for (const dir of SCANNED_DIRS) {
    for (const file of listJsFiles(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('process.execPath')) continue;
      for (const site of findSites(src, file)) {
        siteCount++;
        const why = violationAt(src, site.callText);
        if (why) {
          violations.push(path.relative(REPO, site.file) + ':' + site.line + ' — ' + why);
        }
      }
    }
  }

  // If this drops to zero the guard has stopped looking at anything — a scan
  // that finds nothing passes for the wrong reason, which is how a guard becomes
  // decoration.
  assert.ok(siteCount >= 4,
    'expected at least the four known spawn sites, found ' + siteCount
    + '. The scan is not reaching the code any more — check SCANNED_DIRS and SPAWNERS.');

  assert.deepEqual(violations, [],
    'a spawn of process.execPath cannot run as node:\n  ' + violations.join('\n  '));
});

test('the guard recognises each correct form, so it cannot cry wolf', () => {
  // The three shapes that are correct today. Two of the four real sites are
  // correct by inheritance; a guard that demanded an explicit assignment would
  // have failed on day one and been muted rather than trusted.
  const src = 'function scrubbedEnv() { var env = {}; env.ELECTRON_RUN_AS_NODE = "1"; return env; }';
  const ok = [
    'spawn(process.execPath, args, { windowsHide: true })',
    'spawn(process.execPath, args, { env: process.env })',
    "spawn(process.execPath, args, { env: { ...process.env, FOO: '1' } })",
    "spawn(process.execPath, args, { env: { ELECTRON_RUN_AS_NODE: '1' } })",
    'spawn(process.execPath, args, { env: scrubbedEnv({ apiKeyEnv: k }) })',
  ];
  for (const call of ok) {
    const site = findSites(src + '\n' + call, 'synthetic.js')[0];
    assert.ok(site, 'the scanner did not even find the call: ' + call);
    assert.equal(violationAt(src + '\n' + call, site.callText), null,
      'a correct form was reported as a violation: ' + call);
  }
});

test('the guard actually catches the two bugs it exists for — proven, not assumed', () => {
  // A guard that has never gone red is not known to work. These are the two real
  // shapes, reduced: a fresh env object with no flag (websearch-child's original
  // bug) and a builder that strips it (BUG-301's scrubbedEnv before the fix).
  const websearchBug =
    "spawn(process.execPath, args, { shell: false, stdio: 'ignore', env: { PATH: p } })";
  const site1 = findSites(websearchBug, 'synthetic.js')[0];
  const why1 = violationAt(websearchBug, site1.callText);
  assert.ok(why1, 'a constructed env with no flag was accepted — this guard catches nothing');
  assert.match(why1, /ELECTRON_RUN_AS_NODE/);

  const bug301Src = 'function scrubbedEnv() { var env = {}; env.DSH_HOME = h; return env; }\n'
    + 'spawn(process.execPath, args, { env: scrubbedEnv({ apiKeyEnv: k }) })';
  const site2 = findSites(bug301Src, 'synthetic.js')[0];
  const why2 = violationAt(bug301Src, site2.callText);
  assert.ok(why2, 'BUG-301 itself would pass this guard');
  assert.match(why2, /scrubbedEnv/);

  // And BUG-301's ACTUAL shape, which is the one that made this guard harder
  // than it looks: the spawn is in a helper that receives the env as a
  // parameter, and the object is built one call up.
  const indirect = 'function scrubbedEnv() { var env = {}; env.DSH_HOME = h; return env; }\n'
    + 'function spawnDsh(args, spawnOpts) {\n'
    + '  return spawn(process.execPath, args, { env: spawnOpts.env, windowsHide: true });\n'
    + '}';
  const site3 = findSites(indirect, 'synthetic.js')[0];
  const why3 = violationAt(indirect, site3.callText);
  assert.ok(why3, "the real BUG-301 shape — env handed in as a parameter — was accepted");
  assert.match(why3, /ELECTRON_RUN_AS_NODE/);

  // The same shape is accepted once the file sets the flag anywhere in its code,
  // which is what dsh-agent looks like today.
  const fixed = indirect.replace('env.DSH_HOME = h;', "env.DSH_HOME = h; env.ELECTRON_RUN_AS_NODE = '1';");
  assert.equal(violationAt(fixed, findSites(fixed, 'synthetic.js')[0].callText), null,
    'the fixed shape must be accepted, or the guard blocks the correct code');

  // A mention in a COMMENT must not satisfy it — this repo has already shipped
  // one shape guard that passed on prose.
  const commentOnly = indirect.replace('function spawnDsh',
    '// ELECTRON_RUN_AS_NODE is important\nfunction spawnDsh');
  assert.ok(violationAt(commentOnly, findSites(commentOnly, 'synthetic.js')[0].callText),
    'a comment mentioning the flag satisfied the guard; it must read executable lines only');
});

test('the options object is read whole, not by a line window', () => {
  // A window of N lines stops reading mid-options on a long call and reports the
  // flag as absent. dsh-agent's spawn options are separated from the call by a
  // long comment block, which is exactly the shape that breaks a naive scanner.
  const long = 'spawn(process.execPath, [\n'
    + Array.from({ length: 60 }, (_, i) => '  // filler line ' + i).join('\n')
    + "\n], {\n  env: { ...process.env },\n})";
  const site = findSites(long, 'synthetic.js')[0];
  assert.ok(/env:/.test(site.callText), 'the balanced scan did not reach the options object');
  assert.equal(violationAt(long, site.callText), null);
});
