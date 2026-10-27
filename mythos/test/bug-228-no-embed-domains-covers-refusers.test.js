'use strict';

// BUG-228's own closing note, closed 2026-08-28:
//
//   "Noted, NOT fixed: NO_EMBED_DOMAINS lacks openai.com and youtube.com, so
//    even a correctly-formed `url` would have tried to iframe a site that
//    refuses framing. Separate, quieter failure."
//
// QUIETER IS THE POINT. `open_web` returns ok, the HUD renders a `web` card, and
// the operator sees a blank rectangle. Nothing fails, so nothing is reported —
// the same shape as a fabricated success, one layer down, in a session whose
// whole subject was fabricated success. Falling through to `newtab` is the honest
// outcome and that branch already existed for eight other domains.
//
// `youtu.be` is asserted even though BUG-228 named only youtube.com, because the
// membership test is `host === d || host.endsWith('.' + d)`: youtu.be is a
// separate registrable domain and would have walked past a youtube.com entry.
//
// The dedicated `youtube` TYPE is a different branch entirely (`t === 'youtube'`,
// resolving a video id and building a real /embed/ URL), so this list only ever
// sees `type:'web'`. The test below asserts that separation holds rather than
// assuming it.
//
// Source-shape, and stated as such: the list is a `var` inside the `open_web`
// closure in from-dashboard.js with no export and no seam, and reaching it
// behaviourally means driving the whole effector with an inert ctx — which
// BUG-352 measured as throwing on this very module. The list's CONTENT is what
// rots; the loop around it does not.
//
// Run: cd mythos && node --test test/bug-228-no-embed-domains-covers-refusers.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');

// The literal array, extracted once so every assertion reads the same text.
function embedDenyList() {
  const at = SRC.indexOf('var NO_EMBED_DOMAINS');
  assert.notEqual(at, -1, 'NO_EMBED_DOMAINS must still exist — it is the whole mechanism');
  const open = SRC.indexOf('[', at);
  const close = SRC.indexOf(']', open);
  assert.ok(open !== -1 && close > open, 'the list must still be an array literal');
  // Strip line comments BEFORE splitting. from-dashboard.js sits exactly on its
  // size ratchet (1418 lines, a one-directional ceiling), so the rationale for
  // this change could not be added above the array — it lives as two trailing
  // `//` markers on the literal's own lines instead. A parser that split on `,`
  // first would read that prose as domain entries.
  return SRC.slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('BUG-228 — sites that refuse framing must fall through to a new tab', () => {
  it('the domains BUG-228 named are present', () => {
    const list = embedDenyList();
    for (const d of ['youtube.com', 'openai.com']) {
      assert.ok(list.includes(d), `${d} refuses framing; embedding it yields a blank card`);
    }
  });

  it('youtu.be is covered too, because the suffix test cannot reach it', () => {
    // host.endsWith('.youtube.com') never matches youtu.be — a separate
    // registrable domain. Covering one and not the other is a half-covered list.
    assert.ok(embedDenyList().includes('youtu.be'),
      'youtu.be is a distinct domain and needs its own entry');
  });

  it('the eight original entries are still there', () => {
    // The fix is additive. A rewrite that drops the originals would pass the two
    // assertions above while reintroducing eight blank cards.
    const list = embedDenyList();
    for (const d of ['google.com', 'facebook.com', 'twitter.com', 'x.com',
      'instagram.com', 'github.com', 'linkedin.com', 'reddit.com']) {
      assert.ok(list.includes(d), `${d} must not be lost — the change is additive`);
    }
  });

  it('a match still returns a newtab card, never an embed', () => {
    // The list is only worth anything if the branch it guards still routes to
    // newtab. Assert the shape immediately after the membership test.
    const at = SRC.indexOf('var NO_EMBED_DOMAINS');
    const window = SRC.slice(at, at + 700);
    assert.match(window, /host === NO_EMBED_DOMAINS\[d\] \|\| host\.endsWith\('\.' \+ NO_EMBED_DOMAINS\[d\]\)/,
      'both the exact-host and the subdomain test must survive');
    // UPDATED 2026-10-06 (BUG-468 gate B): the branch now calls openNewtab(), the shared
    // hand-off that builds the newtab descriptor (and reaches the external opener under
    // Electron), instead of spelling the descriptor inline. Same invariant, new spelling.
    assert.match(window, /openNewtab\(/,
      'a listed domain must route to newtab');
    const embedAt = window.indexOf("widgetType: 'web'");
    const newtabAt = window.indexOf("openNewtab(");
    assert.ok(newtabAt !== -1 && (embedAt === -1 || newtabAt < embedAt),
      'the newtab return must come before the embed fallthrough, or the list is bypassed');
  });

  it('the dedicated youtube TYPE is a separate branch and is untouched', () => {
    // Adding youtube.com to a deny list must not break watching a video. That
    // path resolves a video id and builds a real embed, and it runs earlier.
    assert.match(SRC, /if \(t === 'youtube'\)/, 'the youtube type branch must still exist');
    assert.match(SRC, /youtubeVideoId\(/, 'it must still resolve a video id for a real /embed/ URL');
    const ytAt = SRC.indexOf("if (t === 'youtube')");
    const listAt = SRC.indexOf('var NO_EMBED_DOMAINS');
    assert.ok(ytAt !== -1 && ytAt < listAt,
      'the youtube type must be handled BEFORE the web deny list, or videos stop embedding');
  });
});
