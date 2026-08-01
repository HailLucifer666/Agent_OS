'use strict';

// BUG-078 — Stage 6 of 7, item #16 of the plan.
//
// Plan evidence: from-spotify.js's spotify_volume routed to the system's
// master volume (Core Audio set_volume / VK_VOLUME_*) while being reachable
// as a Spotify-specific tool — the operator asked 20x for the level to
// change and, getting no per-app effect, kept escalating.
//
// The operator's ruling for this stage was explicit: do NOT build
// ISimpleAudioVolume/per-app Core Audio interop for one incident. Ship the
// honest version instead — the tool's OWN description must say "system
// volume", not imply Spotify-only control, so the model stops reaching for
// it expecting per-track/per-app behavior it cannot deliver.
//
// Cross-checked against git history: commit c5abcde (2026-07-29, predating
// this whole plan) already rewrote the description to say exactly this.
// This test exists so that fact is asserted, not assumed — if a future
// change silently reverts the description to imply per-app control, this
// must fail red.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../src/core/effectors/from-spotify');

describe('BUG-078 — spotify_volume is honest about controlling SYSTEM volume', () => {
  const tool = TOOLS.find((t) => t.name === 'spotify_volume');

  it('the tool exists', () => {
    assert.ok(tool, 'spotify_volume must still be registered');
  });

  it('its description says system volume, not per-app/Spotify-only control', () => {
    assert.match(tool.description, /system volume/i,
      'the description must call this what it is: system volume');
    assert.doesNotMatch(tool.description, /only (affects|controls) spotify/i,
      'must not claim a per-app scope it cannot deliver');
  });

  // ponytail: per-app Core Audio (ISimpleAudioVolume) volume control for
  // Spotify specifically is the real upgrade path if this bites live again —
  // deliberately not built here, named so a future session doesn't rebuild
  // it from scratch. See the operator's ruling in the Stage 6 task.
});
