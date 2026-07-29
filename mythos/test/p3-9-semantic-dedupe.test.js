'use strict';

// REMEDIATION P3-9 (2026-07-29 audit): semantic.write()'s append-mode dedupe
// compared facts by exact string match after trim/lowercase only, so
// "The operator really enjoys playing jazz piano" and the same sentence with
// a trailing period were treated as two different facts — confirmed as the
// literal duplicate in Semantic/user-facts.md. Dedupe now also strips
// trailing punctuation before comparing.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createSemanticStore } = require('../src/core/memory/semantic');

describe('P3-9: semantic.write() dedupe ignores trailing punctuation', () => {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const semantic = createSemanticStore({ fs, config: {}, bus: fakeBus(), logger: { warn() {} } });

  after(() => cleanupVaultDir(dir));

  it('does not duplicate a fact that only differs by a trailing period', () => {
    semantic.write('user-facts', ['The operator really enjoys playing jazz piano'], { confidence: 0.9, append: true, sources: ['voice-explicit'] });
    semantic.write('user-facts', ['The operator really enjoys playing jazz piano.'], { confidence: 0.9, append: true, sources: ['voice-explicit'] });

    const raw = fs.readText('Semantic/user-facts.md', '');
    const jazzLines = (raw.match(/jazz piano/gi) || []).length;
    assert.equal(jazzLines, 1, 'the same fact restated with a trailing period must not duplicate');
  });

  it('still allows two genuinely different facts', () => {
    semantic.write('user-facts', ['The operator likes tea'], { confidence: 0.9, append: true, sources: ['voice-explicit'] });
    semantic.write('user-facts', ['The operator dislikes coffee'], { confidence: 0.9, append: true, sources: ['voice-explicit'] });

    const raw = fs.readText('Semantic/user-facts.md', '');
    assert.match(raw, /likes tea/);
    assert.match(raw, /dislikes coffee/);
  });
});
