'use strict';

// electron/release-notes.js — turns electron-updater's UpdateInfo.releaseNotes
// into plain text for the native install-consent dialog.
//
// Extracted from electron/main.js (same reason as child-exit.js: main.js
// requires `electron` and cannot be required from node --test, so any real
// logic living there can only be checked by source-shape regex, not by
// calling it with real inputs).
//
// VERIFIED SHAPE (builder-util-runtime out/updateInfo.d.ts):
//   releaseNotes?: string | Array<ReleaseNoteInfo> | null
//   ReleaseNoteInfo = { readonly version: string; readonly note: string | null }
// GitHubProvider prefers a plain string sourced from latest.yml, but falls
// back to an Atom-feed array of {version, note} when latest.yml carries no
// notes — which, as of this task, is every release this project has actually
// published. The array branch is therefore not defensive fiction; it is the
// shape production hits today.
//
// NOTE: this produces PLAIN TEXT for a native OS dialog (dialog.showMessageBox)
// only. It is NOT safe to insert into HTML/DOM — entities are decoded, not
// re-escaped, so passing this string into innerHTML or similar would reopen an
// injection hole. That is deliberately why an HUD banner variant of this is
// still deferred: it would need the opposite treatment (escape, don't decode).

const HTML_ENTITIES = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
];

const MAX_LENGTH = 500;

// Accepts UpdateInfo.releaseNotes (string | Array<ReleaseNoteInfo> | null |
// undefined) and returns a plain-text summary, capped at 500 characters.
// Never throws — any unusable input becomes ''.
function sanitizeReleaseNotes(raw) {
  try {
    let text = raw;

    // Normalize the ARRAY shape first: join each entry's `note` field. This is
    // the branch GitHubProvider actually returns today (see file header).
    if (Array.isArray(text)) {
      text = text
        .map((entry) => (entry && typeof entry.note === 'string' ? entry.note : ''))
        .filter(Boolean)
        .join(' ');
    }

    if (typeof text !== 'string' || text.length === 0) return '';

    // Strip HTML tags (release notes commonly arrive as an HTML fragment from
    // GitHub's release body). Done both BEFORE and AFTER entity decoding: an
    // entity-encoded tag (e.g. "&lt;script&gt;") has no literal angle bracket
    // at this first pass, so it survives untouched — decoding below would then
    // reconstruct a literal tag in what is supposed to be tag-free output. The
    // second pass catches exactly that reconstruction.
    text = text.replace(/<[^>]*>/g, ' ');

    // Decode the 5 standard HTML entities.
    for (const [pattern, replacement] of HTML_ENTITIES) {
      text = text.replace(pattern, replacement);
    }

    text = text.replace(/<[^>]*>/g, ' ');

    // Collapse whitespace (newlines, tabs, repeated spaces) into single spaces.
    text = text.replace(/\s+/g, ' ').trim();

    if (text.length > MAX_LENGTH) {
      text = text.slice(0, MAX_LENGTH);
      // .slice() cuts by UTF-16 code unit, so a cap landing between a surrogate
      // pair leaves a lone high surrogate — an invalid character rendered as a
      // replacement glyph in the native dialog. Drop it. Same fix as
      // scripts/build-release-notes.js's capLength(); this is the runtime half
      // of that truncation, and it was missed when the build half was fixed.
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    }

    return text;
  } catch {
    // Never let a malformed releaseNotes payload take down the update flow.
    return '';
  }
}

module.exports = { sanitizeReleaseNotes };
