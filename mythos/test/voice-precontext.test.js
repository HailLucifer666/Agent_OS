'use strict';

// Part B (pre-context brain upgrade) tests.
// Part 1 (B1): honest tool descriptions, sandbox-boundary denial messages,
// capability digest, KNOWN_DESKTOP_APPS drift guard.
// Part 2 (B2, appended after B1 lands): RULES additions + digest wiring
// through createVoiceAgent/buildPrompt/buildSystemContext.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fromPc = require('../src/core/effectors/from-pc');
const fromComputer = require('../src/core/effectors/from-computer');
const capabilities = require('../src/core/identity/capabilities');

describe('B1: honest tool descriptions (no pid fabrication)', () => {
  const uiType = fromPc.TOOLS.find((t) => t.name === 'ui_type');
  const uiClick = fromPc.TOOLS.find((t) => t.name === 'ui_click');

  it('ui_type exists and no longer tells the model to pass a preceding-launch pid', () => {
    assert.ok(uiType, 'ui_type tool exists');
    assert.equal(/pass the pid returned by the preceding/i.test(uiType.description), false);
  });

  it('ui_type description tells the model to omit pid and never invent one', () => {
    assert.match(uiType.description, /OMIT/);
    assert.match(uiType.description, /NEVER invent/);
  });

  it('ui_click exists and no longer tells the model to pass a preceding-launch pid', () => {
    assert.ok(uiClick, 'ui_click tool exists');
    assert.equal(/pass the pid returned by the preceding/i.test(uiClick.description), false);
  });

  it('ui_click description tells the model to omit pid and never invent one', () => {
    assert.match(uiClick.description, /OMIT/);
    assert.match(uiClick.description, /NEVER invent/);
  });
});

describe('B1: honest sandbox-boundary denial messages', () => {
  it('write_file outside allowed roots names an allowed root in the failure message', () => {
    const result = fromComputer.write_file({ path: 'C:\\Windows\\System32\\denied-by-test.txt', content: 'x' });
    assert.equal(result.ok, false);
    const roots = fromComputer.allowedRoots();
    assert.ok(roots.length > 0, 'allowedRoots() returns at least one root');
    assert.ok(roots.some((r) => result.result.includes(r)), `denial message should name an allowed root: ${result.result}`);
  });

  it('create_folder outside allowed roots names an allowed root in the failure message', () => {
    const result = fromComputer.create_folder({ path: 'C:\\Windows\\System32\\denied-by-test-folder' });
    assert.equal(result.ok, false);
    const roots = fromComputer.allowedRoots();
    assert.ok(roots.some((r) => result.result.includes(r)), `denial message should name an allowed root: ${result.result}`);
  });
});

describe('B1: capability digest (summaryDigest)', () => {
  it('names roots/apps/adapters/providers when given all four, staying <= 5 lines', () => {
    const digest = capabilities.summaryDigest({
      apps: ['slack', 'discord', 'teams'],
      roots: ['C:\\Users\\test\\Documents'],
      adapters: { 'pc-child': true, browser: false },
      providerCount: 3,
    });
    assert.ok(digest.includes('slack'));
    assert.ok(digest.includes('discord'));
    assert.ok(digest.includes('teams'));
    assert.ok(digest.includes('C:\\Users\\test\\Documents'));
    assert.ok(digest.includes('pc-child ONLINE'));
    assert.ok(digest.includes('browser OFFLINE'));
    assert.ok(digest.includes('3'));
    const lines = digest.split('\n');
    assert.ok(lines.length <= 5, `digest should be <= 5 lines, got ${lines.length}`);
  });
});

describe('B1: KNOWN_DESKTOP_APPS drift guard', () => {
  it('every KNOWN_DESKTOP_APPS name appears in ps-automation.ps1 $script:KnownApps block', () => {
    const psPath = path.resolve(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
    const psText = fs.readFileSync(psPath, 'utf8');
    const startIdx = psText.indexOf('$script:KnownApps');
    const endIdx = psText.indexOf('function Handle-LaunchApp', startIdx);
    assert.ok(startIdx !== -1 && endIdx !== -1, '$script:KnownApps block located in ps-automation.ps1');
    const block = psText.slice(startIdx, endIdx);
    fromPc.KNOWN_DESKTOP_APPS.forEach((name) => {
      assert.ok(block.toLowerCase().includes(`'${name}'`), `${name} present in $script:KnownApps block`);
    });
  });
});
