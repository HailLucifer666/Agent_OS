'use strict';

// test/electron-builder-icon.test.js — the installer shipped the DEFAULT
// ELECTRON ICON, and nothing anywhere said so.
//
// electron-builder resolves `build.icon` (default `build/icon.ico`) at build
// time. When that file is absent it does NOT fail — it silently falls back to
// Electron's own icon, so `npm run dist` produces a 298MB installer wearing
// somebody else's logo and exits 0. That is the same silent-fallback shape as
// the missing-ad-blocker bug (BUG-115) and the wakeword models: an absent asset
// degrades into a plausible-looking wrong result instead of an error.
//
// So this asserts the asset EXISTS and is structurally a real multi-size ICO,
// not merely that a config key is present. `build/` is deliberately NOT
// gitignored (only `/dist/` is), so the icon is tracked and a fresh clone
// builds with the real one — an icon that only exists on one machine would
// reproduce the original bug for everybody else.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function loadBuildConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build, 'package.json must have a top-level "build" block');
  return pkg.build;
}

// Minimal ICONDIR/ICONDIRENTRY reader — the container format is 6 bytes of
// header then 16 bytes per entry, so a real parse is cheaper than a dependency.
// Width/height of 0 means 256 (the field is a single byte, so 256 does not fit).
function parseIco(buf) {
  assert.ok(buf.length > 6, 'icon file is too small to be an ICO');
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    entries.push({
      width: buf[off] === 0 ? 256 : buf[off],
      height: buf[off + 1] === 0 ? 256 : buf[off + 1],
      bitCount: buf.readUInt16LE(off + 6),
      bytesInRes: buf.readUInt32LE(off + 8),
      imageOffset: buf.readUInt32LE(off + 12),
    });
  }
  return { reserved, type, count, entries };
}

test('build.icon is configured explicitly, not left to electron-builder\'s silent default', () => {
  const build = loadBuildConfig();
  assert.equal(typeof build.icon, 'string',
    'build.icon must be set explicitly — relying on the implicit build/icon.ico default is how a missing icon goes unnoticed');
  assert.ok(build.icon.endsWith('.ico'), 'a Windows nsis target needs an .ico, got ' + build.icon);
});

test('the configured icon file actually exists on disk (an absent icon silently ships Electron\'s own)', () => {
  const build = loadBuildConfig();
  const target = path.join(REPO_ROOT, build.icon);
  assert.ok(fs.existsSync(target), 'build.icon points at a file that does not exist: ' + target);
});

test('the icon is tracked in git, so a fresh clone does not rebuild with the default', () => {
  // Not a git query — an assertion about the ignore rules that would make the
  // asset invisible. `/dist/` is ignored; `build/` must not be.
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  const ignoresBuildDir = gitignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === 'build' || l === 'build/' || l === '/build' || l === '/build/');
  assert.equal(ignoresBuildDir, false,
    '.gitignore must not ignore build/ — a gitignored icon exists only on the machine that made it');
});

test('the icon is a structurally valid ICO', () => {
  const build = loadBuildConfig();
  const buf = fs.readFileSync(path.join(REPO_ROOT, build.icon));
  const ico = parseIco(buf);
  assert.equal(ico.reserved, 0, 'ICONDIR reserved field must be 0');
  assert.equal(ico.type, 1, 'ICONDIR type must be 1 (icon, not cursor)');
  assert.ok(ico.count > 0, 'ICO declares no images');
  for (const e of ico.entries) {
    assert.ok(e.imageOffset + e.bytesInRes <= buf.length,
      `entry ${e.width}x${e.height} points past the end of the file — truncated or mis-encoded`);
  }
});

test('the icon carries a 256x256 image — electron-builder requires it and Windows uses it for large views', () => {
  const build = loadBuildConfig();
  const ico = parseIco(fs.readFileSync(path.join(REPO_ROOT, build.icon)));
  assert.ok(ico.entries.some((e) => e.width === 256 && e.height === 256),
    'no 256x256 entry; electron-builder rejects icons below 256x256');
});

test('the icon is multi-size, so the taskbar and tray do not downscale one bitmap', () => {
  const build = loadBuildConfig();
  const ico = parseIco(fs.readFileSync(path.join(REPO_ROOT, build.icon)));
  const sizes = ico.entries.map((e) => e.width).sort((a, b) => a - b);
  for (const needed of [16, 32, 48, 256]) {
    assert.ok(sizes.includes(needed),
      `missing the ${needed}px entry — Windows would scale a larger one and it reads as mush at small sizes (have: ${sizes.join(', ')})`);
  }
});

test('the icon is reproducible — the generator that made it is in the repo', () => {
  // The asset is a binary blob nobody can diff. Without its generator tracked
  // beside it, a future change means hand-editing a binary or reverting to the
  // default, which is the bug this file exists to prevent.
  const gen = path.join(REPO_ROOT, 'mythos', 'scripts', 'make-icon.js');
  assert.ok(fs.existsSync(gen), 'mythos/scripts/make-icon.js must exist so build/icon.ico can be regenerated');
});
