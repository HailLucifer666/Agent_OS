'use strict';

// test/electron-builder-files-allowlist.test.js — Track A1 (installer, Slice 4
// of 6). package.json's `build.files` is a LICENSING control, not just a
// packaging list: it must keep the LGPLv3 edge-tts Python package, the
// CC BY-NC-SA openWakeWord weights, and the operator's real vault data out of
// the shipped installer. A glob that silently starts matching (or a typo that
// silently stops matching) is exactly the failure mode this repo keeps
// hitting — see CLAUDE.md's concurrent-session-safety history — so this test
// runs the real matcher electron-builder itself uses (app-builder-lib's
// FileMatcher, which wraps minimatch with the exact { dot: true } options and
// the same last-match-wins semantics as util/filter.js's minimatchAll), not a
// hand-rolled regex that would pass regardless of whether the config works.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function loadBuildConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build, 'package.json must have a top-level "build" block');
  assert.ok(Array.isArray(pkg.build.files), 'build.files must be an array');
  return pkg.build;
}

// Builds a filter function using electron-builder's OWN FileMatcher/minimatch
// pipeline (app-builder-lib/out/fileMatcher.js + util/filter.js), the same
// code electron-builder runs internally during `copyFiles()`. macroExpander is
// the identity function — none of our patterns use ${} template vars.
function buildRealFilter(patterns) {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const identity = (x) => x;
  const matcher = new FileMatcher(REPO_ROOT, REPO_ROOT, identity, patterns);
  return matcher.createFilter();
}

// stat() a real path so minimatchAll's directory-aware partial-match logic
// (see util/filter.js) behaves exactly as it would during a real build. Every
// path asserted below must exist on disk in this checkout (some via
// mythos/.venv, mythos/vault or mythos/ui/public/models/wakeword, all
// gitignored but present locally) so the assertion is about the real matcher
// against a real file, not a synthetic path.
function isIncluded(filterFn, absPath) {
  const stat = fs.statSync(absPath);
  return filterFn(absPath, stat);
}

// One fixture below is NOT merely gitignored-but-present — it is fetched on
// first use INTO node_modules (kokoro-js downloads its weights the first time
// TTS runs), so a checkout that has never spoken has no such file and the
// existsSync guard fails as though the packaging config were broken. That is a
// false failure: it says nothing about build.files, and it blocks every commit
// via the pre-commit hook.
//
// So materialize a stand-in when, and only when, the real file is absent. The
// matcher is path + stat based, so a 1-byte file at the same absolute path
// exercises the identical glob semantics; the assertion still runs against
// electron-builder's own FileMatcher, not a synthetic reimplementation. Nothing
// that already exists is created, written or removed, and only the directories
// this helper made are cleaned up — deliberately NOT generalised to the
// wakeword/silero fixtures, whose directories other tests and the
// /api/config/wakeword route stat for presence (see CLAUDE.md's wakeword
// rename-race entry: faking real model state is how weights get destroyed).
function withStandInIfAbsent(absPath, fn) {
  if (fs.existsSync(absPath)) return fn();
  const createdDirs = [];
  let dir = path.dirname(absPath);
  while (!fs.existsSync(dir)) {
    createdDirs.unshift(dir);
    dir = path.dirname(dir);
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, '\0');
  try {
    return fn();
  } finally {
    fs.rmSync(absPath, { force: true });
    for (const made of createdDirs.reverse()) fs.rmSync(made, { recursive: true, force: true });
  }
}

test('build.files excludes the edge-tts server script (LGPLv3 BYO boundary)', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', 'services', 'edge-tts-server.py');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  assert.equal(isIncluded(filterFn, target), false,
    'mythos/services/edge-tts-server.py must be excluded from the installer');
});

test('build.files excludes the vendored edge-tts LGPLv3 package under mythos/.venv', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', '.venv', 'Lib', 'site-packages', 'edge_tts', '__init__.py');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  assert.equal(isIncluded(filterFn, target), false,
    'the installed edge_tts LGPLv3 package under mythos/.venv must never be packaged');
});

test('build.files excludes the openWakeWord CC BY-NC-SA pretrained weights', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', 'ui', 'public', 'models', 'wakeword', 'hey_jarvis_v0.1.onnx');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  assert.equal(isIncluded(filterFn, target), false,
    'openWakeWord .onnx weights (CC BY-NC-SA, non-commercial) must never be packaged');
});

// The three assets below were found by walking a REAL dist/win-unpacked, after
// the exclusions above were already in place and passing. They are the reason
// this file asserts model paths as a class rather than naming known-bad ones:
//
//   electron-builder packages the WORKING DIRECTORY, not the git tree.
//
// So .gitignore is not a packaging boundary. Every model in this repo is
// deliberately fetched per-machine and never committed (scripts/setup-silero.js,
// scripts/setup-wakeword.js, scripts/setup-piper.js, and Kokoro/Whisper on
// first use — see .gitignore:39-110), which means a developer's local checkout
// has weights on disk that git has never seen, and a naive `files` list ships
// every one of them. The openWakeWord weights escaped only because the pattern
// above named that exact directory; silero_vad.onnx and a Hugging Face cache
// copy of Kokoro-82M did NOT, and both were confirmed present inside
// dist/win-unpacked/resources/app/. Hence "!mythos/ui/public/models{,/**/*}"
// (the whole tree, not one subdirectory) and "!**/.cache{,/**/*}".
//
// Excluding them is consistent with the architecture rather than a regression:
// these files are absent on a fresh clone too, and the setup scripts exist
// precisely to fetch them per machine.

test('build.files excludes gesture_recognizer.task — the one committed model, licence UNVERIFIED', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', 'ui', 'public', 'models', 'gesture_recognizer.task');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  // Step 6.6's licence audit (2026-08-04) established that this 8.4MB MediaPipe
  // weight file is the ONLY third-party model binary actually tracked in git —
  // every other model is gitignored and fetched per-machine — and that its
  // licence is NOT established. MediaPipe's *code* is Apache-2.0, but the
  // model artifact's terms are separate and were not confirmed; the developer
  // docs page covers page content (CC BY 4.0) and code samples (Apache-2.0),
  // neither of which is the binary. That is the same code-licence-vs-weights
  // trap that openWakeWord's CC BY-NC-SA weights set. Until the model card
  // resolves it, it stays out of a shippable installer. THIRD_PARTY_NOTICES.md
  // documents @mediapipe/tasks-vision but not this file.
  assert.equal(isIncluded(filterFn, target), false,
    'gesture_recognizer.task must stay out of the installer while its model licence is unverified');
});

test('build.files excludes the Silero VAD weights (gitignored, but present on disk)', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', 'ui', 'public', 'models', 'silero', 'silero_vad.onnx');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  assert.equal(isIncluded(filterFn, target), false,
    'silero_vad.onnx is fetched per-machine by scripts/setup-silero.js and must not be redistributed');
});

test('build.files excludes Hugging Face .cache model copies pulled in via node_modules', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  // kokoro-js caches its downloaded weights INSIDE node_modules, so the model
  // arrives through a dependency rather than through this repo's own tree —
  // invisible to any check that only looks at mythos/ui/public/models or at
  // git. Confirmed shipped in a real build before "!**/.cache{,/**/*}".
  const target = path.join(
    REPO_ROOT, 'mythos', 'node_modules', 'kokoro-js', 'node_modules', '@huggingface',
    'transformers', '.cache', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx',
  );
  withStandInIfAbsent(target, () => {
    assert.equal(isIncluded(filterFn, target), false,
      'a cached Kokoro model copy under node_modules/**/.cache must not be packaged');
  });
});

test('build.files excludes the operator\'s real vault data', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const target = path.join(REPO_ROOT, 'mythos', 'vault', 'Audit');
  assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
  assert.equal(isIncluded(filterFn, target), false,
    'mythos/vault (real operator data) must never be packaged');
});

// Positive control: if the exclusion patterns above were accidentally too
// broad (e.g. a stray "!mythos/**/*"), every one of the exclusion tests would
// still pass "vacuously" while the app itself shipped empty. Assert real
// runtime files the packaged app needs ARE still included, so a
// too-aggressive pattern fails loudly here instead of at install time.
test('build.files still includes the files the packaged app needs to run', () => {
  const { files } = loadBuildConfig();
  const filterFn = buildRealFilter(files);
  const mustInclude = [
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'electron', 'main.js'),
    path.join(REPO_ROOT, 'electron', 'preload.js'),
    path.join(REPO_ROOT, 'mythos', 'src', 'main.js'),
    path.join(REPO_ROOT, 'mythos', 'server', 'index.js'),
  ];
  for (const target of mustInclude) {
    assert.ok(fs.existsSync(target), 'fixture path must exist: ' + target);
    assert.equal(isIncluded(filterFn, target), true, target + ' must be included in the installer');
  }
});

// Regression guard: FileMatcher/minimatch alone says mythos/node_modules is
// included (it matches "mythos/**/*"), but electron-builder's AppFileWalker
// applies a SEPARATE, hardcoded filter — any directory literally named
// "node_modules" that isn't the project root's is dropped unless
// build.includeSubNodeModules is true (see app-builder-lib/out/util/
// AppFileWalker.js's createAppFilter/nodeModulesFilter). A real `npm run dist`
// build silently produced a packaged app with zero files under
// mythos/node_modules (confirmed by walking dist/win-unpacked) before this
// flag was added — express/ws/etc. would have been missing at runtime. The
// FileMatcher-only test above cannot catch this because it is not part of the
// matcher; assert the raw build.includeSubNodeModules config flag instead.
// electron-builder prints "asar usage is disabled — this is strongly not
// recommended" twice on every build and suggests enabling asar with
// asarUnpack. DO NOT FOLLOW THAT ADVICE HERE. electron/main.js:242 forks the
// server as a child process — `child_process.fork(SERVER_ENTRY, [], { cwd:
// MYTHOS_DIR })` where SERVER_ENTRY is mythos/src/main.js — and a fork's cwd
// cannot be a path inside an asar archive. The child also writes ./vault,
// .browser-agent.pid and friends relative to that cwd (see the comment at
// main.js:63 recording the bug from forking WITHOUT setting cwd), and an asar
// archive is read-only. So asar:false is load-bearing for the architecture,
// not an oversight — and the failure it prevents would appear ONLY in a
// packaged build, never in dev or in this suite, which is exactly the kind of
// gap that gets "fixed" by a well-meaning future reader following the build
// warning. If asar is ever genuinely wanted, mythos/ must be asarUnpack'd
// (which is most of the payload anyway) and the fork path re-verified against
// a real installed build first.
test('build.asar stays false — the child-server fork() cannot cwd into an asar archive', () => {
  const config = loadBuildConfig();
  assert.equal(config.asar, false,
    'asar must stay disabled: electron/main.js forks mythos/src/main.js with ' +
    'cwd set to the mythos directory, which must be a real writable path');
});

test('build.includeSubNodeModules is set (mythos/node_modules would otherwise be dropped)', () => {
  const config = loadBuildConfig();
  assert.equal(config.includeSubNodeModules, true,
    'without this flag, electron-builder\'s AppFileWalker drops any non-root ' +
    'node_modules directory regardless of the files allowlist — confirmed by ' +
    'a real build that shipped mythos/node_modules empty');
});
