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
//
// INVERTED AGAIN by BUG-161 (2026-08-07): the "direction still moves the
// SYSTEM volume" carve-out this file used to pin turned out to be the live
// defect — the VK keys reported "sent" while the operator heard no change,
// a fabricated success with no oracle. direction now steps Spotify's OWN
// session (read current -> step -> read back), so the description must say
// per-app for BOTH paths and must NOT claim the system volume moves.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../src/core/effectors/from-spotify');

describe('BUG-078/BUG-127/BUG-161 — spotify_volume is honest about what each path changes', () => {
  const tool = TOOLS.find((t) => t.name === 'spotify_volume');

  it('the tool exists', () => {
    assert.ok(tool, 'spotify_volume must still be registered');
  });

  it('the description says it changes Spotify only — never the system volume', () => {
    assert.match(tool.description, /never the system volume/i,
      'both paths are per-app now; the description must say what the tool does NOT touch');
  });

  it('the direction path is described as per-app stepping, not as system volume (BUG-161)', () => {
    assert.match(tool.params.direction, /Spotify'?s own session/i,
      'the param doc must carry the per-app truth — the model reads params, not just prose');
    assert.ok(!/direction[^.]*system volume/i.test(tool.description),
      'no clause may still claim direction moves the system volume');
  });

  it('both paths are described as failing honestly with no live session', () => {
    assert.match(tool.description, /fail/i);
    assert.match(tool.description, /no live audio session|not playing/i);
  });
});
