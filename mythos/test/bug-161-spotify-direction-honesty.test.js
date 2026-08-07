'use strict';

// BUG-161 — spotify_volume(direction) fabricated success (operator incident
// 2026-08-07 04:23: "volume controls failed to change the audible volume,
// despite the tool reporting successful key sends"). The direction path fired
// global volume VK keys — which move the MASTER volume or, depending on
// focus/OEM key handling, nothing at all — and reported sent:true with no
// read-back oracle. The behavioural rewrite is tested in
// bug-127-per-app-volume.test.js (read current -> step -> read back). THIS
// file pins the pc-child plumbing the rewrite depends on, source-shape style
// (ps-automation.ps1 is PowerShell — not loadable under node:test — so shape
// assertions are the only automated guard available, same rationale as
// test/bug-122-window-close-instrumentation.test.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PS1 = fs.readFileSync(
  path.resolve(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1'), 'utf8');

describe('BUG-161: pc-child per-app volume read/mute plumbing', () => {
  it('the C# helper gained GetVolume and SetMute alongside SetVolume', () => {
    assert.match(PS1, /public static string\[\] GetVolume\(string name, int targetProcessId\)/);
    assert.match(PS1, /public static string\[\] SetMute\(string name, int targetProcessId, bool mute\)/);
    assert.match(PS1, /public static string\[\] SetVolume\(string name, int targetProcessId, float level\)/,
      'the existing setter must survive untouched');
  });

  it('get_app_volume and set_app_mute are dispatched, and both route through the string-is-error guard', () => {
    for (const cmd of ['get_app_volume', 'set_app_mute']) {
      const idx = PS1.indexOf(`'${cmd}' {`);
      assert.ok(idx !== -1, `${cmd} must have a dispatch entry`);
      const block = PS1.slice(idx, idx + 400);
      assert.match(block, /if \(\$result -is \[string\]\) \{ \$err = \$result; \$result = \$null \}/,
        `${cmd}'s bare-string failure must become an error, not ok:true (the Handle-UiClick lesson)`);
    }
  });

  it('the no-session failure never widens: both handlers name what was searched and what was there', () => {
    assert.match(PS1, /No audio session for \$target - there is no per-app volume to read/);
    assert.match(PS1, /its mute state was NOT changed, and nothing else was changed either/);
  });

  it('failure strings in the new handlers are ASCII-only (PS 5.1 reads this file in the ANSI codepage)', () => {
    for (const fn of ['Handle-GetAppVolume', 'Handle-SetAppMute']) {
      const start = PS1.indexOf(`function ${fn}`);
      assert.ok(start !== -1, `${fn} must exist`);
      const body = PS1.slice(start, PS1.indexOf('\nfunction ', start + 10));
      // Strings only — comments are exempt by the rule, so strip comment lines.
      const strings = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').match(/"[^"]*"|'[^']*'/g) || [];
      for (const s of strings) {
        assert.ok(/^[\x00-\x7F]*$/.test(s), `${fn} has a non-ASCII string literal: ${s}`);
      }
    }
  });

  it('the load-bearing ps1 pieces root CLAUDE.md names are still present (BUG-037 protocol)', () => {
    assert.match(PS1, /Await-WinRTOperation/);
    assert.match(PS1, /\$TargetPid/);
    assert.ok(!/param\(\s*\$pid\b/i.test(PS1), 'no handler may take a $pid parameter — it is a read-only automatic variable');
    assert.match(PS1, /'click_at'/);
  });

  it('from-pc.js registers get_app_volume as a needs_result read and set_app_mute as an act tool', () => {
    const { TOOLS } = require('../src/core/effectors/from-pc');
    const getV = TOOLS.find((t) => t.name === 'get_app_volume');
    const setM = TOOLS.find((t) => t.name === 'set_app_mute');
    assert.ok(getV && setM);
    assert.equal(getV.needs_result, true, 'a read the model must see before acting');
  });

  it('tier rows exist: get_app_volume T0 (read), set_app_mute T2 (same class as set_app_volume)', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.get_app_volume, 0);
    assert.equal(TIER_TABLE.set_app_mute, 2);
    assert.equal(TIER_TABLE.set_app_mute, TIER_TABLE.set_app_volume,
      'mute cannot be gated differently from the volume set on the same session');
  });
});
