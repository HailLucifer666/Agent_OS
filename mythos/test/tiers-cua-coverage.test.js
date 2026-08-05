'use strict';

// test/tiers-cua-coverage.test.js — BUG-102. `tierOf()` fail-safes an unmapped
// tool to T3 (correct, and it stays), but NONE of the four cua-driver tools had
// a TIER_TABLE entry — so `cua_list_windows`, a pure read, demanded
// confirm-and-execute approval. Logged live on 2026-08-05: MYTHOS answered "I've
// requested the window list now, but I'll need your approval" twice while the
// operator was mid-troubleshooting.
//
// This test pins the intent, not just the fix: every cua_* tool the effector
// registry exposes must carry an EXPLICIT tier, so a newly-added one cannot
// silently inherit T3 again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TIER_TABLE, tierOf } = require('../src/core/leash/tiers');

const EFFECTOR_DIR = path.join(__dirname, '..', 'src', 'core', 'effectors');

function registeredCuaTools() {
  const names = new Set();
  for (const file of fs.readdirSync(EFFECTOR_DIR)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(EFFECTOR_DIR, file), 'utf8');
    for (const m of src.matchAll(/name:\s*'(cua_[a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return [...names].sort();
}

test('read-only cua tools are tier 0, not the T3 fail-safe', () => {
  assert.equal(tierOf('cua_list_windows'), 0, 'listing windows is a pure read');
  assert.equal(tierOf('cua_get_window_state'), 0, 'reading window state is a pure read');
});

test('acting cua tools keep the tier of their pc-child equivalents', () => {
  // cua_bring_to_front mirrors focus_window (1); cua_click mirrors click_at (3,
  // session-grantable) — autonomous clicking stays elevated.
  assert.equal(tierOf('cua_bring_to_front'), TIER_TABLE.focus_window);
  assert.equal(tierOf('cua_click'), TIER_TABLE.click_at);
});

test('every registered cua_* tool has an explicit TIER_TABLE entry', () => {
  const tools = registeredCuaTools();
  assert.ok(tools.length >= 4, `expected to find the cua tools, found ${tools.join(', ')}`);
  const unmapped = tools.filter((n) => TIER_TABLE[n] === undefined);
  assert.deepEqual(unmapped, [], 'unmapped cua tools silently fail-safe to T3 — add them to TIER_TABLE');
});

test('the T3 fail-safe for genuinely unknown tools is unchanged', () => {
  assert.equal(tierOf('cua_not_a_real_tool'), 3);
});
