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
    // spotify_play was re-tiered T3 -> T2 in the confirmation-policy pass —
    // the manifest groups by live tierOf(), so it now falls under Tier 2.
    assert.match(md, /Tier 2[\s\S]*spotify_play — Play a song on Spotify\./);
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

// Wave 7 (2026-08-13) — "when did you first boot" / "how long have you been
// in development" had no honest answer: version.js's bootDate re-stamps
// every process restart. boot-timeline.js persists the FIRST boot exactly
// once, and writeManifest renders it into the same self-knowledge surface
// self_capabilities already reads.
describe('boot-timeline — first-ever-boot persistence (Wave 7)', () => {
  const { ensureFirstBootRecorded, FILE } = require('../src/core/identity/boot-timeline');
  let dir, fsStore;

  beforeEach(() => { dir = tempVaultDir(); fsStore = createFsStore(() => dir); fsStore.ensureDir(fsStore.vaultPath('Identity')); });
  afterEach(() => cleanupVaultDir(dir));

  it('writes Identity/first-boot.json exactly once and returns its timestamp', () => {
    const first = ensureFirstBootRecorded(fsStore, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(first, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(fsStore.readJSON(FILE, null), { firstBootAt: '2026-01-01T00:00:00.000Z' });
  });

  it('a later call with a DIFFERENT "now" still returns the ORIGINAL first-boot time', () => {
    ensureFirstBootRecorded(fsStore, Date.parse('2026-01-01T00:00:00Z'));
    const second = ensureFirstBootRecorded(fsStore, Date.parse('2027-06-15T00:00:00Z'));
    assert.equal(second, '2026-01-01T00:00:00.000Z', 'the recorded first boot must never be overwritten by a later one');
  });

  it('with no fs store at all, still answers honestly for THIS boot only (no throw)', () => {
    const answer = ensureFirstBootRecorded(null, Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(answer, '2026-01-01T00:00:00.000Z');
  });

  it('generateMarkdown renders firstBootAt with a day count when given one', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    const md = capabilities.generateMarkdown(fakeHub(), [], twoDaysAgo);
    assert.match(md, /First boot ever recorded on this install:/);
    assert.match(md, /2 days ago/);
  });

  it('generateMarkdown omits the line entirely when no firstBootAt is passed (unaffected default)', () => {
    const md = capabilities.generateMarkdown(fakeHub(), []);
    assert.doesNotMatch(md, /First boot ever recorded/);
  });

  it('writeManifest seeds first-boot.json AND renders it into capabilities.md in one call', () => {
    capabilities.writeManifest(fsStore, fakeHub(), []);
    const recorded = fsStore.readJSON(FILE, null);
    assert.ok(recorded && recorded.firstBootAt, 'writeManifest must trigger the one-time seed');
    assert.match(fsStore.readText('Identity/capabilities.md', ''), /First boot ever recorded on this install:/);
  });

  it('self_capabilities surfaces the first-boot line through the real tool, filterable by topic', () => {
    capabilities.writeManifest(fsStore, fakeHub(), []);
    const tools = buildTools({ fs: fsStore });
    const cap = tools.find((t) => t.name === 'self_capabilities');
    const filtered = cap.fn({ topic: 'first boot' });
    assert.equal(filtered.ok, true);
    assert.ok(filtered.result.matches >= 1, 'the topic filter must find the first-boot line');
  });

  it('a SECOND writeManifest call (a later boot) keeps the SAME first-boot timestamp', () => {
    capabilities.writeManifest(fsStore, fakeHub(), []);
    const firstRecord = fsStore.readJSON(FILE, null);
    capabilities.writeManifest(fsStore, fakeHub(), []);
    const secondRecord = fsStore.readJSON(FILE, null);
    assert.deepEqual(firstRecord, secondRecord, 'a later boot must not move the recorded first-boot time');
  });
});
