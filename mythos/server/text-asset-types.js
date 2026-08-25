'use strict';

// server/text-asset-types.js — the Content-Type table for the gzip text-asset
// handler in server/index.js, and the extension regex that decides what that
// handler will look at. Extracted here rather than inlined for the same reason
// server/sanitize-error.js and server/rate-limit.js are: index.js is on the
// file-size ratchet's oversized list, and the ratchet's baseline is a ceiling to
// move code out from under, never a number to raise.
//
// WHY A LITERAL TABLE, and not express.static.mime.lookup(). That property is
// serve-static 1.x's bundled mime@1. serve-static 2.x — what Express 5 ships —
// does not re-export it, so `express.static.mime.lookup(abs)` reads .lookup off
// `undefined` and THROWS, on every gzip-eligible request: every .js and .css
// the HUD loads. Measured 2026-08-25: `!!require('express').static.mime` is
// true on express 4.22.2 and false on 5.2.1.
//
// The values are what express.static ITSELF answers on 5.2.1 for these
// extensions, so a file served through the gzip path and the same file served
// through the express.static fallback cannot disagree about its type. They
// previously did — the old mime@1 lookup returned 'application/javascript' with
// no charset while the static mount sent one.
const TEXT_ASSET_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// DERIVED from the table above, deliberately, instead of written out a second
// time. An extension admitted by the regex but absent from the table would be
// served as application/octet-stream, and a browser silently refuses to apply a
// stylesheet or evaluate a module sent under that type — a failure with no error
// anywhere. Deriving it makes the two impossible to disagree. Safe because file
// extensions are alphanumeric; a key carrying a regex metacharacter would need
// escaping first.
const TEXT_ASSET_RE = new RegExp(
  '\\.(' + Object.keys(TEXT_ASSET_TYPES).map((ext) => ext.slice(1)).join('|') + ')$', 'i');

module.exports = { TEXT_ASSET_TYPES, TEXT_ASSET_RE };
