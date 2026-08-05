'use strict';

// BUG-078 — Stage 6 of 7, item #16 of the plan.
//
// Plan evidence: from-spotify.js's spotify_volume routed to the system's
// master volume (Core Audio set_volume / VK_VOLUME_*) while being reachable
// as a Spotify-specific tool — the operator asked 20x for the level to
// change and, getting no per-app effect, kept escalating.
//
// The operator's ruling for that stage was: do NOT build ISimpleAudioVolume
// interop for one incident — ship the honest description instead. That held
// until 2026-08-06, when "lower Spotify" turned the whole machine down
// (MYTHOS's own voice with it) and the operator scoped the real fix as
// BUG-127. Per-app Core Audio now exists (pc-child's set_app_volume), so the
// honesty requirement INVERTED: `level` must no longer claim, or be, system
// volume — while `direction` still is, because the media-key VKs have no
// per-app equivalent.
//
// What this file pins now: the description tells the truth about BOTH paths,
// and neither one is silently the other.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../src/core/effectors/from-spotify');

describe('BUG-078/BUG-127 — spotify_volume is honest about what each path changes', () => {
  const tool = TOOLS.find((t) => t.name === 'spotify_volume');

  it('the tool exists', () => {
    assert.ok(tool, 'spotify_volume must still be registered');
  });

  it('the level path is described as Spotify-only, and says so explicitly', () => {
    assert.match(tool.description, /only Spotify/i,
      'the level path now really is per-app — the description must say so');
    assert.match(tool.description, /not the system volume/i,
      'and must say what it is NOT, since that was the original bug');
  });

  it('the direction path is still described as moving the SYSTEM volume', () => {
    // Not an oversight and not a regression: volume_up/down/mute are hardware
    // media keys with no per-app equivalent. Claiming otherwise would be the
    // same dishonesty in the opposite direction.
    assert.match(tool.description, /system volume/i);
    assert.match(tool.params.direction, /SYSTEM volume/i,
      'the param doc must carry the caveat too — the model reads params, not just prose');
  });
});
