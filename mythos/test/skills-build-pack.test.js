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

describe('build-pack: re-route by deliverable kind', () => {
  it('classifies the finer kinds, with UI winning outright', () => {
    assert.equal(buildPack.classifyDeliverable('research the competitive landscape for note apps'), 'research');
    assert.equal(buildPack.classifyDeliverable('write a report analysing Q3 churn'), 'research');
    assert.equal(buildPack.classifyDeliverable('threat model our OAuth flow'), 'security');
    assert.equal(buildPack.classifyDeliverable('pentest the payments endpoint'), 'security');
    assert.equal(buildPack.classifyDeliverable('build a full-stack todo backend with a database'), 'app');
    assert.equal(buildPack.classifyDeliverable('a cli tool that renames files'), 'app');
    // Precedence: a visual brief stays UI even when it mentions auth, and a
    // security audit of an API is security, not app.
    assert.equal(buildPack.classifyDeliverable('design a secure login screen with OAuth'), 'ui');
    assert.equal(buildPack.classifyDeliverable('security audit of our REST API'), 'security');
    // Default is unchanged.
    assert.equal(buildPack.classifyDeliverable('write a CSV parser in python'), 'code');
    assert.equal(buildPack.classifyDeliverable(''), 'code');
  });

  it('each new kind gets its own essence pack', () => {
    const app = buildPack.packBlockFor('app');
    assert.match(app, /ponytail/);
    assert.match(app, /systematic-debugging|root cause/i);
    assert.match(app, /verification|verify/i);
    // TDD is deliberately absent — a red→green loop is meaningless in one-shot
    // artifact generation.
    assert.doesNotMatch(app, /test-driven-development/);

    const sec = buildPack.packBlockFor('security');
    assert.match(sec, /strix/i);
    assert.match(sec, /ponytail/);

    const res = buildPack.packBlockFor('research');
    assert.match(res, /ponytail/);
    assert.match(res, /karpathy-guidelines/);
  });

  it('essences for the newly packed skills all load', () => {
    for (const name of ['systematic-debugging', 'verification-before-completion', 'strix-security']) {
      const e = loader.loadEssence(name);
      assert.ok(e && e.length > 100, name + ' essence must load (SKILL-CORE.md or SKILL.md head)');
    }
  });

  it('composed block honours the budget cap and names anything it drops', () => {
    for (const kind of ['ui', 'code', 'app', 'research', 'security']) {
      const block = buildPack.packBlockFor(kind);
      assert.ok(
        block.length <= buildPack._MAX_PACK_CHARS + 200,
        kind + ' block must stay within the prompt budget (got ' + block.length + ')'
      );
      // Nothing is dropped at today's sizes — but if it ever is, it must say so.
      if (/omitted for prompt budget/.test(block)) {
        assert.match(block, /omitted for prompt budget — \S/);
      }
    }
    // The cap is real: composing against a tiny cap drops essences, keeps the
    // highest-priority one, and names what it left out instead of shrinking
    // the discipline block silently.
    const squeezed = buildPack.packBlockFor('app', 2200);
    assert.ok(squeezed.length < buildPack.packBlockFor('app').length, 'a small cap must actually truncate');
    assert.match(squeezed, /omitted for prompt budget — .*verification-before-completion/);
    assert.match(squeezed, /ponytail/, 'the first pack entry must survive truncation');
  });

  it('the research route degrades to null when agent-reach is absent', async () => {
    const route = buildPack._ROUTES.research;
    assert.ok(route && typeof route.run === 'function', 'research route must exist');
    const available = await buildPack._agentReachAvailable();
    const out = await buildPack.resolveSkillTool('research the market for AI note takers');
    if (!available) {
      assert.equal(out, null, 'must return null, never throw, when agent-reach is not installed');
    } else {
      assert.ok(out === null || typeof out === 'string');
    }
  });

  it('the design-system slot only runs the UI route', async () => {
    // Non-UI briefs must not reach agent-reach through the design slot —
    // agent-actions already fetches social signals separately.
    assert.equal(await buildPack.resolveDesignSystemTool('research the market for AI note takers'), null);
    assert.equal(await buildPack.resolveDesignSystemTool('write a CSV parser in python'), null);
  });
});
