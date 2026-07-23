'use strict';

// REMEDIATION P1-6: app.js's _brainOnline tracker reads msg.payload.status
// correctly (that part of the original FIX I landed fine), but compared it
// against 'offline'/'error' — values the server never actually emits. The
// server's real entityStatus vocabulary is booting|alive|stopped (see
// server/index.js and core-orb.js's resolveState(), which maps
// 'stopped'->'offline' and anything else non-'alive'->'booting'). Since the
// comparison never matched a real value, _brainOnline stayed true forever —
// failing open exactly the way this fix was supposed to prevent.
//
// isEntityAlive() lives in its own dependency-free module (ui/public/js/
// entity-status.js) specifically so it can be unit tested here without a
// DOM/browser harness (this repo has none — BUG-002/BUG-005) — the rest of
// app.js mounts UI at module scope and cannot be imported outside a browser.
// Uses the same pathToFileURL + dynamic import() pattern already established
// by test/hud-model.test.js for loading real ui/public/js ES modules in Node.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function uiUrl(rel) {
  return pathToFileURL(path.join(__dirname, '..', 'ui', 'public', 'js', rel)).href;
}

test('isEntityAlive: the real server vocabulary (booting/alive/stopped) is classified correctly', async () => {
  const { isEntityAlive } = await import(uiUrl('entity-status.js'));

  assert.equal(isEntityAlive('alive'), true, 'alive must be online');
  assert.equal(isEntityAlive('stopped'), false, "stopped is the server's real offline signal and must not be treated as online");
  assert.equal(isEntityAlive('booting'), false, 'booting (not yet alive) must not be treated as online');
  assert.equal(isEntityAlive(''), false, 'an empty/unknown status must fail closed, not open');
});
