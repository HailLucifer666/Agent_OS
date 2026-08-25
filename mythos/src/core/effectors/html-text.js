'use strict';

// html-text.js — the one HTML-to-text stripper.
//
// WHY THIS FILE EXISTS. web-fetch.js's stripHtml and web-search.js's stripTags
// were near-duplicates that disagreed about entities: both handled &nbsp;/&amp;/
// &lt;/&gt;/&#39;/&quot;, and only the search copy decoded numeric (&#8212;) and
// hex (&#x2014;) references, &apos;, &mdash;/&ndash;, or replaced an unrecognised
// entity with a space. So the same page yielded different text depending on which
// effector read it, and the fetched-page path — the one whose output is handed to
// the brain as research — was the weaker of the two.
//
// Consolidated onto the stronger implementation rather than a new one. This is a
// text-extraction helper for model input, not an HTML sanitiser: it produces
// plain text to read, never markup to render, so it must not be reused as an
// escaping or sanitising primitive.

function stripTags(s) {
  if (!s) return '';
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&\w+;/g, ' ')  // any remaining unknown entity becomes a space
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { stripTags: stripTags };
