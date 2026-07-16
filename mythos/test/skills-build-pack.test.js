'use strict';

// Phase-3 Jarvis upgrade: vendored skills + essence injection for build lanes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const loader = require('../src/core/skills/loader');
const buildPack = require('../src/core/skills/build-pack');

describe('vendored skills (mythos/skills/)', () => {
  it('resolves repo-local skills before ~/.zcode', () => {
    for (const name of ['taste-frontend', 'ponytail', 'karpathy-guidelines', 'caveman']) {
      const p = loader._skillPath(name);
      assert.match(p.replace(/\\/g, '/'), /mythos\/skills\//, name + ' must resolve repo-local');
      const content = loader.loadContent(name);
      assert.ok(content && content.length > 200, name + ' SKILL.md must load');
    }
  });

  it('loads essences (SKILL-CORE.md) for every packed skill', () => {
    for (const name of ['taste-frontend', 'ponytail', 'karpathy-guidelines', 'caveman', 'ui-ux-pro-max']) {
      const e = loader.loadEssence(name);
      assert.ok(e && e.length > 100, name + ' essence must load');
      assert.ok(e.length < 4000, name + ' essence must stay small (free-model budget)');
    }
  });

  it('loadEssence returns null for unknown skills, never throws', () => {
    assert.equal(loader.loadEssence('does-not-exist'), null);
    assert.equal(loader.loadEssence(''), null);
  });
});

describe('build-pack classification + injection', () => {
  it('UI-shaped briefs get the UI pack', () => {
    assert.equal(buildPack.classifyDeliverable('Build a landing page for a coffee brand'), 'ui');
    assert.equal(buildPack.classifyDeliverable('redesign my portfolio website'), 'ui');
    const block = buildPack.packBlock('landing page for a SaaS');
    assert.match(block, /BUILD DISCIPLINE/);
    assert.match(block, /taste-frontend/);
    assert.match(block, /ui-ux-pro-max/);
  });

  it('code-shaped briefs get the code pack (default)', () => {
    assert.equal(buildPack.classifyDeliverable('write a CSV parser in python'), 'code');
    const block = buildPack.packBlock('write a CSV parser in python');
    assert.match(block, /ponytail/);
    assert.match(block, /karpathy-guidelines/);
    assert.doesNotMatch(block, /taste-frontend/);
  });

  it('packBlockFor accepts explicit kinds and falls back to code', () => {
    assert.match(buildPack.packBlockFor('ui'), /taste-frontend/);
    assert.match(buildPack.packBlockFor('code'), /ponytail/);
    assert.match(buildPack.packBlockFor('nonsense'), /ponytail/);
  });
});
