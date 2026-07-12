'use strict';

// memory-impact.eval.js — golden-set regression gate for recall quality.
// Run after adding new memory sources, skills, or providers to verify
// recall didn't regress. Uses deterministic fixtures (pinned timestamps)
// so scores are reproducible.
//
// Run: node --test test/eval/memory-impact.eval.js

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempVaultDir, cleanupVaultDir } = require('../helpers');
const { createFsStore } = require('../../src/core/memory/fs-store');
const { createEpisodicStore } = require('../../src/core/memory/episodic');
const { createSemanticStore } = require('../../src/core/memory/semantic');

function setupMemory() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = { emit: function() {} };
  const episodic = createEpisodicStore({ fs, bus });
  const semantic = createSemanticStore({ fs, bus });
  return { dir, fs, episodic, semantic };
}

describe('eval: memory-impact — episodic recall quality', () => {
  var mem;

  before(() => {
    mem = setupMemory();
    // Seed deterministic records with pinned timestamps
    var baseTs = Date.parse('2026-07-12T12:00:00Z');
    mem.episodic.write({ id: 'ep-1', ts: baseTs, kind: 'build', summary: 'Built AI news landing page with dark theme', detail: 'Used Mistral for generation, Cerebras for review', salience: 0.8, channel: 'pipeline' });
    mem.episodic.write({ id: 'ep-2', ts: baseTs - 86400000, kind: 'build', summary: 'Fixed voice microphone NotReadableError', detail: 'Dual getUserMedia conflict between mic-indicator and voice-loop', salience: 0.9, channel: 'fix' });
    mem.episodic.write({ id: 'ep-3', ts: baseTs - 3600000, kind: 'conversation', summary: 'Discussed agentic OS architecture patterns', detail: 'Risk classification, evidence validators, credential scanning', salience: 0.6, channel: 'voice' });
    mem.episodic.write({ id: 'ep-4', ts: baseTs - 7200000, kind: 'build', summary: 'Implemented Gmail OAuth adapter', detail: 'Google refresh token exchange for Gmail API', salience: 0.7, channel: 'pipeline' });
    mem.episodic.write({ id: 'ep-5', ts: baseTs - 172800000, kind: 'conversation', summary: 'User asked about weather in Kolkata', detail: 'Weather widget default location', salience: 0.3, channel: 'voice' });
  });

  after(() => { if (mem) cleanupVaultDir(mem.dir); });

  it('recall ranks AI news build first for "AI news" query', () => {
    var results = mem.episodic.recall('AI news landing page');
    assert.ok(results.length > 0, 'should have results');
    assert.equal(results[0].ref, 'ep-1', 'ep-1 (AI news build) should rank first');
  });

  it('recall ranks voice fix first for "microphone" query', () => {
    var results = mem.episodic.recall('microphone error voice');
    assert.ok(results.length > 0);
    assert.equal(results[0].ref, 'ep-2', 'ep-2 (voice fix) should rank first');
  });

  it('recall returns empty for completely unrelated query', () => {
    var results = mem.episodic.recall('quantum physics supernova');
    // Should return results but with very low scores, or empty
    // The key assertion: no high-salience false positives
    if (results.length > 0) {
      assert.ok(results[0].score < 0.3, 'unrelated query should not return high-score results');
    }
  });

  it('recall respects kind filter', () => {
    var results = mem.episodic.recall('build', { kind: 'build' });
    var allBuild = results.every(function(r) { return r.record.kind === 'build'; });
    assert.ok(allBuild, 'all results should have kind=build');
  });

  it('adding a new record does not regress existing recall order', () => {
    // Add a new record
    mem.episodic.write({ id: 'ep-6', ts: Date.now(), kind: 'build', summary: 'Refactored pipeline risk classifier', detail: 'Added tiny-fix quick-win feature architecture-change', salience: 0.5, channel: 'pipeline' });

    // Re-run the AI news query — ep-1 should STILL rank first
    var results = mem.episodic.recall('AI news landing page');
    assert.equal(results[0].ref, 'ep-1', 'ep-1 should still rank first after adding ep-6');
  });
});

describe('eval: memory-impact — semantic recall quality', () => {
  var mem;

  before(() => {
    mem = setupMemory();
    mem.semantic.write('voice-system', ['Voice loop captures audio and transcribes via Groq Whisper', 'Echo guard prevents MYTHOS hearing its own TTS output', 'Pre-roll ring buffer recovers first 1-3 words'], { confidence: 0.8, append: true });
    mem.semantic.write('build-pipeline', ['Pipeline stages: capture, human-gate, execute, shipped', 'Risk classifier scales gate rigor to change type', 'Evidence validator blocks ship on missing evidence'], { confidence: 0.9, append: true });
    mem.semantic.write('leash-system', ['Tier table maps tools to autonomy levels 0-4', 'Credential scanner denies T3/T4 calls with secrets in args'], { confidence: 0.7, append: true });
  });

  after(() => { if (mem) cleanupVaultDir(mem.dir); });

  it('semantic recall ranks voice-system first for "voice loop" query', () => {
    var results = mem.semantic.recall('voice loop audio transcription');
    assert.ok(results.length > 0);
    assert.ok(results[0].record.topic.includes('voice'), 'voice-system should rank first');
  });

  it('semantic recall ranks build-pipeline first for "pipeline stages" query', () => {
    var results = mem.semantic.recall('pipeline stages capture execute');
    assert.ok(results.length > 0);
    assert.ok(results[0].record.topic.includes('build') || results[0].record.topic.includes('pipeline'), 'build-pipeline should rank first');
  });

  it('semantic recall returns relevant facts in snippet', () => {
    var results = mem.semantic.recall('credential scanner tier');
    assert.ok(results.length > 0);
    var hasLeash = results.some(function(r) { return r.record.topic.includes('leash'); });
    assert.ok(hasLeash, 'leash-system should be in results for credential query');
  });
});
