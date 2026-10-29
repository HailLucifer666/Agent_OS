'use strict';

// providers/kokoro/paths.js — where the Kokoro weights are, and where they were.
//
// THE DEFECT THIS EXISTS TO FIX, MEASURED 2026-09-11.
//
// `providers/kokoro-tts.js` did this:
//
//     const { env } = await import('@huggingface/transformers');
//     env.cacheDir = modelDir;                       // mythos/models/kokoro
//     const { KokoroTTS } = await import('kokoro-js');
//     return KokoroTTS.from_pretrained(modelId, …);
//
// and it configured a module nothing loads from. Resolved on this machine:
//
//   from providers/   @huggingface/transformers -> mythos/node_modules/@huggingface/transformers          (4.2.0 at the fix; re-verified 4.3.2, 2026-10-29, same hoisted position)
//   from kokoro-js/   @huggingface/transformers -> mythos/node_modules/kokoro-js/node_modules/@huggingface/transformers (3.8.1)
//
// kokoro-js pins `^3.5.1`, so npm nested a second copy. The provider set
// `cacheDir` on the HOISTED 4.2.0 instance; `from_pretrained` loads through the
// NESTED 3.8.1 one, whose `cacheDir` nobody touched. **`KOKORO_MODEL_DIR` did
// nothing.** The proof is on disk: a 92,361,116-byte `model_quantized.onnx`
// sitting in the nested instance's default cache while `mythos/models/kokoro` —
// the directory `modelCacheDir()` names and `doctor.js` reports on — had never
// been created at all.
//
// The control experiment is one file away. `providers/local-whisper-stt.js`
// writes the identical two lines but calls `pipeline()` on the SAME instance it
// configured, and its cache landed exactly where it was told
// (`mythos/models/whisper/onnx-community/whisper-base/`, present on disk).
//
// Two consequences worth stating separately, because they have different fixes:
//   * The real cache lives under `node_modules/`, which `npm install` owns. A
//     fresh clone or a `npm ci` DELETES 92 MB of weights, and the next boot
//     re-downloads them. That is what `legacyCacheDirs()` + the migration are for.
//   * `test/electron-builder-files-allowlist.test.js` deliberately excludes that
//     path from the installer, so a packaged build has never shipped with
//     weights and would try to write them under Program Files.
//
// AND THE INFERENCE THAT MUST NOT BE MADE. An empty `mythos/models/kokoro` is
// NOT evidence that every boot downloads. Measured: with that directory absent,
// an OFFLINE load (HF_HUB_OFFLINE=1) succeeded in 1488 ms and downloaded zero
// bytes, because the weights were somewhere else entirely.

const fs = require('node:fs');
const path = require('node:path');
const { userDataModelsDir } = require('../../src/core/setup/model-paths');

// The one place the canonical location is decided. Exported so doctor.js and the
// loader share it — BUG-360 is the bill for the alternative, where a report and
// a runtime resolved the same asset differently and the report was green about a
// directory nothing loaded from.
//
// DELIBERATELY NOT `modelWriteDir('kokoro')`, even though that is the shared
// resolver. Its no-userData fallback is INSTALL_TREE_MODELS_DIR
// (`mythos/ui/public/models`), which electron-builder's `files` excludes
// wholesale and which is the home of the CC BY-NC-SA wake-word weights. Adopting
// it would put a dev cache somewhere the installer refuses to ship and the
// licensing gate cares about. The userData half is shared; only the fallback
// differs, and it differs on purpose.
function resolveKokoroModelDir(env) {
  const e = env || process.env;
  if (e.KOKORO_MODEL_DIR && String(e.KOKORO_MODEL_DIR).trim()) return path.resolve(String(e.KOKORO_MODEL_DIR).trim());
  const userData = userDataModelsDir(e);
  if (userData) return path.join(userData, 'kokoro');
  return path.join(__dirname, '..', '..', 'models', 'kokoro');
}

// DERIVED, NEVER HARDCODED. The legacy directory is wherever the transformers
// instance that kokoro-js ACTUALLY resolves keeps its default cache. Hardcoding
// `node_modules/kokoro-js/node_modules/...` would go stale the first time npm
// hoists differently — and npm's hoisting is exactly the thing that created this
// bug. Returns [] when kokoro-js is not installed, which is a normal state (the
// provider is optional) and not an error.
function legacyCacheDirs(env) {
  const out = [];
  try {
    const kokoroEntry = require.resolve('kokoro-js');
    const kreq = require('node:module').createRequire(kokoroEntry);
    const transformersEntry = kreq.resolve('@huggingface/transformers');
    // transformers' own default is `<package root>/.cache/`. Derive the package
    // root by walking up from the resolved entry to the directory holding its
    // package.json, rather than assuming a dist/ depth.
    let dir = path.dirname(transformersEntry);
    for (let i = 0; i < 8; i += 1) {
      if (fs.existsSync(path.join(dir, 'package.json'))) { out.push(path.join(dir, '.cache')); break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch (_) { /* kokoro-js absent: no legacy cache to migrate, which is fine */ }
  // A previously-configured explicit dir is never "legacy" — if the operator set
  // KOKORO_MODEL_DIR we do not go looking elsewhere at all.
  const e = env || process.env;
  if (e.KOKORO_MODEL_DIR && String(e.KOKORO_MODEL_DIR).trim()) return [];
  return out.filter((d) => {
    try { return fs.existsSync(d); } catch (_) { return false; }
  });
}

// Does this directory hold a usable-looking model for `modelId`? ASSET PRESENCE
// ONLY — this answers "are there weights on disk", never "does the model load"
// and never "does it speak". doctor.js must say which of the three it measured,
// because BUG-372's whole history is a row that reported one and was read as
// another.
//
// The layout is `<cacheDir>/<org>/<repo>/…` — verified on disk 2026-09-11
// against transformers 3.8.1. It is NOT the Hugging Face hub's
// `models--<org>--<repo>` shape; a check written for that finds nothing here.
function hasWeights(dir, modelId) {
  const root = path.join(dir, ...String(modelId || '').split('/'));
  let found = null;
  const walk = (d, depth) => {
    if (found || depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.name.endsWith('.onnx')) {
        try { found = { file: full, bytes: fs.statSync(full).size }; } catch (_) { /* raced */ }
      }
    }
  };
  walk(root, 0);
  return found;
}

module.exports = { resolveKokoroModelDir, legacyCacheDirs, hasWeights };
