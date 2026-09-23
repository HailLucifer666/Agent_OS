'use strict';

// verify-packaged-kokoro.js — does Kokoro actually resolve and speak from a
// PACKAGED build?
//
// WHY A SECOND VERIFIER. `verify-kokoro-offline.js` proves the migrated cache is
// self-sufficient; it runs from the source tree, where every path is an ordinary
// directory. That cannot see the thing most likely to break here: the worker is
// spawned by `worker_threads` from a path inside `app.asar.unpacked`, and it
// resolves `@huggingface/transformers` through kokoro-js's own `createRequire`
// context. Module resolution is exactly what BUG-372 was — a second nested copy
// nobody noticed — so a packaged build needs its own check rather than an
// inference from a green unit suite.
//
// This repo has the receipt for why: Slice 5 shipped 2,598 green tests over an
// Electron shell that would not start at all. A suite cannot tell you the app
// boots, and it cannot tell you a worker resolves under asar.
//
// USAGE, from a built app (`electron-builder --win --dir` is enough — the asar
// and the unpacked layout are identical to the installer's):
//
//   ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/MYTHOS.exe \
//     mythos/scripts/verify-packaged-kokoro.js dist/win-unpacked/resources
//
// Run it with the PACKAGED binary, not with `node`. Under `node` the check is
// vacuous: it would load the source tree's modules and prove nothing about the
// package.
//
// WHAT IT ASSERTS, and why each one is not redundant:
//   1. The five kokoro modules exist under app.asar.unpacked. Cheap, and it
//      separates "packaging dropped the files" from "the files are there and the
//      loader failed" — two failures with completely different fixes.
//   2. listVoices() returns a non-empty list. This forces a real worker spawn
//      and model load, so it is the resolution check. It also returned ZERO for
//      an engine with 28 before this fix, so a non-empty result is a regression
//      check on its own.
//   3. synthesize() returns a Buffer of plausible size. Note the LAYER: the
//      worker transfers an owned ArrayBuffer (worker.js), and the facade wraps
//      it with `Buffer.from(r.audio)` (kokoro-tts.js), so Buffer is the public
//      contract and ArrayBuffer is the internal one. A first draft of this
//      script asserted ArrayBuffer here and failed against working code —
//      because the throwaway probe it was derived from read `result.buffer`,
//      which on a Buffer is its BACKING ArrayBuffer rather than the result
//      itself. The probe was measuring one layer down and reporting it as the
//      public type. Left recorded because a check that asserts the wrong layer
//      passes for years and then fires on a correct refactor.
//   4. Zero network calls. Counted, not blocked — the question is whether a
//      packaged load reaches the network, and patching connect() to throw would
//      answer a different question.
//   5. The resolved cache directory is REPORTED, never assumed. Under a real GUI
//      boot electron/main.js injects MYTHOS_MODELS_DIR=<userData>/models, so the
//      cache belongs in userData; run as bare node with no such env, the
//      resolver correctly falls back to the install tree. Those are different
//      directories and the run must say which one it used, or a pass here would
//      hide a build that writes 92 MB under Program Files.
//
// WHAT IT DOES NOT PROVE. Not that the audio sounds right, not that the Electron
// GUI starts, not that the Live path speaks. Those need a person. This closes
// the half that does not.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');

const MODULES = ['client.js', 'worker.js', 'paths.js', 'timeouts.js', 'migrate-cache.js'];
// A WAV of a short sentence is tens of kilobytes. Anything under this is a
// header with no audio behind it, which is the shape a silent failure takes.
const MIN_PLAUSIBLE_AUDIO_BYTES = 10000;

function fail(report, message) {
  report.ok = false;
  report.failures.push(message);
}

async function main() {
  const resources = process.argv[2];
  const report = { ok: true, failures: [], resources, network: [] };
  if (!resources) {
    console.error('usage: ELECTRON_RUN_AS_NODE=1 <packaged app>.exe verify-packaged-kokoro.js <resourcesDir>');
    process.exit(2);
  }

  const unpacked = path.join(path.resolve(resources), 'app.asar.unpacked', 'mythos');
  report.unpacked = unpacked;
  report.ranUnderElectron = Boolean(process.versions.electron);
  if (!report.ranUnderElectron) {
    fail(report, 'not running under the packaged Electron binary — set ELECTRON_RUN_AS_NODE=1 and run the app exe, '
      + 'or this check loads the source tree and proves nothing about the package');
  }

  // (1) the modules survived packaging
  report.modules = {};
  for (const m of MODULES) {
    const p = path.join(unpacked, 'providers', 'kokoro', m);
    const present = fs.existsSync(p);
    report.modules[m] = present;
    if (!present) fail(report, `providers/kokoro/${m} is missing from app.asar.unpacked — check build.files and asarUnpack`);
  }
  if (!report.ok) { console.log(JSON.stringify(report, null, 1)); process.exit(1); }

  // (4) count network, do not block it
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(...args) {
    try {
      const a = args[0];
      report.network.push(typeof a === 'object' ? `${a.host || a.path || '?'}:${a.port || ''}` : String(a));
    } catch (_) { report.network.push('unknown'); }
    return realConnect.apply(this, args);
  };
  const realLookup = dns.lookup;
  dns.lookup = function patched(hostname, ...rest) {
    report.network.push(`dns:${hostname}`);
    return realLookup.call(dns, hostname, ...rest);
  };

  const tts = require(path.join(unpacked, 'providers', 'kokoro-tts.js'));

  // (5) say which directory was used — never assume
  report.modelCacheDir = typeof tts.modelCacheDir === 'function' ? tts.modelCacheDir() : String(tts.modelCacheDir);
  report.modelCacheDirExists = fs.existsSync(report.modelCacheDir);
  report.insideInstallTree = path.resolve(report.modelCacheDir).startsWith(path.resolve(resources));
  report.modelsDirEnv = process.env.MYTHOS_MODELS_DIR || null;
  if (report.insideInstallTree && !report.modelsDirEnv) {
    // Not a failure — it is the documented fallback when no userData is
    // signalled, which is exactly the state of a bare ELECTRON_RUN_AS_NODE run.
    // But an INSTALLED build under Program Files would not be writable here, so
    // the run has to say so out loud rather than pass quietly.
    report.note = 'cache resolved INSIDE the install tree because MYTHOS_MODELS_DIR was not set. A real GUI boot '
      + 'sets it to <userData>/models (electron/main.js). Re-run with it set to check the path a user actually gets.';
  }

  // (6) THE BUG-372 INVARIANT, and the reason the other checks are not enough.
  //
  // Added after a mutation SURVIVED: with kokoro-js's nested transformers copy
  // removed, every other check still passed, because `createRequire` walked up
  // and found the hoisted copy. That is correct behaviour — `legacyCacheDirs()`
  // derives the location rather than hardcoding it, exactly so npm re-hoisting
  // cannot break it — but it means "it loaded" says nothing about WHICH instance
  // loaded, and a second instance nobody noticed IS BUG-372.
  //
  // The invariant that actually broke back then: the cacheDir was set on one
  // transformers instance and the model was loaded through another, so the
  // configured directory was never created and 92 MB went somewhere else. Ask
  // the worker which instance it resolved and where that instance is caching,
  // and compare it to the directory this provider claims to use. If those two
  // ever disagree again, this fires.
  const { createKokoroClient } = require(path.join(unpacked, 'providers', 'kokoro', 'client.js'));
  // Timeouts come from the same resolver the facade uses. Constructing the
  // client without them used to yield a NaN deadline that setTimeout clamped to
  // 1 ms, reporting a "load timeout" that looked like a broken worker; the
  // client now refuses that at construction, and this is the correct usage.
  const { resolveTimeouts } = require(path.join(unpacked, 'providers', 'kokoro', 'timeouts.js'));
  const t = resolveTimeouts(process.env);
  if (!t.ok) {
    fail(report, `kokoro timeouts did not resolve: ${t.reason}`);
    console.log(JSON.stringify(report, null, 1));
    process.exit(1);
  }
  const client = createKokoroClient({ env: process.env, initTimeoutMs: t.initMs, synthTimeoutMs: t.synthMs });
  await client.load();
  const meta = client.meta() || {};
  report.resolved = {
    kokoroEntry: meta.kokoroEntry || null,
    transformersEntry: meta.transformersEntry || null,
    workerCacheDir: meta.cacheDir || null,
  };
  report.transformersIsNested = Boolean(meta.transformersEntry && meta.transformersEntry.includes(`kokoro-js${path.sep}node_modules`));
  if (!meta.transformersEntry) {
    fail(report, 'the worker did not report which @huggingface/transformers it resolved — without that, a pass here '
      + 'cannot distinguish one instance from two, which is the whole of BUG-372');
  } else if (meta.cacheDir && path.resolve(meta.cacheDir) !== path.resolve(report.modelCacheDir)) {
    fail(report, `the transformers instance that LOADS is caching in ${meta.cacheDir}, but this provider reports `
      + `${report.modelCacheDir}. That split is BUG-372 exactly: a configured directory nothing loads from.`);
  }
  await client.shutdown();

  // (2) resolution: a worker spawn and a model load
  const voices = await tts.listVoices();
  report.voiceCount = Array.isArray(voices) ? voices.length : null;
  if (!report.voiceCount) {
    fail(report, `listVoices() returned ${JSON.stringify(voices)} — the worker did not load the model, which is the `
      + 'packaged resolution failure this script exists to catch');
  }

  // (3) it actually synthesizes, and the transfer contract holds
  const started = Date.now();
  const audio = await tts.synthesize({ text: 'Packaged resolution check.' });
  report.synthMs = Date.now() - started;
  report.audioType = audio && audio.constructor ? audio.constructor.name : typeof audio;
  report.audioBytes = (audio && (audio.length || audio.byteLength)) || 0;
  if (!Buffer.isBuffer(audio)) {
    fail(report, `synthesize() returned ${report.audioType}, expected Buffer — the facade wraps the worker's `
      + 'transferred ArrayBuffer with Buffer.from, and every caller reads it as a Buffer');
  }
  if (report.audioBytes < MIN_PLAUSIBLE_AUDIO_BYTES) {
    fail(report, `synthesize() returned ${report.audioBytes} bytes, under the ${MIN_PLAUSIBLE_AUDIO_BYTES} floor — a `
      + 'header with no audio behind it is what a silent failure looks like');
  }

  if (typeof tts.shutdown === 'function') await tts.shutdown();

  report.networkCallCount = report.network.length;
  report.network = [...new Set(report.network)].slice(0, 10);
  if (report.networkCallCount > 0) {
    fail(report, `${report.networkCallCount} network call(s) during a cached load — the packaged build is downloading `
      + 'weights it should already have');
  }

  console.log(JSON.stringify(report, null, 1));
  if (!report.ok) {
    console.error(`\nFAIL (${report.failures.length}):`);
    for (const f of report.failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.error(`\nPASS — ${report.voiceCount} voices, ${report.audioBytes} bytes in ${report.synthMs}ms, `
    + `${report.networkCallCount} network calls, cache at ${report.modelCacheDir}`);
}

main().catch((err) => {
  console.error('verify-packaged-kokoro: threw');
  console.error((err && err.stack) || err);
  process.exit(1);
});
