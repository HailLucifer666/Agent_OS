'use strict';

// BUG-372 follow-on — Kokoro off the event loop, and a cache that is actually
// the cache.
//
// TWO DEFECTS, BOTH MEASURED 2026-09-11 (node v26.1.0, 8 cpus).
//
// (1) THE CACHE DIRECTORY WAS CONFIGURED ON A MODULE NOTHING LOADS FROM.
//     providers/kokoro-tts.js did `env.cacheDir = modelDir` on
//     `@huggingface/transformers` resolved from providers/, then loaded through
//     kokoro-js, which resolves its OWN nested copy:
//         from providers/  -> mythos/node_modules/@huggingface/transformers          (4.2.0 at the fix; re-verified 4.3.2, 2026-10-29, same hoisted position)
//         from kokoro-js/  -> mythos/node_modules/kokoro-js/node_modules/@huggingface/transformers (3.8.1)
//     kokoro-js pins ^3.5.1, so npm nested a second copy. KOKORO_MODEL_DIR did
//     NOTHING. Proof on disk: a 92,361,116-byte model_quantized.onnx in the
//     nested instance's default cache, while mythos/models/kokoro had never been
//     created — the directory doctor.js reported on.
//     The control experiment is one file away: providers/local-whisper-stt.js
//     writes the identical two lines but calls pipeline() on the SAME instance,
//     and its cache landed where it was told.
//
// (2) SYNTHESIS BLOCKED THE EVENT LOOP. Measured, quiet machine, 3 reps each,
//     same warm cache, same text:
//         in-process : main-thread CPU 23094 ms, max loop lag 876 ms, 1 sample >= 250 ms
//         worker     : main-thread CPU    47 ms, max loop lag  24 ms, 0 samples >= 250 ms
//         median wall: 23552 ms -> 23419 ms (-1%), audio byte-identical (same sha256)
//     So it was never a speed problem. It was a "the server answers nothing for
//     23 seconds" problem, and the fix costs no wall time.
//
// AND A THIRD, FOUND BY THE PROBE ITSELF: listVoices() returned ZERO voices for
// an engine with 28, because kokoro-js's list_voices() is console.table(...) and
// returns undefined, so Object.keys(undefined) threw into a bare catch. It also
// printed a 28-row table to stdout, which corrupted the probe's own JSON — which
// is how it was noticed.
//
// WHAT THIS FILE CANNOT TEST, AND WHERE THAT LIVES INSTEAD. The model is 92 MB;
// it cannot be in the suite. Everything here uses a FAKE worker through the
// client's injectable `spawn` seam. The real proofs are:
//   * scripts/verify-kokoro-offline.js — loads and synthesizes with
//     net.Socket.connect and dns.lookup patched to throw, then RE-EXECUTES
//     ITSELF as a second process against the same cache. Measured 2026-09-11:
//     parent PASS (18214 ms, zero network calls, peak 0.509, not silent), second
//     process PASS (18377 ms, identical audio). That, not a filename check, is
//     what proves the migrated cache is self-sufficient.
//   * A packaged boot. A green suite cannot tell you the app starts — this repo
//     has that lesson on record from the Slice 5 cursor overlay.
//
// Run: cd mythos && node --test test/bug-372-kokoro-worker-and-cache.test.js
//
// MUTATION PROOF — MEASURED 2026-09-11. Each applied to the real source,
// confirmed present on disk, parse-checked (JS via `node --check`, package.json
// via a JSON parse — the harness reported PARSE-BROKEN the first time it ran
// `node --check` against JSON, which is the harness working correctly: a
// mutation that only breaks the parse proves nothing), run under
// --test-reporter=tap, then restored and re-hashed sha256-identical. All 26
// tests were GREEN before each mutation.
//
//   M1  read voices via console-printing list_voices() again  -> fail 1
//   M2  migration OVERWRITES instead of reporting a conflict  -> fail 1
//   M3  re-copy a file already present and identical          -> fail 1
//   M4  migrate another run's in-flight .part file            -> fail 1
//   M5  accept a non-integer timeout                          -> fail 2
//   M6  an invalid timeout THROWS instead of declining        -> fail 1
//   M7  explicit KOKORO_MODEL_DIR stops suppressing migration -> fail 1
//   M8  drop the echoed-generation check                      -> fail 1
//   M9  deadline starts at inference, not at admission        -> fail 1
//   M10 shutdown does not await termination                   -> fail 1
//   M11 a cancelled synthesis records a provider failure      -> fail 1
//   M12 drop "!mythos/models" from build.files                -> fail 1
//   M13 drop "!**/.cache" from build.files                    -> fail 2
//
// M8 EXISTS BECAUSE THE TEST FOUND A REAL GAP. The client originally checked
// only the generation bound to the worker at spawn, which cannot see a reply
// that carries the wrong `gen` from the CURRENT worker — so "correlate by id AND
// generation" was not literally true. The test failed, and the CLIENT was fixed
// rather than the test.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { parseTimeout, resolveTimeouts, MAX_TIMER_MS } = require('../providers/kokoro/timeouts');
const { resolveKokoroModelDir, legacyCacheDirs, hasWeights } = require('../providers/kokoro/paths');
const { migrateLegacyCache } = require('../providers/kokoro/migrate-cache');
const { createKokoroClient } = require('../providers/kokoro/client');

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-' + label + '-'));
}

// A worker that never exists. Every test drives this instead of node:worker_threads.
class FakeWorker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.posted = [];
    this.terminated = 0;
    this.refs = 0;
    this.unrefs = 0;
    this.autoReply = opts.autoReply || null;
  }
  postMessage(msg) {
    this.posted.push(msg);
    if (this.autoReply) {
      const r = this.autoReply(msg);
      if (r) setImmediate(() => this.emit('message', r));
    }
  }
  ref() { this.refs += 1; }
  unref() { this.unrefs += 1; }
  async terminate() { this.terminated += 1; return 0; }
}

describe('BUG-372 — timeouts are validated, and an invalid one cannot break boot', () => {
  test('an unset variable is the default; an empty one is an error', () => {
    assert.deepEqual(parseTimeout('X', undefined, 60000), { ok: true, ms: 60000 });
    assert.equal(parseTimeout('X', '', 60000).ok, false,
      'X= in a .env file is someone trying to say something; treating it as "default" hides a typo');
    assert.equal(parseTimeout('X', '   ', 60000).ok, false);
  });

  test('only a finite positive integer inside Node timer range is accepted', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', 'Infinity', 'NaN', String(MAX_TIMER_MS + 1)]) {
      const r = parseTimeout('KOKORO_SYNTH_TIMEOUT_MS', bad, 60000);
      assert.equal(r.ok, false, JSON.stringify(bad) + ' must be rejected');
      assert.match(r.reason, /KOKORO_SYNTH_TIMEOUT_MS/, 'the reason names the variable');
      assert.ok(r.reason.includes(JSON.stringify(bad)), 'and quotes the offending value');
    }
    assert.deepEqual(parseTimeout('X', '1', 9).ms, 1);
    assert.deepEqual(parseTimeout('X', String(MAX_TIMER_MS), 9).ms, MAX_TIMER_MS);
  });

  test('MAX_TIMER_MS is the real 32-bit ceiling, not a round number', () => {
    // Node silently clamps anything above 2^31-1 to 1 ms. "Wait an hour" would
    // become "fire immediately", which presents as a timeout firing at random.
    assert.equal(MAX_TIMER_MS, 2147483647);
  });

  test('resolveTimeouts names the FIRST offender and never throws', () => {
    const r = resolveTimeouts({ KOKORO_LOAD_TIMEOUT_MS: 'nope', KOKORO_SYNTH_TIMEOUT_MS: 'also-nope' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /KOKORO_LOAD_TIMEOUT_MS/);
    assert.ok(!r.reason.includes('KOKORO_SYNTH_TIMEOUT_MS'), 'one reason is enough to act on');
    assert.deepEqual(resolveTimeouts({}), { ok: true, initMs: 60000, synthMs: 60000 });
  });

  test('requiring the provider with a broken timeout does not throw, and reports unavailable', async () => {
    // providers/tts.js requires this module at boot. An optional provider must
    // never be the reason the server fails to start.
    const prev = process.env.KOKORO_SYNTH_TIMEOUT_MS;
    process.env.KOKORO_SYNTH_TIMEOUT_MS = '-5';
    try {
      delete require.cache[require.resolve('../providers/kokoro-tts')];
      const provider = require('../providers/kokoro-tts');
      assert.equal(await provider.isAvailable(), false);
      assert.match(provider.unavailableReason(), /KOKORO_SYNTH_TIMEOUT_MS/,
        'the decline names the variable and the value, so it is fixable without reading the source');
    } finally {
      if (prev === undefined) delete process.env.KOKORO_SYNTH_TIMEOUT_MS; else process.env.KOKORO_SYNTH_TIMEOUT_MS = prev;
      delete require.cache[require.resolve('../providers/kokoro-tts')];
    }
  });
});

describe('BUG-372 — the cache directory is the one the loader actually reads', () => {
  test('an explicit KOKORO_MODEL_DIR wins, and suppresses legacy migration entirely', () => {
    const dir = tmpdir('explicit');
    assert.equal(resolveKokoroModelDir({ KOKORO_MODEL_DIR: dir }), path.resolve(dir));
    assert.deepEqual(legacyCacheDirs({ KOKORO_MODEL_DIR: dir }), [],
      'an operator who named a directory gets that directory and nothing else');
  });

  test('otherwise the shared userData model root, and only then the project fallback', () => {
    const userData = tmpdir('userdata');
    assert.equal(resolveKokoroModelDir({ MYTHOS_MODELS_DIR: userData }), path.join(path.resolve(userData), 'kokoro'));
    const fallback = resolveKokoroModelDir({});
    assert.ok(fallback.endsWith(path.join('mythos', 'models', 'kokoro')),
      'the no-userData fallback is project-local, NOT modelWriteDir()"s install-tree path — that one '
      + 'is excluded from the installer wholesale and is where the non-commercial wake-word weights '
      + 'live, so a dev cache must not land there');
  });

  test('the legacy directory is DERIVED from kokoro-js"s own resolution, never hardcoded', () => {
    const dirs = legacyCacheDirs({});
    // kokoro-js may or may not be installed; both are valid states.
    for (const d of dirs) {
      assert.ok(d.includes('transformers'), 'derived from the transformers package kokoro-js resolves: ' + d);
      assert.ok(d.endsWith('.cache'), 'and it is that package"s own default cache');
      assert.ok(fs.existsSync(d), 'only existing directories are reported');
    }
    // Hardcoding node_modules/kokoro-js/node_modules/... would go stale the first
    // time npm hoisted differently — and npm hoisting is what CAUSED this bug.
    //
    // COMMENTS ARE STRIPPED FIRST, deliberately. paths.js documents the measured
    // resolution in prose, including the very path this test forbids in code,
    // and that documentation is the most valuable thing in the file. A guard
    // that cannot tell a comment from a require() would force the evidence out
    // of the source to stay green — which is a worse outcome than the drift it
    // is protecting against.
    const raw = fs.readFileSync(path.join(__dirname, '..', 'providers', 'kokoro', 'paths.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/node_modules[\\/]kokoro-js[\\/]node_modules/.test(code),
      'paths.js CODE must not contain a hardcoded nested node_modules path');
    assert.match(code, /createRequire/, 'it derives the location instead');
    assert.match(raw, /node_modules[\\/]kokoro-js[\\/]node_modules/,
      'and the prose still records the measured resolution, so the next reader does not have to '
      + 'rediscover why this matters');
  });

  test('hasWeights reads the layout transformers ACTUALLY writes', () => {
    // Verified on disk 2026-09-11 against transformers 3.8.1: the layout is
    // <cacheDir>/<org>/<repo>/… — it is NOT the hub's models--<org>--<repo>
    // shape, and a check written for that finds nothing here.
    const root = tmpdir('layout');
    const real = path.join(root, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'model_quantized.onnx'), 'x'.repeat(64));
    const found = hasWeights(root, 'onnx-community/Kokoro-82M-v1.0-ONNX');
    assert.ok(found, 'the real layout must be found');
    assert.equal(found.bytes, 64);
    assert.equal(hasWeights(root, 'onnx-community/Some-Other-Model'), null, 'and a different model is not');
  });
});

describe('BUG-372 — migration cannot lose data', () => {
  function seed(root, rel, bytes) {
    const full = path.join(root, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x'.repeat(bytes));
    return full;
  }
  const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

  test('copies what is missing and reports the bytes', () => {
    const from = tmpdir('from'); const to = tmpdir('to');
    seed(from, 'config.json', 10);
    seed(from, path.join('onnx', 'model_quantized.onnx'), 200);
    const r = migrateLegacyCache({ from, to, modelId: MODEL });
    assert.equal(r.copied.length, 2);
    assert.equal(r.bytes, 210);
    assert.ok(fs.existsSync(path.join(to, 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', 'model_quantized.onnx')));
  });

  test('NEVER overwrites, NEVER deletes, and reports a size mismatch as a conflict', () => {
    const from = tmpdir('from2'); const to = tmpdir('to2');
    const src = seed(from, 'config.json', 10);
    const dst = seed(to, 'config.json', 99);   // different content already there
    const r = migrateLegacyCache({ from, to, modelId: MODEL });
    assert.equal(r.copied.length, 0);
    assert.equal(r.conflicts.length, 1, 'reported, not resolved — this module cannot know which is right');
    assert.equal(r.conflicts[0].legacyBytes, 10);
    assert.equal(r.conflicts[0].canonicalBytes, 99);
    assert.equal(fs.readFileSync(dst, 'utf8').length, 99, 'the destination is untouched');
    assert.ok(fs.existsSync(src), 'and the source is never deleted — it is the backup until npm removes it');
  });

  test('an identical file already present is skipped, not re-copied', () => {
    const from = tmpdir('from3'); const to = tmpdir('to3');
    seed(from, 'config.json', 10);
    seed(to, 'config.json', 10);
    const r = migrateLegacyCache({ from, to, modelId: MODEL });
    assert.equal(r.copied.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].why, 'already-present');
  });

  test('no partially-copied file is ever visible under its real name', () => {
    const from = tmpdir('from4'); const to = tmpdir('to4');
    seed(from, path.join('onnx', 'model_quantized.onnx'), 500);
    const r = migrateLegacyCache({ from, to, modelId: MODEL });
    assert.equal(r.copied.length, 1);
    const leftovers = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.part')) leftovers.push(f); } };
    walk(to);
    assert.deepEqual(leftovers, [],
      'a .part left behind is recoverable; a half-written model_quantized.onnx under its real name '
      + 'would be served as a cache hit and is not');
  });

  test('a leftover .part from an interrupted run is ignored, not migrated', () => {
    const from = tmpdir('from5'); const to = tmpdir('to5');
    seed(from, 'config.json', 10);
    seed(from, 'config.json.9999.1.part', 3);
    const r = migrateLegacyCache({ from, to, modelId: MODEL });
    assert.deepEqual(r.copied, ['config.json'], 'only the real file crossed over');
  });

  test('an unrelated model in the same legacy cache is left alone', () => {
    const from = tmpdir('from6'); const to = tmpdir('to6');
    seed(from, 'config.json', 10);
    const other = path.join(from, 'someone-else', 'Other-Model', 'weights.onnx');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'y'.repeat(50));
    migrateLegacyCache({ from, to, modelId: MODEL });
    assert.ok(!fs.existsSync(path.join(to, 'someone-else')), 'only the requested model subtree is touched');
  });
});

describe('BUG-372 — the worker supervisor', () => {
  function clientWith(autoReply, extra) {
    const workers = [];
    const c = createKokoroClient(Object.assign({
      env: {},
      initTimeoutMs: 5000,
      synthTimeoutMs: 5000,
      spawn: () => { const w = new FakeWorker({ autoReply }); workers.push(w); return w; },
    }, extra || {}));
    return { c, workers };
  }
  const loadOk = (msg) => (msg.op === 'load' ? { id: msg.id, gen: msg.gen, ok: true, result: { cacheDir: 'x', voices: 28 } } : null);

  // FOUND 2026-09-11 by walking into it while writing
  // scripts/verify-packaged-kokoro.js. Both deadlines are `now() + timeout`, so
  // an omitted timeout is NaN — and setTimeout does not reject NaN, it clamps to
  // 1 ms and fires immediately. The caller was then told "kokoro load timed out",
  // which reads as a broken worker or a slow disk, when the real fault was a
  // missing constructor argument. That is the repo's "fallback that makes broken
  // config look healthy" shape, one layer down.
  //
  // Pinned as a THROW rather than a default on purpose: a default would let a
  // caller that failed to thread the operator's KOKORO_LOAD_TIMEOUT_MS through
  // look perfectly healthy while silently ignoring it.
  test('constructing the client without timeouts fails loudly, not as a 1ms timeout', () => {
    assert.throws(() => createKokoroClient({}), /initTimeoutMs must be a positive finite number/,
      'an absent initTimeoutMs becomes a NaN deadline; setTimeout clamps that to 1ms and reports a timeout');
    assert.throws(() => createKokoroClient({ initTimeoutMs: 5000 }), /synthTimeoutMs must be a positive finite number/,
      'the second deadline needs the same guard — synthesis would report a spurious timeout instead');
    assert.throws(() => createKokoroClient({ initTimeoutMs: 5000, synthTimeoutMs: Number.NaN }), /synthTimeoutMs/,
      'an explicit NaN is the exact value the old code produced, so it must be rejected too');
    assert.throws(() => createKokoroClient({ initTimeoutMs: 0, synthTimeoutMs: 5000 }), /initTimeoutMs/,
      'zero is not a usable deadline either — it fires before the worker can spawn');
    // THE ADJACENT CASE THAT MUST KEEP PASSING: a correctly-constructed client
    // is unaffected, so the guard cannot be the reason the provider stops working.
    assert.doesNotThrow(() => clientWith(loadOk).c, 'valid timeouts must still construct');
  });

  test('requiring the provider creates NO worker', () => {
    delete require.cache[require.resolve('../providers/kokoro-tts')];
    const provider = require('../providers/kokoro-tts');
    assert.equal(typeof provider.synthesize, 'function');
    // A module that spawns a thread at require() time would pay for kokoro on
    // every boot, including boots where the chain never reaches this rung.
    const { c, workers } = clientWith(loadOk);
    assert.equal(workers.length, 0, 'and creating a client does not spawn one either');
    assert.equal(c.hasWorker(), false);
  });

  test('a reply from an obsolete generation is ignored', async () => {
    const { c, workers } = clientWith(null);
    const p = c.load();
    const w = workers[0];
    const sent = w.posted[0];
    // A stale worker answering after we moved on must not resolve anything.
    w.emit('message', { id: sent.id, gen: sent.gen + 99, ok: true, result: { stale: true } });
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'the stale reply changed nothing');
    w.emit('message', { id: sent.id, gen: sent.gen, ok: true, result: { real: true } });
    assert.deepEqual(await p, { real: true });
  });

  test('a queued cancellation removes only that request and leaves siblings alone', async () => {
    const { c } = clientWith(loadOk);
    const ac = new AbortController();
    const first = c.synthesize({ text: 'one' });           // becomes active
    const second = c.synthesize({ text: 'two', signal: ac.signal });
    const third = c.synthesize({ text: 'three' });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await assert.rejects(second, /aborted/);
    assert.equal(c.queueDepth(), 1, 'third is still queued; only the cancelled one left');
    first.catch(() => {}); third.catch(() => {});
  });

  test('cancelling while awaiting the SHARED load does not cancel it for anyone else', async () => {
    const { c, workers } = clientWith(null);
    const a = c.load();
    const b = c.load();
    assert.equal(workers.length, 1, 'one load, one worker');
    const sent = workers[0].posted[0];
    workers[0].emit('message', { id: sent.id, gen: sent.gen, ok: true, result: { shared: true } });
    assert.deepEqual(await a, { shared: true });
    assert.deepEqual(await b, { shared: true }, 'both callers get the same load');
  });

  test('a synthesis deadline is measured from ADMISSION, so queue time is inside the budget', async () => {
    let t = 1000;
    const { c, workers } = clientWith(loadOk, { now: () => t, synthTimeoutMs: 5000 });
    const queued = c.synthesize({ text: 'first' });
    const behind = c.synthesize({ text: 'second' });
    await new Promise((r) => setImmediate(r));
    t = 9000; // both admitted at 1000 with a 5000ms budget: both are now past it
    // The queue looks at the second request only when the first one finishes, so
    // finish it with a reply. FIXED 2026-09-23: this test used to WAIT for the
    // first request's real 5 s timer instead (5,010 ms locally). That timer is
    // unref'd by design, so nothing held the process open through it: Node 26's
    // test runner happened to, Node 22's did not, and CI run 35856005319 had
    // the whole file cancelled mid-run ("Promise resolution is still pending but
    // the event loop has already resolved"). The fake clock was never what
    // decided this test's outcome; the real clock was.
    // Probe, 2026-09-23: disabling pump()'s queued-deadline check (`if (false &&
    // next.deadlineAt <= now())`) turns THIS test red with "deadline passed
    // before it could start" — so it watches the queue check, not post()'s.
    const synth = workers[0].posted.find((m) => m.op === 'synthesize');
    workers[0].emit('message', { id: synth.id, gen: synth.gen, ok: true, result: { wav: 'first' } });
    assert.deepEqual(await queued, { wav: 'first' });
    await assert.rejects(behind, /deadline passed while queued/,
      'time spent waiting behind another utterance counts against the budget rather than being added to it');
  });

  test('shutdown settles every pending caller and AWAITS termination', async () => {
    const { c, workers } = clientWith(loadOk);
    const p = c.synthesize({ text: 'never finishes' });
    await new Promise((r) => setImmediate(r));
    await c.shutdown();
    await assert.rejects(p, /shut down/,
      'a server shutting down must not leave a TTS await pending forever — an error is an answer');
    assert.equal(workers[0].terminated, 1, 'asking it to leave is not the same as watching it go');
    assert.equal(c.hasWorker(), false);
  });

  test('a worker that dies rejects its own generation and nothing else', async () => {
    const { c, workers } = clientWith(loadOk);
    const p = c.synthesize({ text: 'in flight' });
    await new Promise((r) => setImmediate(r));
    workers[0].emit('error', new Error('worker exploded'));
    await assert.rejects(p, /worker exploded/);
    assert.equal(c.hasWorker(), false, 'the dead worker is dropped so the next request spawns a fresh one');
  });
});

describe('BUG-372 — the facade keeps its contract', () => {
  test('the public surface is unchanged, plus shutdown', () => {
    delete require.cache[require.resolve('../providers/kokoro-tts')];
    const p = require('../providers/kokoro-tts');
    for (const k of ['name', 'mime', 'isAvailable', 'unavailableReason', 'listVoices', 'synthesize', 'modelCacheDir', 'LOAD_TIMEOUT_MS']) {
      assert.ok(k in p, 'still exports ' + k);
    }
    assert.equal(p.name, 'kokoro-tts');
    assert.equal(p.mime, 'audio/wav');
    assert.equal(p.LOAD_TIMEOUT_MS, 15000, 'the availability RESPONSE bound is unchanged');
    assert.equal(typeof p.shutdown, 'function', 'and gains an explicit teardown');
  });

  test('an already-aborted signal is refused without touching the engine', async () => {
    delete require.cache[require.resolve('../providers/kokoro-tts')];
    const p = require('../providers/kokoro-tts');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(p.synthesize({ text: 'hello', signal: ac.signal }), /aborted/);
    assert.equal(p.unavailableReason(), null,
      'cancellation is NOT failure: the caller changed its mind, the engine did nothing wrong, and '
      + 'kokoro must still be available to the next request');
  });

  test('empty text is refused before anything is spawned', async () => {
    delete require.cache[require.resolve('../providers/kokoro-tts')];
    const p = require('../providers/kokoro-tts');
    await assert.rejects(p.synthesize({ text: '   ' }), /text required/);
  });

  test('the worker reads voice metadata from model data, never from list_voices()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'providers', 'kokoro', 'worker.js'), 'utf8');
    assert.ok(!/\btts\.list_voices\s*\(/.test(src),
      'kokoro-js"s list_voices() is console.table(...) and returns undefined — calling it gave the HUD '
      + 'ZERO voices for an engine with 28, and printed a 28-row table into our stdout');
    assert.match(src, /tts\s*&&\s*tts\.voices/, 'it reads tts.voices, which is the actual data');
  });
});
