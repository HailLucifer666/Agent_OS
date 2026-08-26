#!/usr/bin/env node
'use strict';

/**
 * sync-test-count.js — single source of truth for "how many tests pass right now."
 *
 * README.md, ROADMAP.md and CLAUDE.md have each independently drifted to a
 * different stale test count (README alone disagreed with itself: 402 in the
 * prose, 568 in the badge). This script runs the real suite once and keeps a
 * fixed set of "current total" mentions honest — it never touches the
 * historical per-phase tables (those are journal entries, not live counts).
 *
 * Usage:
 *   node scripts/sync-test-count.js --check   # exit 1 if any tracked number is stale
 *   node scripts/sync-test-count.js --write   # rewrite tracked files to match the real run
 *
 * Both modes accept the suite's TAP output on stdin (so a caller that already
 * ran the suite for its own pass/fail gate doesn't have to run it twice —
 * see .githooks/pre-commit and .github/workflows/ci.yml). With no piped
 * input (a TTY, or empty stdin) it runs the suite itself.
 *
 * Zero dependencies — node:child_process, node:fs, node:path only.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const ROADMAP_FILE = path.join(REPO_ROOT, 'ROADMAP.md');

function runSuite() {
  // BUG (found 2026-07-30): this used to glob only test/*.test.js directly —
  // a shallow, non-recursive listing that silently missed every file one
  // level deeper (test/assistant/*.test.js, test/engagements/*.test.js — 14
  // files / ~188 tests). node's own recursive discovery (no path args at
  // all, matching what a bare `node --test` from mythos/ does) is what
  // actually finds all 154 files, so hand it nothing and let it walk the
  // tree itself instead of re-deriving the file list.
  console.log('sync-test-count: running full suite via recursive `node --test` (this takes ~40-90s)...');
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap'],
    { cwd: MYTHOS_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.resume();
  });
}

function getSuiteOutput() {
  if (process.argv.includes('--no-stdin') || process.argv.includes('--run') || process.env.SYNC_TEST_COUNT_NO_STDIN === '1') {
    return Promise.resolve(runSuite());
  }
  if (!process.stdin.isTTY) {
    return readStdin().then((piped) => {
      if (piped.trim()) return piped;
      return runSuite();
    });
  }
  return Promise.resolve(runSuite());
}

function parseCounts(out) {
  const field = (name) => {
    const m = out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    if (!m) {
      throw new Error(
        `sync-test-count: couldn't find "# ${name} N" in suite output — ` +
        `did the reporter change? (expected --test-reporter=tap TAP summary lines)`,
      );
    }
    return parseInt(m[1], 10);
  };
  return {
    tests: field('tests'),
    pass: field('pass'),
    fail: field('fail'),
    skipped: field('skipped'),
  };
}

// AD-10 (V2 spine §1): "test count, tool count, provider count, sensor count in
// README/CLAUDE.md are generated, never hand-typed." These four compute functions
// are that generator — each reads reality (package.json, a directory, or the actual
// effector registration surface) instead of trusting a number someone typed once.

function computeDepsCount() {
  const pkg = JSON.parse(fs.readFileSync(path.join(MYTHOS_ROOT, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies || {}).length;
}

function computeSensorCount() {
  const dir = path.join(MYTHOS_ROOT, 'src/core/sensors');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length;
}

function computeProviderCount() {
  const dir = path.join(MYTHOS_ROOT, 'providers');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length;
}

// A tool-safe inert stand-in for whatever ctx a buildTools()/createXEffector()
// factory asks for. Every property access and every call just returns itself,
// so `ctx.config.SOME_FLAG`, `ctx.fs.writeText(...)`, `ctx.bus.emit(...)` etc.
// all resolve without throwing — factories only need ctx to *construct* their
// tool-definition objects (closures over it), never to execute logic at
// definition time, so a real vault/bus/brain is never required just to ask
// "how many tools does this file define."
// BUG-352 (2026-08-27): returning undefined for Symbol.toPrimitive made this
// ctx un-coercible, so any factory that put a ctx-derived value in a template
// literal or a string concat threw "Cannot convert object to primitive value"
// — and the bare catch below turned that into a silent zero. from-dashboard.js
// coerces, so all 28 of its tools (open_web, camera_look, the goals and kanban
// verbs) were missing from every count this script has ever printed. It must
// stay non-thenable and non-iterable — an await or a spread on it would change
// what the factory does rather than just what it prints — but coercing to a
// marker string is harmless and is what a factory building a description needs.
// One line does it, not two: a `toString` branch would fix the same coercion,
// and the first draft of this fix carried both until a mutation run showed the
// test could not tell them apart — either alone yields all 28 tools. Kept the
// Symbol.toPrimitive arm because it is the protocol consulted first and it
// covers numeric coercion as well; the toString arm was dead surface.
function createInertCtx() {
  const noop = function () { return handle; };
  const handle = new Proxy(noop, {
    get(_target, prop) {
      if (prop === 'then' || prop === Symbol.iterator) return undefined;
      if (prop === Symbol.toPrimitive) return () => '[inert-ctx]';
      return handle;
    },
    apply() { return handle; },
  });
  return handle;
}

// Counts the real "how many tools does main.js end up registering on the hub"
// number without booting the app (no server, no adapters, no vault writes) —
// see AD-3 (declarations derive from the hub) and AD-9 (optional binaries never
// gate boot). Walks every file in src/core/effectors/ and, per file, tries in
// order: (1) a static TOOLS array export, (2) a build*Tools(ctx) factory whose
// return value (or return value's .TOOLS) is an array, (3) a create*(ctx)
// factory whose result matches hub.register()'s own shape check exactly
// ({id: string, invoke: function}) — kept so a future directly-registered
// effector is counted on the same contract hub.js enforces rather than needing
// a special case. Nothing uses shape (3) today: voice.js's `speak` effector was
// its only user and was removed 2026-07-31 as unreachable dead code (it had no
// describeMeta(), so it never appeared in any catalog the model sees).
function computeEffectorTools(dir = path.join(MYTHOS_ROOT, 'src/core/effectors')) {
  const ctx = createInertCtx();
  let total = 0;
  const perFile = {};
  const unreadable = [];
  const idsOf = (tools) => tools.map((tool) => (tool && (tool.name || tool.id)) || '(unnamed)');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      // A SyntaxError means the file does not PARSE. Swallowing that made the
      // effector count quietly drop by however many tools the file declared,
      // and the gate then compared docs against the smaller number and passed
      // — a broken effector shipping behind a green commit hook. Anything
      // else (a module that needs real deps at load time) stays tolerated,
      // but is now announced instead of vanishing: as of 2026-08-19 every
      // file in this directory requires cleanly, so any line here is news.
      if (err instanceof SyntaxError) {
        throw new Error('sync-test-count: ' + file + ' does not parse — ' + err.message
          + '. Refusing to report an effector count that silently excludes it.');
      }
      console.warn('sync-test-count: ' + file + ' is not requirable in isolation ('
        + (err.code || err.message) + ') — counted as 0 tools');
      unreadable.push({ file, reason: err.code || err.message });
      continue;
    }
    if (Array.isArray(mod.TOOLS)) {
      total += mod.TOOLS.length;
      perFile[file] = idsOf(mod.TOOLS);
      continue;
    }
    // A `build*Tools` export exists for exactly one purpose: to declare tools.
    // So when one cannot be counted, that is news, not a shrug. Both arms below
    // used to `catch {}` into a silent zero, which is how a 32-tool gap between
    // this script and the capabilities manifest (147 vs 179) survived long
    // enough to be written into the README. The guard is deliberately narrow —
    // the `create*` probe further down stays tolerant, because most `create*`
    // exports in this directory are helpers that legitimately refuse an inert
    // ctx and were never tool factories.
    const buildFn = Object.keys(mod).find((k) => /^build.*Tools$/i.test(k) && typeof mod[k] === 'function');
    if (buildFn) {
      let result;
      try {
        result = mod[buildFn](ctx);
      } catch (err) {
        throw new Error('sync-test-count: ' + file + ' exports ' + buildFn + '() but it threw — '
          + err.message + '. Refusing to report a tool count that silently excludes it.');
      }
      // from-mcp.js and from-strix.js return { tools: [...] } — the same key
      // their own registerFrom* functions read — while from-dashboard.js and
      // others return { TOOLS: [...] }. Only the uppercase spelling was
      // recognised, so the MCP bridge's 3 tools and security_scan were dropped.
      if (!Array.isArray(result) && result && typeof result === 'object') {
        if (Array.isArray(result.TOOLS)) result = result.TOOLS;
        else if (Array.isArray(result.tools)) result = result.tools;
      }
      if (!Array.isArray(result)) {
        throw new Error('sync-test-count: ' + file + ' exports ' + buildFn + '() but it returned no tool array '
          + '(neither an array, nor .TOOLS, nor .tools). Refusing to report a tool count that silently excludes it.');
      }
      total += result.length;
      perFile[file] = idsOf(result);
      continue;
    }
    const createFn = Object.keys(mod).find((k) => /^create/.test(k) && typeof mod[k] === 'function');
    if (createFn) {
      try {
        const result = mod[createFn]({ config: ctx });
        if (result && typeof result === 'object' && typeof result.id === 'string' && typeof result.invoke === 'function') {
          total += 1;
          perFile[file] = [result.id];
        }
      } catch { /* not a single-tool effector factory (e.g. needs a real vault) — skip */ }
    }
  }
  return { total, perFile, unreadable };
}

function computeEffectorCount(dir) {
  return computeEffectorTools(dir).total;
}

// Each slot is anchored on stable surrounding text (not a line number) so it
// survives unrelated edits to the same file. Historical per-phase tables
// (README's Build History table, ROADMAP's Commit Log) are deliberately not
// slots here — rewriting them would falsify what a past phase actually shipped.
function readmeSlots(counts) {
  const file = path.join(REPO_ROOT, 'README.md');
  return [
    { file, pattern: /(immune system, and )(\d+)( tests\.)/, value: counts.tests },
    // The README "tests" badge carries the PASS count — and pass is the one
    // number that legitimately varies BY MACHINE: honest fixture-skips (BYO
    // edge-tts .venv, per-machine model weights — see their t.skip guards)
    // run as passes on a provisioned machine and as skips on a fresh clone or
    // CI runner. Strict equality here made --check impossible to satisfy on
    // the operator's machine and CI at the same time (found 2026-08-16, the
    // last layer of the CI-red-for-three-days chain). Tolerant slot: the
    // pattern must still exist; the ROADMAP block's pass+fail+skipped==tests
    // invariant is what still catches real drift.
    { file, pattern: /(tests-)(\d+)(%20pass-)/, value: counts.pass, tolerant: true },
    { file, pattern: /(Linear history on `main`\. )(\d+)( tests green\.)/, value: counts.tests },
    // The README hero also states the count inside the readme-typing-svg URL's
    // `lines=` query param, where the text is URL-encoded ("N+tests+green.") and
    // carries none of the prose anchors above. No slot covered it, so it was the
    // one test-count site this script could not move: it sat at 1761 while every
    // slot-covered site had advanced past 2900, i.e. README disagreed with itself
    // three ways. Anchored on the `;`-separated typing-SVG line + the encoded
    // suffix so it cannot match the plain-prose sites.
    { file, pattern: /(;)(\d+)(\+tests\+green\.)/, value: counts.tests },
    { file, pattern: /(\*\*Tests\*\* \| Built-in `node:test` \| )(\d+)( tests, zero test framework deps \|)/, value: counts.tests },
    // NOTE: "4 deps" used to be baked into this pattern as a literal, which meant
    // it silently stopped matching (and MISSING PATTERN-reported, not silently
    // ignored) the moment deps count actually changed. Both numbers on this line
    // are now their own slots, neither hand-typed into the regex.
    { file, pattern: /(package\.json\s+# )(\d+)( deps, \d+ tests)/, value: counts.deps },
    { file, pattern: /(package\.json\s+# \d+ deps, )(\d+)( tests)/, value: counts.tests },
    { file, pattern: /(test\/\s+# )(\d+)( tests \(node --test\))/, value: counts.tests },
    // AD-10: tool/provider/sensor counts, generated from hub.catalog()-equivalent
    // introspection (computeEffectorCount) and directory reads, not hand-typed.
    { file, pattern: /(Every action MYTHOS can take goes through one of these )(\d+)( registered effectors\.)/, value: counts.effectors },
    // The effector count also appears in the section HEADING, in the TOC entry
    // that links to it (link text AND the generated #anchor — both must move
    // together or the TOC link 404s), and in the architecture mermaid's I/O
    // node. Those four were NOT slots, so they sat at 107 while the body text
    // this script does own had already moved to 139 — README disagreeing with
    // itself by 32 tools. AD-10 says a tool count is generated, never
    // hand-typed; these are now generated too instead of being re-drifted by
    // hand every time the effector surface changes.
    // The 2026-07-31 README redesign moved every one of these: the heading gained
    // an emoji (`## 🧰 143-Tool Effectors`), the plain TOC bullet became an inline
    // nav pill (`[**138 Tools**](#-138-tool-effectors)`), and a shields.io badge
    // appeared with the count in BOTH its label and its href. The old anchored
    // patterns stopped matching and reported MISSING PATTERN — correctly loud, but
    // it meant the count drifted freely in the meantime. These are deliberately
    // tolerant of decorative prefixes so a future restyle does not silently unhook
    // the gate again; the `-Tool Effectors` / `-tool-effectors` suffix is what
    // actually identifies the slot.
    { file, pattern: /(## [^\n]*?)(\d+)(-Tool Effectors)/, value: counts.effectors },
    { file, pattern: /(\]\(#-?)(\d+)(-tool-effectors\))/, value: counts.effectors },
    // The LINK TEXT of the same anchor. Found stale on 2026-08-19 reading
    // "[142-Tool Effectors](#146-tool-effectors)" — the href was a slot and the
    // words in front of it were not, so the two halves of one link disagreed by
    // four. The heading slot above is anchored on "## " and cannot reach this,
    // which is exactly why it needs its own.
    { file, pattern: /(\[)(\d+)(-Tool Effectors\]\(#)/, value: counts.effectors },
    { file, pattern: /(badge\/effectors-)(\d+)(%20tools)/, value: counts.effectors },
    { file, pattern: /(\[\*\*)(\d+)( Tools\*\*\]\(#)/, value: counts.effectors },
    { file, pattern: /(EFF\[")(\d+)( Effectors"\])/, value: counts.effectors },
    { file, pattern: /(SENSORS   ←→   BUS   ←→   EFFECTORS             │  )(\d+)( sensors · \d+ effectors)/, value: counts.sensors },
    { file, pattern: /(sensors · )(\d+)( effectors)/, value: counts.effectors },
    { file, pattern: /(effectors\/       # )(\d+)( tools, build-runner, orchestrator)/, value: counts.effectors },
    { file, pattern: /(providers\/               # )(\d+)( providers \(openai-compat factory\))/, value: counts.providers },
    { file, pattern: /(\*\*Deps\*\* \| )(\d+)( total \|)/, value: counts.deps },
  ];
}

function applySlots(counts, mode, report) {
  let staleCount = 0;
  const byFile = new Map();
  for (const slot of readmeSlots(counts)) {
    const content = byFile.get(slot.file) ?? fs.readFileSync(slot.file, 'utf8');
    // EVERY occurrence, not just the first. `content.replace(nonGlobalRegex)`
    // rewrites one match, and `content.match()` only ever inspected one — so a
    // count that appears in a badge AND a nav link AND a heading was checked once
    // and silently left stale everywhere else. Found 2026-07-31 when a README
    // redesign left the effector badge reading 143 while the nav read 138 and the
    // real count was 138, with --check reporting only a single slot.
    const gre = new RegExp(slot.pattern.source, slot.pattern.flags.includes('g') ? slot.pattern.flags : slot.pattern.flags + 'g');
    const matches = [...content.matchAll(gre)];
    if (matches.length === 0) {
      report.push(`MISSING PATTERN in ${path.relative(REPO_ROOT, slot.file)}: ${slot.pattern}`);
      staleCount++;
      continue;
    }
    if (slot.tolerant) {
      // Presence-only (see the slot's own comment): the value legitimately
      // varies by machine, so a mismatch is not staleness.
      byFile.set(slot.file, content);
      continue;
    }
    const stale = matches.filter((m) => parseInt(m[2], 10) !== slot.value);
    if (stale.length === 0) {
      byFile.set(slot.file, content);
      continue;
    }
    staleCount++;
    const found = [...new Set(stale.map((m) => m[2]))].join('/');
    const where = matches.length > 1 ? ` (${stale.length} of ${matches.length} occurrences)` : '';
    report.push(`${path.relative(REPO_ROOT, slot.file)}: found ${found}, expected ${slot.value}${where}`);
    const next = mode === 'write' ? content.replace(gre, `$1${slot.value}$3`) : content;
    byFile.set(slot.file, next);
    if (mode === 'write') report.push('  -> written');
  }
  if (mode === 'write') {
    for (const [file, content] of byFile) fs.writeFileSync(file, content, 'utf8');
  }
  return staleCount;
}

const ROADMAP_ANCHOR = '## Keeping this file current';
// BUG (found 2026-07-30): the newlines here were hardcoded `\n`, so on any clone
// with core.autocrlf=true (the Windows default) the CRLF working copy never
// matched — --check always reported "sync block missing", and --write would then
// INSERT A SECOND block above the anchor instead of updating the existing one.
// Match either ending, and emit whichever the file already uses.
const ROADMAP_BLOCK_RE = /<!-- SYNC:TEST-COUNT:START -->\r?\n\*\*Current test-suite state\*\* \(auto-synced by `mythos\/scripts\/sync-test-count\.js`, last run \d{4}-\d{2}-\d{2}\): \*\*(\d+) tests, (\d+) passing, (\d+) failing, (\d+) skipped\.\*\*\r?\n<!-- SYNC:TEST-COUNT:END -->/;

function roadmapBlock(counts, date, eol) {
  return `<!-- SYNC:TEST-COUNT:START -->${eol}**Current test-suite state** (auto-synced by \`mythos/scripts/sync-test-count.js\`, last run ${date}): **${counts.tests} tests, ${counts.pass} passing, ${counts.fail} failing, ${counts.skipped} skipped.**${eol}<!-- SYNC:TEST-COUNT:END -->`;
}

function syncRoadmap(counts, mode, report) {
  const content = fs.readFileSync(ROADMAP_FILE, 'utf8');
  const m = content.match(ROADMAP_BLOCK_RE);
  const today = new Date().toISOString().slice(0, 10);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  if (!m) {
    report.push('ROADMAP.md: sync block missing');
    if (mode === 'write') {
      const idx = content.indexOf(ROADMAP_ANCHOR);
      if (idx === -1) throw new Error(`sync-test-count: ROADMAP.md anchor "${ROADMAP_ANCHOR}" not found, refusing to guess where to insert`);
      const block = `${roadmapBlock(counts, today, eol)}${eol}${eol}---${eol}${eol}`;
      fs.writeFileSync(ROADMAP_FILE, content.slice(0, idx) + block + content.slice(idx), 'utf8');
      report.push('  -> inserted');
    }
    return true;
  }

  const [, tests, pass, fail, skipped] = m;
  // tests and fail are machine-stable (same test files everywhere; failures
  // are gated to 0 by the hook/CI). pass/skipped are NOT machine-stable:
  // honest fixture-skips (BYO edge-tts .venv, per-machine model weights) run
  // as passes on a provisioned machine and as skips on a fresh clone or CI
  // runner, so strict equality could never be green on both at once
  // (2026-08-16 — same chain as the tolerant README badge slot). The
  // invariant below is what still catches real drift: the three states must
  // partition the whole suite exactly.
  const invariantHolds = (+pass) + (+fail) + (+skipped) === (+tests);
  const matches = +tests === counts.tests && +fail === counts.fail && invariantHolds;
  if (matches) return false;

  report.push(`ROADMAP.md: sync block stale (found ${tests}/${pass}/${fail}/${skipped}, expected ${counts.tests}/${counts.pass}/${counts.fail}/${counts.skipped})`);
  if (mode === 'write') {
    fs.writeFileSync(ROADMAP_FILE, content.replace(ROADMAP_BLOCK_RE, roadmapBlock(counts, today, eol)), 'utf8');
    report.push('  -> written');
  }
  return true;
}

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.error('Usage: node scripts/sync-test-count.js --check | --write');
    process.exit(2);
    return;
  }

  const counts = parseCounts(await getSuiteOutput());
  // AD-10: docs match reality — tool/provider/sensor/dep counts ride along with
  // the test count as generated values, not hand-typed ones.
  counts.deps = computeDepsCount();
  counts.sensors = computeSensorCount();
  counts.providers = computeProviderCount();
  counts.effectors = computeEffectorCount();
  console.log(
    `sync-test-count: tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped} ` +
    `deps=${counts.deps} sensors=${counts.sensors} providers=${counts.providers} effectors=${counts.effectors}`,
  );
  if (counts.fail > 0) {
    console.warn(
      `sync-test-count: ${counts.fail} test(s) currently failing. This script only keeps ` +
      'documented counts honest — it does not gate on failures (see .githooks/pre-commit / ci.yml for that).',
    );
  }

  const report = [];
  let staleCount = applySlots(counts, mode, report);
  if (syncRoadmap(counts, mode, report)) staleCount++;

  if (report.length) console.log(report.join('\n'));

  if (mode === 'check') {
    if (staleCount > 0) {
      console.error(`sync-test-count --check: ${staleCount} stale number(s). Run 'node scripts/sync-test-count.js --write' and commit the result.`);
      process.exit(1);
    }
    console.log('sync-test-count --check: all tracked numbers match the real suite. OK.');
    return;
  }

  console.log(staleCount > 0 ? `sync-test-count --write: updated ${staleCount} number(s).` : 'sync-test-count --write: already in sync, nothing to do.');
}

if (require.main === module) main();

module.exports = { computeEffectorTools, computeEffectorCount, createInertCtx };
