'use strict';

// README-vs-reality consistency pins (BUG-332, 2026-08-24).
//
// The Node badge claimed >=18 for its entire life while mythos/package.json
// engines requires >=22, and the README advertised "Node 20 Alpine + edge-tts"
// plus a "bundled edge-tts integration" while mythos/Dockerfile exists to
// state the opposite ("edge-tts is BYO — never bundled", LGPLv3 boundary).
// A downstream packager reading the README would have believed bundling was
// sanctioned. Both assertions are deliberately CROSS-FILE consistency checks:
// they compare README against package.json/Dockerfile rather than pinning
// hand-typed numbers, so ordinary content edits cannot silently rot them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');

function readRepoFile(relative) {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

test('the README node badge states the same major as package.json engines', () => {
  const readme = readRepoFile('README.md');
  const badge = readme.match(/badge\/node-(%3E%3C|%3E%3D|%3E)(\d+)/);
  assert.ok(badge, 'a node version badge exists in README.md');

  const pkg = JSON.parse(fs.readFileSync(path.join(MYTHOS_ROOT, 'package.json'), 'utf8'));
  const engineMajor = Number(String(pkg.engines.node).match(/(\d+)/)[1]);
  const badgeMajor = Number(badge[2]);
  assert.strictEqual(
    badgeMajor,
    engineMajor,
    `README node badge says >=${badgeMajor} but engines.node is "${pkg.engines.node}" — one of them is lying`
  );
});

test('no tracked doc calls edge-tts bundled while the Dockerfile disclaims bundling', () => {
  const dockerfile = fs.readFileSync(path.join(MYTHOS_ROOT, 'Dockerfile'), 'utf8');
  // Guard-the-guard: prove the forbidden patterns still match the strings they
  // were written for, so a future regex edit cannot make this test pass vacuously.
  assert.match('The bundled **edge-tts** integration', /bundled\s+\*\*edge-tts\*\*/i);
  assert.match('x Node 20 Alpine + edge-tts + zero build step', /Node 20 Alpine \+ edge-tts/);

  if (/never bundled/i.test(dockerfile)) {
    const readme = readRepoFile('README.md');
    assert.doesNotMatch(
      readme,
      /bundled\s+\*\*edge-tts\*\*/i,
      'README.md claims edge-tts is bundled while mythos/Dockerfile disclaims it'
    );
    assert.doesNotMatch(
      readme,
      /Node 20 Alpine \+ edge-tts/,
      'README.md advertises an image that ships edge-tts; the real image ships none'
    );
    assert.match(
      readme,
      /never bundled/i,
      'README.md must carry the BYO/never-bundled posture the Dockerfile declares'
    );
  }
});
