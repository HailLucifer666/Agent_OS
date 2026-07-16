'use strict';

// Phase-5 Jarvis upgrade: boot-generated capabilities manifest + self_capabilities tool.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const capabilities = require('../src/core/identity/capabilities');
const { buildTools } = require('../src/core/effectors/from-memory');

function fakeHub() {
  return {
    catalog() {
      return [
        { name: 'spotify_play', description: 'Play a song on Spotify.\nSecond line ignored.', params: {} },
        { name: 'list_goals', description: 'List all goals.', params: {} },
        { name: 'kill_session', description: 'Kill a running agent CLI session by PID.', params: {} },
      ];
    }
  };
}

describe('capabilities manifest (P5)', () => {
  let dir, fsStore;

  beforeEach(() => { dir = tempVaultDir(); fsStore = createFsStore(() => dir); fsStore.ensureDir(fsStore.vaultPath('Identity')); });
  afterEach(() => cleanupVaultDir(dir));

  it('generateMarkdown groups tools by leash tier with first-line descriptions', () => {
    const md = capabilities.generateMarkdown(fakeHub(), [{ name: 'pc-child', state: 'ONLINE' }]);
    assert.match(md, /# MYTHOS Capabilities/);
    assert.match(md, /3 tools/);
    assert.match(md, /## Adapters\n- pc-child: ONLINE/);
    assert.match(md, /Tier 0 — read-only[\s\S]*list_goals/);
    assert.match(md, /Tier 3[\s\S]*spotify_play — Play a song on Spotify\./);
    assert.match(md, /Tier 4[\s\S]*kill_session/);
    assert.doesNotMatch(md, /Second line ignored/);
  });

  it('writeManifest persists to Identity/capabilities.md', () => {
    capabilities.writeManifest(fsStore, fakeHub(), []);
    assert.match(fsStore.readText('Identity/capabilities.md', ''), /spotify_play/);
  });

  it('self_capabilities returns the manifest and filters by topic', () => {
    capabilities.writeManifest(fsStore, fakeHub(), []);
    const tools = buildTools({ fs: fsStore });
    const cap = tools.find((t) => t.name === 'self_capabilities');
    assert.ok(cap);
    const full = cap.fn({});
    assert.equal(full.ok, true);
    assert.match(full.result.manifest, /spotify_play/);
    const filtered = cap.fn({ topic: 'spotify' });
    assert.equal(filtered.ok, true);
    assert.equal(filtered.result.matches >= 1, true);
    assert.match(filtered.result.lines.join('\n'), /spotify_play/);
  });

  it('self_capabilities fails honestly before the manifest exists', () => {
    const tools = buildTools({ fs: fsStore });
    const cap = tools.find((t) => t.name === 'self_capabilities');
    assert.equal(cap.fn({}).ok, false);
  });
});
