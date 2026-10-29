'use strict';

// vendor-mounts.js — version-keyed vendored runtime mounts (PR #165 audit,
// 2026-10-29, operator-selected for the mediapipe surface; the twin
// /vendor/onnxruntime keeps its hazard on record until its own bump).
//
// WHY THE VERSION IS IN THE URL: @mediapipe/tasks-vision is served 365d
// immutable, and its bytes change ONLY on a dependency bump — so on an
// unversioned URL that bump is invisible for up to a year, and per-URL cache
// eviction can even mix NEW js against OLD wasm (npm's atomic install is
// defeated by the cache, not by the install). Keying every paired URL on the
// installed version turns the whole fileset over atomically with the bump;
// camera.js learns the live version from the /vendor-versions endpoint below
// and never builds a URL itself.
//
// server/index.js must not grow (the file-size ratchet pins it), so this
// module owns the whole subsystem. Behaviour contract:
//   - missing or unreadable install: no mount, no gzip entry, the endpoint
//     answers `mediapipe: null` — the camera surfaces "unavailable" instead
//     of the boot dying for a camera-only dependency;
//   - the gzip entry is SPLICE IN FRONT of the catch-all root ('' prefix)
//     entry, because gzipTextAssets selects by FIRST match and would never
//     reach a versioned prefix appended after the catch-all;
//   - the endpoint is root-level and deliberately public like /health: it
//     discloses nothing a fetched asset URL doesn't already name, and
//     camera.js is a low-level module with no authed api wrapper.

const fs = require('fs');
const path = require('path');

function installVendorMounts(app, opts) {
  const { express, nodeModulesDir, gzipRoots, immutableHeaders, immutableMaxAge } = opts;
  const dir = path.join(nodeModulesDir, '@mediapipe', 'tasks-vision');
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch (_) { /* install absent or unreadable: degrade, never fail the boot */ }

  if (version) {
    const prefix = `/vendor/mediapipe@${version}`;
    const rootIdx = gzipRoots.findIndex((r) => r.prefix === ''); // the catch-all
    gzipRoots.splice(rootIdx >= 0 ? rootIdx : gzipRoots.length, 0, { prefix, dir, immutable: true });
    app.use(prefix, express.static(dir, {
      etag: true, lastModified: true, maxAge: immutableMaxAge, immutable: true, setHeaders: immutableHeaders,
    }));
  }

  app.get('/vendor-versions', (req, res) => { res.json({ mediapipe: version }); });
}

module.exports = { installVendorMounts };
