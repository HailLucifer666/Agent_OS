'use strict';

// BUG-080 — Stage 6 of 7, item #18. Real vault evidence (2026-07-31/08-01):
// Semantic/user-facts.md contained "The user's name is Alex" (mined from
// MYTHOS's OWN typed Notepad probe text, "Hi Alex, this is Mythos"), "the
// user will call me 'Eve'", and "operator really enjoys playing jazz piano"
// (an inference written right after a "soft jazz" query, never a stated
// fact) — all contradicting Identity/operator-profile.txt's "Address them
// with 'Sir'". from-memory.js's remember() tool already quarantines identity
// claims; memory/index.js's automatic conversation-distillation loop does
// not. One guard inside semantic.write() itself closes the gap for every
// caller, present and future.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createSemanticStore } = require('../src/core/memory/semantic');

describe('BUG-080: semantic.write() quarantines identity claims it cannot confirm', () => {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const semantic = createSemanticStore({ fs, config: {}, bus, logger: { warn() {} } });

  after(() => cleanupVaultDir(dir));

  it('THE RECORDED CASE: "The user\'s name is Alex", written the way the distillation loop actually writes it (no voice-explicit source), is quarantined to low confidence', () => {
    // This mirrors memory/index.js's 3b distillation call exactly:
    // semantic.write('user-facts', [fact], { confidence: 0.7, append: true })
    // — no sources array at all, because it was never something the operator
    // said out loud; it was mined from mixed conversation text.
    semantic.write('user-facts', ["The user's name is Alex"], { confidence: 0.7, append: true });
    const raw = fs.readText('Semantic/user-facts.md', '');
    const sidecarMatch = raw.match(/<!--\s*(\{[^}]+\})\s*-->/);
    assert.ok(sidecarMatch, 'sidecar must exist');
    const sidecar = JSON.parse(sidecarMatch[1]);
    assert.ok(sidecar.confidence <= 0.2, 'an unconfirmed identity claim must be quarantined, not trusted at 0.7');
    assert.ok(bus._emitted().some((e) => e.type === 'health.anomaly' && e.payload.kind === 'semantic-identity-claim-quarantined'),
      'the quarantine must be observable, not silent');
  });

  it('THE RECORDED CASE: "the user will call me \'Eve\'" is quarantined the same way', () => {
    semantic.write('user-facts', ["the user will call me 'Eve'"], { confidence: 0.7, append: true });
    const raw = fs.readText('Semantic/user-facts.md', '');
    const sidecar = JSON.parse(raw.match(/<!--\s*(\{[^}]+\})\s*-->/)[1]);
    assert.ok(sidecar.confidence <= 0.2);
  });

  it('a genuinely confirmed operator utterance (voice-explicit, no contradiction on file) is NOT quarantined', () => {
    semantic.write('user-facts-2', ['my name is Jordan'], { confidence: 0.7, append: true, sources: ['voice-explicit'] });
    const raw = fs.readText('Semantic/user-facts-2.md', '');
    const sidecar = JSON.parse(raw.match(/<!--\s*(\{[^}]+\})\s*-->/)[1]);
    assert.equal(sidecar.confidence, 0.7, 'a confirmed operator utterance with nothing on file to contradict must NOT be downgraded');
  });

  it('a confirmed utterance that CONTRADICTS Identity/operator-profile.txt is still quarantined', () => {
    fs.writeText('Identity/operator-profile.txt', "Address them with 'Sir'. Their name is Arghya.");
    semantic.write('user-facts-3', ['my name is Eve'], { confidence: 0.7, append: true, sources: ['voice-explicit'] });
    const raw = fs.readText('Semantic/user-facts-3.md', '');
    const sidecar = JSON.parse(raw.match(/<!--\s*(\{[^}]+\})\s*-->/)[1]);
    assert.ok(sidecar.confidence <= 0.2, 'contradicting the identity file on record must quarantine even a "confirmed" source');
  });

  it('a non-identity fact is completely unaffected', () => {
    semantic.write('user-facts-4', ['The operator likes tea'], { confidence: 0.9, append: true, sources: ['voice-explicit'] });
    const raw = fs.readText('Semantic/user-facts-4.md', '');
    const sidecar = JSON.parse(raw.match(/<!--\s*(\{[^}]+\})\s*-->/)[1]);
    assert.equal(sidecar.confidence, 0.9);
  });
});
